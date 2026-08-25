// What the CLI's exit code MEANS (R2).
//
// A CI job reads one number and decides whether the pipeline continues. That
// makes this the CLI's most load-bearing contract and the one with the least
// surface area to get right, so it lives on its own, pure, with the mapping as
// a function rather than as four `process.exit` calls scattered through a
// command.
//
// ── Why code 2 exists at all ──────────────────────────────────────────────
// It is the one the plan (docs/plans/test-runner-improvements.md §3.3) singles
// out, and the failure it names already exists here today: a selector that
// matches nothing produces a batch of zero, and `run_batch` only sets `isError`
// when `summary.failed > 0`. So a suite of zero tests is byte-identical in
// shape to a clean pass. Rename a tag from `smoke` to `Smoke` and the pipeline
// goes green while testing nothing, forever, with no signal anywhere.
//
// Folding that into 0 is the silently-empty pipeline. Folding it into 1 is
// worse in a different way — it reads as "your tests fail" and sends someone
// looking at the tests rather than at the selector. It gets its own number.
//
// ── Why "could not start" is not 1 either ─────────────────────────────────
// A missing browser and a failing assertion are the same exit code in most
// runners, and that is why a CI failure so often means reading the log to find
// out which happened. 3 says "nothing ran, this is your setup" without anyone
// having to.

/** The contract. Named rather than inlined so a caller cannot write `2` meaning
 *  something else, and so `check:cli-exit` can assert against the same table
 *  the code uses rather than a transcription of it. */
export const EXIT = {
  /** Every selected test passed. */
  PASSED: 0,
  /** At least one selected test failed. Tests ran; some were red. */
  FAILED: 1,
  /** The selector matched no tests. NOTHING RAN, and that is not a pass. */
  NO_MATCH: 2,
  /** The run could not start: a browser that is not installed, a Playwright
   *  that cannot be found, an argument that is not usable. Nothing ran, and the
   *  cause is the environment or the invocation rather than the tests. */
  CANNOT_START: 3,
};

/** Each refusal `runSelection` can return, and the code it earns.
 *
 *  Exhaustive over the union rather than a `default:` — a new refusal reason
 *  added to `mcp/run-tests.mjs` should make this throw at the call site during
 *  development, not silently inherit somebody else's number. That is the whole
 *  reason the reasons are a discriminated union instead of a formatted string.
 */
const REFUSAL_EXITS = {
  "no-match": EXIT.NO_MATCH,
  "unknown-browser": EXIT.CANNOT_START,
  "no-playwright": EXIT.CANNOT_START,
  "no-browser": EXIT.CANNOT_START,
};

/**
 * The exit code for one `runSelection` outcome.
 *
 * A run that HAPPENED is judged on `summary.failed` alone. Deliberately not on
 * `skipped`: a test skipped for declaring secret variables is a run this
 * process could not do rather than a test that failed, and failing the pipeline
 * for it would make one secret-bearing test enough to redden every suite it
 * sits in. The command says so in words instead — see `cli/run.mjs`.
 *
 * @param {object} outcome
 * @returns {number}
 */
export function exitCodeFor(outcome) {
  if (!outcome || outcome.ok !== true) {
    const code = REFUSAL_EXITS[outcome?.reason];
    // An unknown refusal is still a refusal: nothing ran. Falling through to 0
    // here is the one mistake this file exists to make impossible.
    return code ?? EXIT.CANNOT_START;
  }
  // A DRY RUN that got this far matched something, and nothing ran, so it can
  // only be 0 — it is never 1, because no test had the chance to fail. Stated
  // rather than left to fall through `summary?.failed > 0` on an object with no
  // summary: that reaches the right answer by accident today and would reach a
  // wrong one the day the shape changes.
  //
  // An empty selection never gets here at all; `runSelection` refuses with
  // `no-match` before it plans, so `--dry-run --tag gone` is exit 2. That is the
  // whole reason the flag exists — a dry run that matches nothing has found the
  // bug it was run to look for, and must not report success.
  if (outcome.dryRun) return EXIT.PASSED;
  return outcome.summary?.failed > 0 ? EXIT.FAILED : EXIT.PASSED;
}

/** One line per code, for `--help` and for the error path. Kept beside the
 *  numbers so the documented contract and the implemented one are the same
 *  object — a table in a README is the shape that goes stale. */
export const EXIT_MEANINGS = [
  [EXIT.PASSED, "every selected test passed"],
  [EXIT.FAILED, "at least one test failed"],
  [EXIT.NO_MATCH, "the selector matched no tests — nothing ran"],
  [EXIT.CANNOT_START, "the run could not start (bad argument, missing browser)"],
];
