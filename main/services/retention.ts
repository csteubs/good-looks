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

/** Sweep every test's artifacts against the current retention settings.
 *  Best-effort: never throws into a caller's lifecycle or run teardown. */
export function applyRetention(): RetentionResult {
  try {
    const settings = recorderSettingsStore.get();
    const keep = settings.artifactRetainedRuns ?? DEFAULT_RETAINED_RUNS;
    const days = settings.artifactRetentionDays ?? 0;
    return artifactStore.pruneAllTests(keep, days > 0 ? days * DAY_MS : 0);
  } catch {
    return { removedRuns: 0, freedBytes: 0 };
  }
}
