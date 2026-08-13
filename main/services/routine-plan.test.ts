// What running a Routine queues. docs/ROUTINES.md.
//
// LIVES HERE RATHER THAN BESIDE `shared/routine-plan.mjs`: vitest's `node`
// project globs `main/**/*.test.ts`, so a test under `shared/` matches NEITHER
// project and passes by never running. Same placement as `emitters.test.ts` and
// `routine-migration.test.ts`.
//
// The plan is a TRANSLATION into the batch runner's existing payload, so what
// is worth asserting is everything that could quietly translate wrongly: the
// order, the skips, and the count the toolbar reports.

import { describe, it, expect } from "vitest";

import type { Routine, RoutineStep, RoutineTestStep } from "../recorder/types.js";
import { failurePolicy, routineBlockedReason, routineRunPlan } from "../../shared/routine-plan.mjs";

function step(over: Partial<RoutineTestStep> = {}): RoutineTestStep {
  return {
    kind: "test",
    testId: "t-a",
    browsers: ["chromium"],
    headless: false,
    onFailure: "continue",
    ...over,
  };
}

function routine(steps: RoutineStep[], over: Partial<Routine> = {}): Routine {
  return {
    id: "r-1",
    name: "Smoke",
    createdAt: 1,
    updatedAt: 1,
    steps,
    defaults: { captureArtifacts: false, concurrency: 1 },
    ...over,
  };
}

describe("order", () => {
  it("queues the Routine's steps in the Routine's order", () => {
    // A job that runs its steps in a different order from the one on screen is
    // only visible when a step depends on an earlier one — which is exactly
    // when a Routine is worth having.
    const plan = routineRunPlan(
      routine([step({ testId: "t-c" }), step({ testId: "t-a" }), step({ testId: "t-b" })]),
      ["t-a", "t-b", "t-c"],
    );
    expect(plan.testIds).toEqual(["t-c", "t-a", "t-b"]);
    expect(plan.perTest.map((e) => e.testId)).toEqual(["t-c", "t-a", "t-b"]);
  });
});

describe("what will not run", () => {
  it("skips a step whose test has been deleted, and says which", () => {
    const plan = routineRunPlan(
      routine([step({ testId: "t-a" }), step({ testId: "t-gone", testDeleted: true })]),
      ["t-a", "t-gone"],
    );
    expect(plan.testIds).toEqual(["t-a"]);
    expect(plan.skipped).toEqual(["t-gone"]);
  });

  it("skips a step the library no longer holds even without the flag", () => {
    // The flag is what the EDITOR renders; the library is what is true now. A
    // Routine saved before a delete reached it must still not queue a ghost.
    const plan = routineRunPlan(routine([step({ testId: "t-ghost" })]), ["t-a"]);
    expect(plan.testIds).toEqual([]);
    expect(plan.skipped).toEqual(["t-ghost"]);
  });

  it("skips a step with no runnable engine rather than counting it as planned", () => {
    const plan = routineRunPlan(
      routine([step({ testId: "t-a", browsers: [] }), step({ testId: "t-b" })]),
      ["t-a", "t-b"],
    );
    expect(plan.testIds).toEqual(["t-b"]);
    expect(plan.skipped).toEqual(["t-a"]);
  });

  it("checks nothing when the caller passes null, and everything when passed an empty list", () => {
    // The two must NOT be the same value: "I already resolved these" and "the
    // library is empty" want opposite answers, and defaulting would silently
    // give the second one the first one's behaviour.
    expect(routineRunPlan(routine([step()]), null).testIds).toEqual(["t-a"]);
    expect(routineRunPlan(routine([step()]), []).testIds).toEqual([]);
  });
});

describe("what each entry carries", () => {
  it("normalises engines through the known list rather than trusting stored order", () => {
    const plan = routineRunPlan(
      routine([step({ browsers: ["webkit", "chromium", "webkit"] as never })]),
      ["t-a"],
    );
    expect(plan.perTest[0].browsers).toEqual(["chromium", "webkit"]);
  });

  it("keeps headedness per step", () => {
    const plan = routineRunPlan(
      routine([step({ testId: "t-a", headless: true }), step({ testId: "t-b", headless: false })]),
      ["t-a", "t-b"],
    );
    expect(plan.perTest.map((e) => e.headless)).toEqual([true, false]);
  });

  it("counts planned runs as queue entries, not tests", () => {
    // The two differ the moment one step names two engines, and the toolbar has
    // to report the number that will actually run.
    const plan = routineRunPlan(
      routine([
        step({ testId: "t-a", browsers: ["chromium", "firefox"] }),
        step({ testId: "t-b" }),
      ]),
      ["t-a", "t-b"],
    );
    expect(plan.testIds).toHaveLength(2);
    expect(plan.plannedRuns).toBe(3);
  });

  it("carries the Routine's own defaults", () => {
    const plan = routineRunPlan(
      routine([step()], { defaults: { captureArtifacts: true, concurrency: 4 } }),
      ["t-a"],
    );
    expect(plan.captureArtifacts).toBe(true);
    expect(plan.concurrency).toBe(4);
  });

  it("falls back to one lane for a concurrency that is not a lane count", () => {
    const bad = { captureArtifacts: false, concurrency: 0 } as Routine["defaults"];
    expect(routineRunPlan(routine([step()], { defaults: bad }), ["t-a"]).concurrency).toBe(1);
  });
});

describe("a scheduled run never opens a window", () => {
  it("forces every step headless, overriding the step's own setting", () => {
    // ROUTINES.md rules this out flatly. A step someone headed deliberately is
    // still a step they headed for a run they were WATCHING; a schedule fires
    // when nobody asked, and a window stealing focus mid-work is the fastest
    // way to have the feature turned off.
    const plan = routineRunPlan(
      routine([
        step({ testId: "t-a", headless: false }),
        step({ testId: "t-b", headless: true }),
      ]),
      ["t-a", "t-b"],
      { forceHeadless: true },
    );
    expect(plan.perTest.map((e) => e.headless)).toEqual([true, true]);
  });

  it("leaves headedness alone for a manual run", () => {
    const plan = routineRunPlan(routine([step({ headless: false })]), ["t-a"]);
    expect(plan.perTest[0].headless).toBe(false);
    expect(routineRunPlan(routine([step({ headless: false })]), ["t-a"], {}).perTest[0].headless)
      .toBe(false);
  });
});

describe("why it cannot run", () => {
  it("distinguishes an unfinished Routine from one whose tests are gone", () => {
    // Different problems wanting different reactions. "Nothing to run" for both
    // sends someone to look for a tick they never made.
    const empty = routineRunPlan(routine([]), ["t-a"]);
    expect(routineBlockedReason(empty)).toBe("This routine has no steps yet.");

    const one = routineRunPlan(routine([step({ testDeleted: true })]), ["t-a"]);
    expect(routineBlockedReason(one)).toBe("The only test in this routine has been deleted.");

    const many = routineRunPlan(
      routine([step({ testDeleted: true }), step({ testId: "t-b", testDeleted: true })]),
      ["t-a", "t-b"],
    );
    expect(routineBlockedReason(many)).toBe("All 2 tests in this routine have been deleted.");
  });

  it("does not block a Routine that can run some of its steps", () => {
    // A partial skip is a note, not a refusal — the run still does most of what
    // was asked, and refusing it would make one deleted test disable a suite.
    const plan = routineRunPlan(
      routine([step({ testId: "t-a" }), step({ testId: "t-gone", testDeleted: true })]),
      ["t-a", "t-gone"],
    );
    expect(routineBlockedReason(plan)).toBeNull();
  });
});

describe("the failure policy", () => {
  it("reaches the plan, so the runner can act on it", () => {
    const plan = routineRunPlan(
      routine([step({ testId: "t-a", onFailure: "stopRoutine" }), step({ testId: "t-b" })]),
      ["t-a", "t-b"],
    );
    expect(plan.perTest.map((e) => e.onFailure)).toEqual(["stopRoutine", "continue"]);
  });

  it("normalises anything it does not recognise to continue", () => {
    // NOT a defensive nicety. This value now decides whether the REST of the
    // job runs, and `routines.json` is a file on disk. An unrecognised string
    // reaching the runner would be compared against "stopRoutine", come back
    // false and carry on — right today, and only by accident.
    expect(failurePolicy({ onFailure: "detonate" })).toBe("continue");
    expect(failurePolicy({ onFailure: 7 })).toBe("continue");
    expect(failurePolicy({})).toBe("continue");
    expect(failurePolicy(null)).toBe("continue");
    expect(failurePolicy(undefined)).toBe("continue");
  });

  it("keeps skipGroup, now that there are groups for it to point at", () => {
    // It used to degrade to `continue` here, honestly: with no groups, "skip
    // the rest of this group" was "skip nothing". Groups landed, so it stands
    // on its own — and the degradation moved to the point of failure, where
    // the runner can see whether the entry HAS a group. A step's policy is a
    // property of the step; whether it sits in a group is not.
    expect(failurePolicy({ onFailure: "skipGroup" })).toBe("skipGroup");
  });

  it("carries the group each step came from, and only for grouped steps", () => {
    // The whole of what a group means at run time. `skipGroup` needs to know
    // which queue entries are "the rest of this group", and re-deriving that
    // from the Routine at the moment of failure would be a second reading of
    // the same record.
    const plan = routineRunPlan(
      routine([
        step({ testId: "t-a" }),
        {
          kind: "group",
          id: "g-1",
          label: "Seed",
          steps: [step({ testId: "t-b" }), step({ testId: "t-c" })],
        },
      ]),
      ["t-a", "t-b", "t-c"],
    );
    expect(plan.perTest.map((e) => [e.testId, e.groupId])).toEqual([
      ["t-a", undefined],
      ["t-b", "g-1"],
      ["t-c", "g-1"],
    ]);
  });

  it("flattens a group IN PLACE, not to the end", () => {
    // The order is the Routine's, and a group is structure over that order
    // rather than a second ordering of it. Gathering members to the end is
    // only visible when a step depends on an earlier one — which is precisely
    // when a Routine is worth having.
    const plan = routineRunPlan(
      routine([
        { kind: "group", id: "g-1", label: "Seed", steps: [step({ testId: "t-b" })] },
        step({ testId: "t-a" }),
      ]),
      ["t-a", "t-b"],
    );
    expect(plan.testIds).toEqual(["t-b", "t-a"]);
  });

  it("reports a deleted test inside a group as skipped, like any other", () => {
    const plan = routineRunPlan(
      routine([
        {
          kind: "group",
          id: "g-1",
          label: "Seed",
          steps: [step({ testId: "t-gone" }), step({ testId: "t-a" })],
        },
      ]),
      ["t-a"],
    );
    expect(plan.skipped).toEqual(["t-gone"]);
    expect(plan.testIds).toEqual(["t-a"]);
  });

  it("survives a stored value the app cannot produce", () => {
    const plan = routineRunPlan(
      routine([{ ...step(), onFailure: "stopEverything" } as unknown as RoutineStep]),
      ["t-a"],
    );
    expect(plan.perTest[0].onFailure).toBe("continue");
  });
});

describe("hostile input", () => {
  it("survives a routine that is not one", () => {
    expect(routineRunPlan(null, ["t-a"]).testIds).toEqual([]);
    expect(routineRunPlan(undefined, ["t-a"]).plannedRuns).toBe(0);
  });

  it("ignores a step kind that is not built, rather than queueing it", () => {
    const steps = [{ kind: "wait", ms: 10 }, step()] as unknown as RoutineStep[];
    expect(routineRunPlan(routine(steps), ["t-a"]).testIds).toEqual(["t-a"]);
  });

  it("queues a duplicated test once", () => {
    // The store already collapses these; a duplicate reaching here would make
    // the batch's own total disagree with its rows.
    const plan = routineRunPlan(routine([step(), step()]), ["t-a"]);
    expect(plan.testIds).toEqual(["t-a"]);
  });
});
