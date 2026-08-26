// WHERE ONE ATTEMPT'S EVIDENCE GOES (R24a).
//
// ── The bug this exists to prevent ─────────────────────────────────────────
// Playwright can run a test more than once in a single invocation: `retries`
// makes each failure re-enter every fixture. The capture fixture is a `page`
// fixture, so attempt 2 re-runs it, resets its step counter to 0, and writes
// `0.png`, `manifest.json`, `console.json` and `network.json` back over attempt
// 1's. The attempt that FAILED is overwritten by the attempt that passed —
// which is the only attempt anybody wants to look at.
//
// Nothing is recoverable afterwards. The scratch directory is deleted at run
// end, so this cannot be fixed later by reading something else: an attempt's
// evidence is written once or never.
//
// ── The rule ──────────────────────────────────────────────────────────────
// Attempt 0 keeps the run directory it has always used. Every later attempt
// gets `attempt-<n>/` beneath it.
//
// That asymmetry is deliberate, and it is not just backwards compatibility.
// A retry only happens after a failure, so attempt 0 is the attempt that
// failed — the diagnostic one — and it is the one every existing reader
// (`readManifest`, `readShot`, the replay, the visual diff, `openTrace`)
// already points at. Numbering it `attempt-0/` would move the interesting
// evidence and leave the passing attempt where the app looks.
//
// ── Pure ──────────────────────────────────────────────────────────────────
// Three processes need this spelling and none of them can share a module with
// the others. The app resolves attempt directories from compiled TypeScript;
// the capture fixture resolves them inside a Playwright worker, from a string
// written to disk at run time; and the CLI's runner reads them from plain
// `.mjs`. `attemptDirSource` is this file's own `attemptDirName`, stringified,
// for the one caller that cannot import it.

import * as path from "node:path";

/** Prefix for a retried attempt's directory. Attempt 0 has no directory of its
 *  own — see the header. */
export const ATTEMPT_DIR_PREFIX = "attempt-";

/**
 * Coerce anything to an attempt number.
 *
 * Untrusted, like every other number that reaches this layer from a run: the
 * value arrives on stdout beside Playwright's own output, which quotes
 * page-controlled text. A negative or fractional attempt would build a
 * directory name nothing can read back, so anything that is not a
 * non-negative integer is 0 — the attempt that always exists.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeAttempt(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

/**
 * The path segment for one attempt, relative to the run directory.
 *
 * Empty for attempt 0, so `path.join(runDir, attemptDirName(0))` is `runDir`
 * itself and a caller needs no branch.
 *
 * @param {number} attempt
 * @returns {string}
 */
export function attemptDirName(attempt) {
  return attempt > 0 ? ATTEMPT_DIR_PREFIX + attempt : "";
}

/**
 * The attempt a directory name denotes, or null when it is not one.
 *
 * Strict: this is asked of every entry in a run directory, which also holds
 * `0.png`, `manifest.json` and the log files, and a loose match would report
 * those as attempts.
 *
 * @param {string} name
 * @returns {number | null}
 */
export function parseAttemptDirName(name) {
  if (typeof name !== "string" || !name.startsWith(ATTEMPT_DIR_PREFIX)) return null;
  const rest = name.slice(ATTEMPT_DIR_PREFIX.length);
  // `+1`, `1.0`, `01` and `` all parse as numbers somewhere; only the exact
  // spelling this module writes is an attempt directory.
  if (!/^[1-9][0-9]*$/.test(rest)) return null;
  return Number(rest);
}

/**
 * The full directory for one attempt's artifacts.
 *
 * @param {string} runDir
 * @param {number} attempt
 * @returns {string}
 */
export function attemptArtifactDir(runDir, attempt) {
  return path.join(runDir, attemptDirName(normalizeAttempt(attempt)));
}

/**
 * The attempt a Playwright scratch directory belongs to.
 *
 * Playwright appends the suffix to the test's own output directory:
 * `testOutputDir += "-retry" + this.retry` (playwright/lib/worker/
 * workerProcessEntry.js, 1.62). The first attempt has no suffix.
 *
 * Spelled out rather than assumed because the repo's own note about this
 * layout said `<test-slug>/retryN/` — a nested directory Playwright does not
 * produce. An unrecognised name answers 0, which files the trace where the app
 * has always looked for it; the salvage never overwrites a trace it has
 * already copied, so a wrong guess loses nothing that was there first.
 *
 * @param {string} name a single directory name, not a path
 * @returns {number}
 */
export function attemptFromPlaywrightOutputDir(name) {
  if (typeof name !== "string") return 0;
  const m = /-retry([1-9][0-9]*)$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * This module's own functions as source, for the capture fixture.
 *
 * The fixture is a string written next to the specs and loaded by Playwright's
 * own transform; it cannot import this file, and a hand-copied branch there is
 * the drift this module exists to stop — the fixture WRITES the directories
 * and the app READS them, so a disagreement is silent and total.
 *
 * Interpolated rather than shipped as a fourth fixture file on purpose: a
 * written file is a dependency `check:ci-fixtures` has to be taught about, and
 * this is a handful of lines with no state.
 *
 * `normalizeAttempt` comes along because the fixture reads `testInfo.retry`,
 * which is the source every other reading of an attempt derives from. A
 * separate guard there would be the second spelling of "what counts as an
 * attempt", and the first thing to disagree.
 */
export const ATTEMPT_HELPERS = `const ATTEMPT_DIR_PREFIX = ${JSON.stringify(ATTEMPT_DIR_PREFIX)};
${normalizeAttempt.toString()}
${attemptDirName.toString()}`;
