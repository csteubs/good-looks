// WHAT A RETRY MEANS (R24) — for the record, and for the maths.
//
// ── The decision this encodes ──────────────────────────────────────────────
// `docs/ROUTINES.md` refused a retry policy outright: "Auto-Heal already
// retries at the locator level, and a routine-level retry stacked on top makes
// a flaky test look stable — which is precisely the signal the Stability panel
// exists to give." It named its own condition for revisiting: "If retry is
// added later it must mark the resulting `RunRecord` so flake analysis can
// exclude or count it deliberately."
//
// This module is that marking, and the counting rule that goes with it. The
// marking alone is not enough — a field nothing reads leaves the verdict
// exactly as wrong as no field at all.
//
// ── The rule ──────────────────────────────────────────────────────────────
// A run that failed and then passed on a retry is:
//
//   • PASSED as an outcome. The suite is green; the pass rate says so; a
//     person asking "did my tests pass" gets yes.
//   • FAILED as a signal. It went red once, on this machine, for this commit.
//     The transition series counts it as a state change, and the verdict
//     cannot call it stable.
//
// Those two are not in tension, they are different questions, and collapsing
// them either way is the failure mode. Count it passed everywhere and the
// retry buys a green board over a test nobody will ever fix. Count it failed
// everywhere and a suite that recovers reports as broken.
//
// This is the precedent Auto-Heal already set: `healedSteps` produces "passed,
// conditionally", and `run-summary.ts` shows the heal rather than the bare
// pass. A retry is the same shape one level up.
//
// ── Pure ──────────────────────────────────────────────────────────────────
// Four callers across three processes: the app's runner and the unattended
// runner both WRITE the fields, and `flake-analysis.mjs` and
// `period-digest.mjs` both READ them — the second pair through the MCP as well
// as the app. A second spelling of "does this run count as a failure" is a
// board that disagrees with a digest about the same week.

/** The most retries any caller may ask for.
 *
 *  A cap rather than an open number because each retry is a full re-run of a
 *  test that has already failed: `--retries 50` on a suite that is genuinely
 *  broken is an hour of runner time to reach the answer the first attempt
 *  gave. Three is past the point where a real intermittent has shown itself. */
export const MAX_RETRIES = 3;

/**
 * Coerce a requested retry count, or null when it is not usable.
 *
 * Null rather than 0, so a caller can tell "not asked for" from "asked for,
 * badly" and refuse the second by name. `--retries eight` is someone expecting
 * something; running with none and saying nothing is the wrong answer.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function normalizeRetries(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  if (value > MAX_RETRIES) return null;
  return value;
}

/**
 * The retry fields this run should record — SPREAD into the record.
 *
 * `maxAttempt` is the highest attempt that reported a step; 0 on a run that
 * was never retried. It is derived from the step markers rather than from
 * Playwright's summary line, because the markers are already parsed and a
 * summary line is prose.
 *
 * EMPTY when there was no retry, which is why this returns fields rather than
 * values. Writing `attempt: 0` on every run ever recorded would put a key on
 * every row that is indistinguishable from a row predating the field — and
 * telling those apart is the entire reason the field exists. Same shape, and
 * the same reason, as the runner's `...(hasTrace ? { hasTrace: true } : {})`.
 *
 * A run that failed on every attempt gets `attempt` and NO `passedOnRetry`: it
 * did retry, and it is still a failure. Both facts are worth having — the
 * attempt count is what tells a reader the failure was reproduced rather than
 * seen once.
 *
 * @param {{status: string, maxAttempt: number}} run
 * @returns {{attempt?: number, passedOnRetry?: boolean}}
 */
export function retryFields({ status, maxAttempt }) {
  const attempt =
    typeof maxAttempt === "number" && Number.isInteger(maxAttempt) && maxAttempt > 0
      ? maxAttempt
      : 0;
  if (attempt === 0) return {};
  return status === "passed" ? { attempt, passedOnRetry: true } : { attempt };
}

/**
 * What this run contributes to a flake transition series.
 *
 * The load-bearing half of the rule above. A retried pass is `"failed"` here
 * and `"passed"` in the outcome tally, which is what lets a test that needs a
 * retry every single time read as flaky rather than as stable.
 *
 * Anything without the field answers its own status, so a history recorded
 * before R24 counts exactly as it did.
 *
 * @param {{status: string, passedOnRetry?: boolean}} record
 * @returns {string}
 */
export function flakeSignal(record) {
  return record && record.passedOnRetry === true ? "failed" : record.status;
}

/**
 * Did this run go red at any point, whatever it finally reported?
 *
 * The question the digest and the cost model ask, and the one `status` alone
 * cannot answer once retries exist.
 *
 * @param {{status: string, passedOnRetry?: boolean}} record
 * @returns {boolean}
 */
export function everFailed(record) {
  return !!record && (record.status === "failed" || record.passedOnRetry === true);
}
