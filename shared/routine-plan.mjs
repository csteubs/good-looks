// What running a Routine actually queues. docs/ROUTINES.md.
//
// PURE, and in `shared/` for the reason the rename table implies: ROUTINES says
// to add `run_routine` alongside the MCP's `run_batch` rather than renaming it,
// so two callers will build this payload — the IPC handler and the MCP server —
// and a second transcription of these rules is right the day it is written and
// silently divergent after.
//
// A ROUTINE COMPOSES RUNS. Every step becomes its own process, its own
// RunRecord and its own row in Stats, which is why the output here is the same
// `{ testIds, perTest }` shape the batch runner already takes: the Routine is a
// saved description of a batch, not a second execution engine. Building a
// second one is the design risk the spec names, and the way to not build it is
// to keep the plan a translation.
//
// TWO THINGS THIS HAS TO GET RIGHT, both silent when wrong:
//
//   • A step whose test has been DELETED is skipped, and the plan says so. It
//     is kept in the Routine deliberately (see `routineStore.markTestDeleted`)
//     so the user can see what they lost — but running it would queue a test
//     that does not exist, and a batch reporting one more failure than it has
//     tests is worse than one that reports what it skipped.
//   • The ORDER is the Routine's. A job that runs its steps in a different
//     order from the one on screen is the same bug as a batch running fewer
//     tests than it said, and it is only visible when a step depends on an
//     earlier one — which is precisely when a Routine is worth having.

/** Engines a step may name. Mirrors `RUN_BROWSERS`; the same three, in the same
 *  order, because filtering THROUGH this list is what dedupes and normalises in
 *  one pass rather than trusting the stored order. */
export const PLAN_BROWSERS = ["chromium", "firefox", "webkit"];

/**
 * Turn a Routine into the batch payload, plus what it had to leave out.
 *
 * `knownTestIds` is what the library currently holds. Passing `null` skips the
 * existence check entirely, which is for callers that have already resolved the
 * tests — NOT a default, because "no list supplied" and "the library is empty"
 * would otherwise be the same value and the second one must skip everything.
 */
export function routineRunPlan(routine, knownTestIds) {
  const known = knownTestIds ? new Set(knownTestIds) : null;
  const steps = Array.isArray(routine?.steps) ? routine.steps : [];

  const perTest = [];
  const testIds = [];
  const skipped = [];
  const seen = new Set();

  for (const step of steps) {
    if (!step || typeof step !== "object" || step.kind !== "test") continue;
    const testId = typeof step.testId === "string" ? step.testId : "";
    if (testId === "") continue;
    // A step marked broken, or one naming a test the library no longer has.
    // Both are the same thing to a run; the flag is what the EDITOR renders,
    // and the library is what is actually true right now.
    if (step.testDeleted === true || (known && !known.has(testId))) {
      skipped.push(testId);
      continue;
    }
    // Defensive rather than expected: the store already collapses these. A
    // duplicate reaching here would queue one test twice, and the runner
    // serialises a test into one lane — so it would not run in parallel, it
    // would just make the batch's own total disagree with its rows.
    if (seen.has(testId)) continue;
    seen.add(testId);

    const wanted = Array.isArray(step.browsers) ? step.browsers : [];
    const browsers = PLAN_BROWSERS.filter((b) => wanted.includes(b));
    if (browsers.length === 0) {
      // A step with no runnable engine queues nothing. Counting it as planned
      // would make the toolbar promise a run that never happens; skipping it
      // says so in the same place a deleted test does.
      skipped.push(testId);
      continue;
    }

    testIds.push(testId);
    perTest.push({ testId, browsers, headless: step.headless === true });
  }

  return {
    testIds,
    perTest,
    /** Queue entries, which is the sum of each step's engines rather than the
     *  test count — the two differ the moment one step names two engines, and
     *  the toolbar has to report the number that will actually run. */
    plannedRuns: perTest.reduce((n, e) => n + e.browsers.length, 0),
    skipped,
    captureArtifacts: routine?.defaults?.captureArtifacts === true,
    /** Requested lanes. NOT clamped here — the ceiling is the number of
     *  distinct tests, which the caller knows and the runner enforces; a second
     *  clamp in this module could only ever disagree with it. */
    concurrency:
      typeof routine?.defaults?.concurrency === "number" &&
      Number.isFinite(routine.defaults.concurrency) &&
      routine.defaults.concurrency >= 1
        ? Math.floor(routine.defaults.concurrency)
        : 1,
  };
}

/**
 * Why this Routine cannot run, or null when it can.
 *
 * A SENTENCE, not a boolean, and the three cases are genuinely different
 * problems: an empty Routine is one you have not finished building, a Routine
 * that is all-deleted is one whose tests you removed elsewhere, and those want
 * different reactions. "Nothing to run" for both sends someone to look for a
 * tick they never made.
 */
export function routineBlockedReason(plan) {
  if (!plan || plan.testIds.length > 0) return null;
  if (!plan.skipped || plan.skipped.length === 0) {
    return "This routine has no steps yet.";
  }
  return plan.skipped.length === 1
    ? "The only test in this routine has been deleted."
    : `All ${plan.skipped.length} tests in this routine have been deleted.`;
}
