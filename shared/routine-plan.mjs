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
 * What a step's failure does to the rest of the job.
 *
 * NORMALISED HERE, not trusted from the record. `routines.json` is on disk and
 * this value now decides whether the remaining steps run at all, so an
 * unrecognised string must land on the harmless answer rather than on
 * `undefined` — which the runner would compare against "stopRoutine", get
 * false, and continue on. That happens to be right today and only by accident.
 *
 * `skipGroup` is a real answer as of capability 3's first slice. It used to
 * degrade to `continue`, honestly — with no groups, "skip the rest of this
 * group" was "skip nothing". Groups exist now, so it stands on its own, and a
 * `skipGroup` step that is NOT in a group still degrades to continuing: the
 * runner reads `groupId`, and an ungrouped entry has no rest-of-group to skip.
 * That degradation lives at the point of failure rather than here, because a
 * step's policy is a property of the step and whether it is in a group is not.
 */
export function failurePolicy(step) {
  if (step?.onFailure === "stopRoutine") return "stopRoutine";
  if (step?.onFailure === "skipGroup") return "skipGroup";
  return "continue";
}

/** Longest a single wait may pause a Routine: one hour. Mirrors
 *  `MAX_ROUTINE_WAIT_MS`; this module is shared with the MCP and cannot import
 *  the app's types, and a wait that never ends is a batch that looks hung. */
export const MAX_WAIT_MS = 60 * 60 * 1000;

/** A stored wait, clamped to something a run can actually sit through. Returns
 *  0 for anything that is not a usable duration, and 0 means "no barrier" —
 *  a step that pauses for no time is not a pause. */
export function clampWaitMs(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), MAX_WAIT_MS);
}

/**
 * Turn a Routine into the batch payload, plus what it had to leave out.
 *
 * `knownTestIds` is what the library currently holds. Passing `null` skips the
 * existence check entirely, which is for callers that have already resolved the
 * tests — NOT a default, because "no list supplied" and "the library is empty"
 * would otherwise be the same value and the second one must skip everything.
 */
export function routineRunPlan(routine, knownTestIds, options) {
  // NEVER A HEADED BROWSER ON A SCHEDULE. ROUTINES.md rules this out flatly,
  // and the reason is not tidiness: a window that steals focus while somebody
  // is working is the fastest way to have the feature turned off, and a
  // schedule fires when nobody asked. It overrides the STEP's own setting
  // rather than deferring to it — a step someone headed deliberately is still
  // a step they headed for a run they were watching. Applied here, where the
  // payload is built, so there is one place it can be true.
  const forceHeadless = options?.forceHeadless === true;
  const known = knownTestIds ? new Set(knownTestIds) : null;
  const steps = Array.isArray(routine?.steps) ? routine.steps : [];

  const perTest = [];
  const testIds = [];
  const skipped = [];
  const seen = new Set();

  // FLATTENED IN PLACE, so a group's members queue exactly where the group sits
  // rather than being gathered to the end. The order is the Routine's, and a
  // group is structure over that order, not a second ordering of it. The
  // group's id rides along on each member: `skipGroup` needs to know which
  // entries are "the rest of this group", and re-deriving that at the moment of
  // failure would be a second reading of the same record.
  //
  // SEGMENTS, and this is the whole barrier design.
  //
  // A `wait` is a step that is not a run, so a Routine stopped being a set of
  // tests that pour into one queue. Rather than teach the runner a second way
  // to execute — the "second execution engine" ROUTINES.md names as this
  // feature's main design risk — the plan cuts the steps at each barrier and
  // hands over the SAME `{ testIds, perTest }` payload it always did, with each
  // entry labelled by which segment it belongs to. The runner then drains one
  // segment's lanes with the pool it already has, joins, runs the barrier, and
  // moves on. Lanes, concurrency, write-through and the summary are untouched.
  //
  // A test belongs to exactly one segment, because the store collapses
  // duplicate testIds across the whole Routine — so the lane partition and the
  // segment partition can never disagree.
  let segment = 0;
  const barriers = [];
  const flat = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    if (step.kind === "wait") {
      // Clamped, not rejected. A stored value out of range is a job somebody
      // built; refusing to run it teaches nothing, and the ceiling is the thing
      // that actually matters (see MAX_ROUTINE_WAIT_MS).
      const ms = clampWaitMs(step.ms);
      if (ms > 0) {
        barriers.push({ afterSegment: segment, ms });
        segment += 1;
      }
      continue;
    }
    if (step.kind === "group") {
      const groupId = typeof step.id === "string" ? step.id : "";
      for (const child of Array.isArray(step.steps) ? step.steps : []) {
        // A group inside a group is dropped rather than walked: v1 is one level
        // deep, and the store already refuses to store one.
        if (child && typeof child === "object" && child.kind === "test") {
          flat.push({ step: child, groupId, segment });
        }
      }
      continue;
    }
    if (step.kind === "test") flat.push({ step, groupId: "", segment });
  }

  for (const { step, groupId, segment: stepSegment } of flat) {
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
    perTest.push({
      testId,
      browsers,
      headless: forceHeadless || step.headless === true,
      onFailure: failurePolicy(step),
      // Omitted for a top-level step rather than set empty, so "belongs to no
      // group" and "belongs to a group whose id did not survive" are the same
      // harmless thing to the runner: `skipGroup` on an ungrouped step has
      // nothing to skip, which is what it should do.
      ...(groupId ? { groupId } : {}),
      segment: stepSegment,
    });
  }

  // A TRAILING BARRIER IS DROPPED. A wait with nothing after it gates nothing —
  // it would hold the batch open, and its own progress bar, for a stretch of
  // time in which the job is already finished. Computed against the segments
  // that actually produced entries, so a wait followed only by deleted tests
  // counts as trailing too, which is the case nobody would think to check.
  const lastLiveSegment = perTest.reduce((max, e) => Math.max(max, e.segment), -1);

  return {
    testIds,
    perTest,
    /** Where the runner must join. `afterSegment` is the segment that has to
     *  finish before the pause starts. */
    barriers: barriers.filter((b) => b.afterSegment < lastLiveSegment),
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
