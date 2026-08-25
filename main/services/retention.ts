// Applying the artifact-retention settings, from the one place that knows both
// the settings and the store.
//
// Retention used to run ONLY inside a capture run, scoped to the test being
// run. That made the age rule a no-op for any test you stopped running, and
// made a lowered run limit apply only on each test's next capture. This module
// sweeps every test, and is called at startup, after any run, and on demand
// from Settings.

import { artifactStore } from "./artifact-store.js";
import { recorderSettingsStore } from "./recorder-settings-store.js";
import { DEFAULT_RETAINED_RUNS } from "./artifact-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  removedRuns: number;
  freedBytes: number;
}

/** The settings as the store's two prune calls want them. */
function rules(): { keep: number; maxAgeMs: number } {
  const settings = recorderSettingsStore.get();
  const days = settings.artifactRetentionDays ?? 0;
  return {
    keep: settings.artifactRetainedRuns ?? DEFAULT_RETAINED_RUNS,
    maxAgeMs: days > 0 ? days * DAY_MS : 0,
  };
}

/** Sweep every test's artifacts against the current retention settings.
 *  Best-effort: never throws into a caller's lifecycle or run teardown.
 *
 *  EXPENSIVE, and the reason the run path no longer calls it: `pruneAllTests`
 *  brackets itself with two `usage()` walks so it can report what it freed, and
 *  `usage()` recurses the whole artifacts tree with a synchronous `statSync`
 *  per file. At a hundred tests times ten retained runs times twenty
 *  screenshots that is forty thousand blocking stats — on the main process,
 *  which is the thread streaming `runner:output` to the window at the same
 *  time, once for every run in a batch (R17). Callers that WANT the number
 *  (startup, the Settings button) still use this. */
export function applyRetention(): RetentionResult {
  try {
    const { keep, maxAgeMs } = rules();
    lastSweepAt = Date.now();
    return artifactStore.pruneAllTests(keep, maxAgeMs);
  } catch {
    return { removedRuns: 0, freedBytes: 0 };
  }
}

/** Apply the same rules to ONE test — what the run path needs.
 *
 *  This is the cheap half: it lists and prunes a single test's run directories
 *  and measures nothing, so its cost is proportional to the test that just ran
 *  rather than to the library. It is also the only part of retention a run can
 *  actually make newer work for, since a run adds artifacts to exactly one
 *  test. */
export function applyRetentionForTest(testId: string): void {
  try {
    const { keep, maxAgeMs } = rules();
    artifactStore.pruneRuns(testId, keep, maxAgeMs);
  } catch {
    /* never throws into run teardown */
  }
}

/** How long the library-wide sweep waits before it is worth doing again. */
export const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

let lastSweepAt = 0;

/** The library-wide sweep, THROTTLED — the "idle trigger" half of R17.
 *
 *  The other tests' artifacts do still have to age out while the app is left
 *  open, so the sweep cannot simply move to startup and stop there. What it can
 *  do is stop happening once per run: a hundred-test batch now sweeps once
 *  instead of a hundred times, and a user running a test every few minutes
 *  pays for it about twice an hour. Returns null when it was not due, which is
 *  what the caller logs.
 *
 *  Deliberately time-based rather than run-counted: what makes a sweep worth
 *  doing is elapsed time (the age rule) and accumulated runs, and a count would
 *  fire hardest exactly when the machine is busiest. */
export function sweepRetentionIfDue(now: number = Date.now()): RetentionResult | null {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return null;
  lastSweepAt = now;
  try {
    const { keep, maxAgeMs } = rules();
    return artifactStore.pruneAllTests(keep, maxAgeMs);
  } catch {
    return { removedRuns: 0, freedBytes: 0 };
  }
}

/** Test seam: forget when the last sweep happened. */
export function resetSweepClock(): void {
  lastSweepAt = 0;
}
