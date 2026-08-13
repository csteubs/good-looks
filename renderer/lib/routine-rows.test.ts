// The checklist and a Routine, in both directions. REDESIGN §7.1.
//
// Every case here is one where the translation could produce a perfectly
// well-formed Routine that describes a different job from the one on screen —
// a step missing, an order changed, a failure policy quietly reset. None of
// those throw, and none of them look wrong in the checklist.

import { describe, it, expect } from "vitest";

import type { Routine, RoutineStep, RoutineTestStep } from "./recorder-types";
import type { RowDefaults, RowOptionsMap, RowTest } from "./batch-run-plan";
import {
  brokenSteps,
  nextPolicy,
  rowsFromRoutine,
  sameSteps,
  stepsFromRows,
  testCount,
  untickedRow,
} from "./routine-rows";

/** `stepsFromRows` for a call that passes no groups: every step it returns is
 *  then a test step, and asserting that once here beats narrowing at each read.
 *  A group appearing would be a real defect, so this throws where a `filter`
 *  would quietly drop it. */
function flatSteps(...args: Parameters<typeof stepsFromRows>): RoutineTestStep[] {
  return stepsFromRows(...args).map((s) => {
    if (s.kind !== "test") throw new Error(`expected a test step, got ${s.kind}`);
    return s;
  });
}


const DEFAULTS: RowDefaults = { defaultRunBrowser: "chromium", defaultRunHeadless: false };

function tests(...ids: string[]): RowTest[] {
  return ids.map((id) => ({ id }));
}

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

function routine(steps: RoutineStep[]): Routine {
  return {
    id: "r-1",
    name: "Smoke",
    createdAt: 1,
    updatedAt: 1,
    steps,
    defaults: { captureArtifacts: false, concurrency: 1 },
  };
}

describe("opening a Routine into the checklist", () => {
  it("puts its steps first, in step order, and the rest after", () => {
    // A Routine whose four steps are scattered through forty rows is a Routine
    // you cannot see.
    const rows = rowsFromRoutine(
      routine([step({ testId: "t-c" }), step({ testId: "t-a" })]),
      tests("t-a", "t-b", "t-c", "t-d"),
      DEFAULTS,
    );
    expect(rows.order).toEqual(["t-c", "t-a", "t-b", "t-d"]);
  });

  it("ticks exactly the tests the Routine contains", () => {
    const rows = rowsFromRoutine(
      routine([step({ testId: "t-b" })]),
      tests("t-a", "t-b"),
      DEFAULTS,
    );
    expect(rows.rowOptions["t-b"].selected).toBe(true);
    expect(rows.rowOptions["t-a"].selected).toBe(false);
  });

  it("carries each step's engines and headedness onto its row", () => {
    const rows = rowsFromRoutine(
      routine([step({ testId: "t-a", browsers: ["webkit", "firefox"], headless: true })]),
      tests("t-a"),
      DEFAULTS,
    );
    expect(rows.rowOptions["t-a"]).toEqual({
      selected: true,
      // Canonical RUN_BROWSERS order, not the order they were stored in.
      browsers: ["firefox", "webkit"],
      headless: true,
    });
  });

  it("remembers an unticked row's engines rather than resetting it", () => {
    // Untick a row that ran on WebKit, tick it again, and the choice is still
    // there. Without this the row comes back on Chromium looking exactly like
    // one nobody ever touched.
    const remembered: RowOptionsMap = {
      "t-b": { selected: false, browsers: ["webkit"], headless: true },
    };
    const rows = rowsFromRoutine(routine([]), tests("t-a", "t-b"), DEFAULTS, remembered);
    expect(rows.rowOptions["t-b"]).toEqual({
      selected: false,
      browsers: ["webkit"],
      headless: true,
    });
  });

  it("forces a remembered row unticked even when it was stored ticked", () => {
    // The Routine is the ONLY thing that decides what is in the job. A stale
    // `true` in the scratch map would put a test into a Routine that does not
    // contain it — and it would run.
    const remembered: RowOptionsMap = {
      "t-b": { selected: true, browsers: ["webkit"], headless: false },
    };
    const rows = rowsFromRoutine(routine([]), tests("t-a", "t-b"), DEFAULTS, remembered);
    expect(rows.rowOptions["t-b"].selected).toBe(false);
  });

  it("drops a step whose test is gone rather than drawing a phantom row", () => {
    const rows = rowsFromRoutine(
      routine([step({ testId: "t-gone" }), step({ testId: "t-a" })]),
      tests("t-a"),
      DEFAULTS,
    );
    expect(rows.order).toEqual(["t-a"]);
    expect(rows.rowOptions["t-gone"]).toBeUndefined();
  });

  it("falls back rather than producing a row with no engines", () => {
    const rows = rowsFromRoutine(
      routine([step({ testId: "t-a", browsers: [] })]),
      tests("t-a"),
      DEFAULTS,
    );
    expect(rows.rowOptions["t-a"].browsers).toEqual(["chromium"]);
  });

  it("arranges the tests it does NOT contain by the library's own order", () => {
    // A Routine's order covers the tests in it. Without carrying the library's
    // arrangement, a row dragged while unticked snaps back on the next reload —
    // a rearrangement silently undone, which is worse than one never offered.
    const rows = rowsFromRoutine(
      routine([step({ testId: "t-b" })]),
      tests("t-a", "t-b", "t-c", "t-d"),
      DEFAULTS,
      {},
      ["t-d", "t-c", "t-a"],
    );
    expect(rows.order).toEqual(["t-b", "t-d", "t-c", "t-a"]);
  });

  it("leads with a test the stored order never mentioned", () => {
    // `applyOrder`'s rule, reused rather than re-written: a test recorded since
    // the order was saved is the one you came here to run, and appending it
    // buries it off the bottom of any real library.
    const rows = rowsFromRoutine(routine([]), tests("t-a", "t-new"), DEFAULTS, {}, ["t-a"]);
    expect(rows.order).toEqual(["t-new", "t-a"]);
  });

  it("ignores a stored order naming a test that is gone", () => {
    const rows = rowsFromRoutine(routine([]), tests("t-a"), DEFAULTS, {}, ["t-ghost", "t-a"]);
    expect(rows.order).toEqual(["t-a"]);
  });

  it("lists the whole library when no Routine is open", () => {
    const rows = rowsFromRoutine(null, tests("t-a", "t-b"), DEFAULTS);
    expect(rows.order).toEqual(["t-a", "t-b"]);
    expect(Object.values(rows.rowOptions).every((r) => !r.selected)).toBe(true);
  });
});

describe("committing the checklist back to steps", () => {
  it("takes only the ticked rows, in checklist order", () => {
    const rowOptions: RowOptionsMap = {
      "t-a": { selected: true, browsers: ["chromium"], headless: false },
      "t-b": { selected: false, browsers: ["chromium"], headless: false },
      "t-c": { selected: true, browsers: ["webkit"], headless: true },
    };
    const steps = flatSteps(["t-c", "t-b", "t-a"], rowOptions, tests("t-a", "t-b", "t-c"), DEFAULTS);
    expect(steps.map((s) => s.testId)).toEqual(["t-c", "t-a"]);
    expect(steps[0]).toMatchObject({ browsers: ["webkit"], headless: true });
  });

  it("carries the failure policy the row was given", () => {
    const rowOptions: RowOptionsMap = {
      "t-a": { selected: true, browsers: ["firefox"], headless: false },
    };
    const steps = flatSteps(["t-a"], rowOptions, tests("t-a"), DEFAULTS, {
      "t-a": "stopRoutine",
    });
    expect(steps[0].onFailure).toBe("stopRoutine");
    // …and the rest of the step still comes from the row.
    expect(steps[0].browsers).toEqual(["firefox"]);
  });

  it("defaults a row with no policy to continue", () => {
    // The default is load-bearing, not incidental: ROUTINES.md requires it,
    // because migrating the old Batch onto anything else would change what
    // every existing checklist does the first time it ran.
    const rowOptions: RowOptionsMap = {
      "t-new": { selected: true, browsers: ["chromium"], headless: false },
    };
    const steps = flatSteps(["t-new"], rowOptions, tests("t-new"), DEFAULTS, {
      "t-a": "stopRoutine",
    });
    expect(steps[0].onFailure).toBe("continue");
  });

  it("drops the policy of a row that was unticked", () => {
    // Deliberate asymmetry with `rowOptions`, whose engines survive unticking
    // as scratch. A policy is a statement about a job this test is no longer
    // part of, and keeping it would mean re-ticking a row silently re-arming
    // "stop the whole routine if this fails".
    const rowOptions: RowOptionsMap = {
      "t-a": { selected: false, browsers: ["chromium"], headless: false },
      "t-b": { selected: true, browsers: ["chromium"], headless: false },
    };
    const steps = flatSteps(["t-a", "t-b"], rowOptions, tests("t-a", "t-b"), DEFAULTS, {
      "t-a": "stopRoutine",
    });
    expect(steps.map((st) => st.testId)).toEqual(["t-b"]);
    expect(steps[0].onFailure).toBe("continue");
  });

  it("leaves a test with no stored row out, because an absent row is unticked", () => {
    // `resolveRow` falls back to `defaultRow`, which is `selected: false`. This
    // is the same fact the migration turns on, asserted from the other side:
    // an id in the order with nothing stored for it is not in the job.
    expect(flatSteps(["t-a"], {}, tests("t-a"), DEFAULTS)).toEqual([]);
  });

  it("gives a ticked row with an engine the test's own record would not have", () => {
    // The row is authoritative once it exists — `resolveRow` returns the stored
    // entry whole, so a per-row engine is not re-derived from the test.
    const rowOptions: RowOptionsMap = {
      "t-a": { selected: true, browsers: ["webkit"], headless: false },
    };
    const steps = flatSteps(["t-a"], rowOptions, [{ id: "t-a", runBrowser: "firefox" }], DEFAULTS);
    expect(steps[0].browsers).toEqual(["webkit"]);
  });

  it("ignores an id the library no longer has", () => {
    const rowOptions: RowOptionsMap = {
      "t-gone": { selected: true, browsers: ["chromium"], headless: false },
    };
    expect(flatSteps(["t-gone"], rowOptions, tests("t-a"), DEFAULTS)).toEqual([]);
  });

  it("produces one step for an id listed twice", () => {
    const rowOptions: RowOptionsMap = {
      "t-a": { selected: true, browsers: ["chromium"], headless: false },
    };
    expect(flatSteps(["t-a", "t-a"], rowOptions, tests("t-a"), DEFAULTS)).toHaveLength(1);
  });
});

describe("groups", () => {
  function grouped(id: string, label: string, testIds: string[]) {
    return {
      kind: "group" as const,
      id,
      label,
      steps: testIds.map((t) => step({ testId: t })),
    };
  }

  it("opens a group into a flat order plus a membership map", () => {
    // The checklist stays a FLAT ordered list — which is what lets
    // drag-to-reorder stay exactly what it was — and the nesting is redrawn
    // from `groupOf` at render time.
    const rows = rowsFromRoutine(
      routine([step({ testId: "t-a" }), grouped("g-1", "Seed", ["t-b", "t-c"])]),
      tests("t-a", "t-b", "t-c"),
      DEFAULTS,
    );
    expect(rows.order.slice(0, 3)).toEqual(["t-a", "t-b", "t-c"]);
    expect(rows.groups).toEqual([{ id: "g-1", label: "Seed" }]);
    expect(rows.groupOf).toEqual({ "t-b": "g-1", "t-c": "g-1" });
  });

  it("rebuilds the group at the position of its first member", () => {
    const back = stepsFromRows(
      ["t-a", "t-b", "t-c"],
      {
        "t-a": { selected: true, browsers: ["chromium"], headless: false },
        "t-b": { selected: true, browsers: ["chromium"], headless: false },
        "t-c": { selected: true, browsers: ["chromium"], headless: false },
      },
      tests("t-a", "t-b", "t-c"),
      DEFAULTS,
      {},
      [{ id: "g-1", label: "Seed" }],
      { "t-b": "g-1", "t-c": "g-1" },
    );
    expect(back.map((s) => s.kind)).toEqual(["test", "group"]);
    const group = back[1];
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.steps.map((s) => s.testId)).toEqual(["t-b", "t-c"]);
  });

  it("collects members that are not adjacent, rather than tearing the group", () => {
    // A member dragged away from its siblings moves WITHIN the group. The
    // alternative — emitting two groups with one id — is a shape the store
    // would collapse and the run would read as one, so the screen and the job
    // would disagree.
    const back = stepsFromRows(
      ["t-b", "t-a", "t-c"],
      {
        "t-a": { selected: true, browsers: ["chromium"], headless: false },
        "t-b": { selected: true, browsers: ["chromium"], headless: false },
        "t-c": { selected: true, browsers: ["chromium"], headless: false },
      },
      tests("t-a", "t-b", "t-c"),
      DEFAULTS,
      {},
      [{ id: "g-1", label: "Seed" }],
      { "t-b": "g-1", "t-c": "g-1" },
    );
    expect(back.filter((s) => s.kind === "group")).toHaveLength(1);
    const group = back[0];
    if (group.kind !== "group") throw new Error("expected the group first");
    expect(group.steps.map((s) => s.testId)).toEqual(["t-b", "t-c"]);
  });

  it("ignores a membership naming a group that does not exist", () => {
    // A step silently sorted into a group nobody can see is a `skipGroup` that
    // takes out rows for a reason not on screen.
    const back = stepsFromRows(
      ["t-a"],
      { "t-a": { selected: true, browsers: ["chromium"], headless: false } },
      tests("t-a"),
      DEFAULTS,
      {},
      [],
      { "t-a": "g-ghost" },
    );
    expect(back.map((s) => s.kind)).toEqual(["test"]);
  });

  it("round-trips a Routine with a group unchanged", () => {
    const original = routine([
      step({ testId: "t-a" }),
      grouped("g-1", "Seed", ["t-b", "t-c"]),
    ]);
    const library = tests("t-a", "t-b", "t-c");
    const rows = rowsFromRoutine(original, library, DEFAULTS);
    const back = stepsFromRows(
      rows.order,
      rows.rowOptions,
      library,
      DEFAULTS,
      rows.policies,
      rows.groups,
      rows.groupOf,
    );
    expect(back).toEqual(original.steps);
    expect(sameSteps(back, original.steps)).toBe(true);
  });

  it("sameSteps notices a rename and a member moving between groups", () => {
    const a = [grouped("g-1", "Seed", ["t-a"])];
    expect(sameSteps(a, [grouped("g-1", "Setup", ["t-a"])])).toBe(false);
    expect(sameSteps(a, [grouped("g-1", "Seed", ["t-b"])])).toBe(false);
    expect(sameSteps(a, [grouped("g-1", "Seed", ["t-a"])])).toBe(true);
    // A group and a bare test step are never the same step.
    expect(sameSteps(a, [step({ testId: "t-a" })])).toBe(false);
  });

  it("finds a broken step nested inside a group", () => {
    // More invisible than a broken step at the top level, not less: the group
    // still renders and simply runs one test fewer than it lists.
    const broken = brokenSteps(
      routine([grouped("g-1", "Seed", ["t-a", "t-gone"])]),
      tests("t-a"),
    );
    expect(broken.map((s) => s.testId)).toEqual(["t-gone"]);
  });
});

describe("testCount", () => {
  it("counts inside groups, because a group is one entry holding many", () => {
    // `steps.length` said "1 test" for a Routine of two the first time a group
    // was rendered in the rail. That is the bug this function exists for.
    const r = routine([
      step({ testId: "t-a" }),
      { kind: "group", id: "g-1", label: "Seed", steps: [step({ testId: "t-b" }), step({ testId: "t-c" })] },
    ]);
    expect(testCount(r)).toBe(3);
    expect(r.steps.length).toBe(2);
  });

  it("is 0 for nothing at all", () => {
    expect(testCount(null)).toBe(0);
    expect(testCount(routine([]))).toBe(0);
  });
});

describe("waits", () => {
  const wait = (id: string, ms: number) => ({ kind: "wait" as const, id, ms });

  it("pins each wait to the row it follows", () => {
    const rows = rowsFromRoutine(
      routine([
        step({ testId: "t-a" }),
        wait("w-1", 30_000) as unknown as RoutineStep,
        step({ testId: "t-b" }),
      ]),
      tests("t-a", "t-b"),
      DEFAULTS,
    );
    expect(rows.waits).toEqual([{ id: "w-1", ms: 30_000, after: "t-a" }]);
  });

  it("marks a LEADING wait with an empty `after`", () => {
    // The only value that can mean "before everything": a Routine's first step
    // has no predecessor to be pinned to.
    const rows = rowsFromRoutine(
      routine([wait("w-1", 5_000) as unknown as RoutineStep, step({ testId: "t-a" })]),
      tests("t-a"),
      DEFAULTS,
    );
    expect(rows.waits).toEqual([{ id: "w-1", ms: 5_000, after: "" }]);
  });

  it("pins a wait after a group to the group's LAST member", () => {
    // That is the row actually drawn above it. Pinning to the group would name
    // something `order` does not contain, and the wait would render nowhere.
    const rows = rowsFromRoutine(
      routine([
        {
          kind: "group",
          id: "g-1",
          label: "Seed",
          steps: [step({ testId: "t-a" }), step({ testId: "t-b" })],
        } as unknown as RoutineStep,
        wait("w-1", 1_000) as unknown as RoutineStep,
      ]),
      tests("t-a", "t-b"),
      DEFAULTS,
    );
    expect(rows.waits[0].after).toBe("t-b");
  });

  it("re-pins a wait whose row was deleted rather than dropping it", () => {
    // Dropping it would silently shorten a job; leaving it pointing at a row
    // that is not drawn renders it nowhere, which looks the same as dropping it
    // and is harder to notice.
    const rows = rowsFromRoutine(
      routine([step({ testId: "t-gone" }), wait("w-1", 1_000) as unknown as RoutineStep]),
      tests("t-a"),
      DEFAULTS,
    );
    expect(rows.waits).toEqual([{ id: "w-1", ms: 1_000, after: "" }]);
  });

  it("puts the waits back where they were", () => {
    const back = stepsFromRows(
      ["t-a", "t-b"],
      {
        "t-a": { selected: true, browsers: ["chromium"], headless: false },
        "t-b": { selected: true, browsers: ["chromium"], headless: false },
      },
      tests("t-a", "t-b"),
      DEFAULTS,
      {},
      [],
      {},
      [{ id: "w-1", ms: 30_000, after: "t-a" }],
    );
    expect(back.map((st) => st.kind)).toEqual(["test", "wait", "test"]);
  });

  it("emits a leading wait before everything, including before a group", () => {
    const back = stepsFromRows(
      ["t-a"],
      { "t-a": { selected: true, browsers: ["chromium"], headless: false } },
      tests("t-a"),
      DEFAULTS,
      {},
      [{ id: "g-1", label: "Seed" }],
      { "t-a": "g-1" },
      [{ id: "w-1", ms: 5_000, after: "" }],
    );
    expect(back.map((st) => st.kind)).toEqual(["wait", "group"]);
  });

  it("round-trips a Routine with a wait unchanged", () => {
    const original = routine([
      step({ testId: "t-a" }),
      wait("w-1", 30_000) as unknown as RoutineStep,
      step({ testId: "t-b" }),
    ]);
    const library = tests("t-a", "t-b");
    const rows = rowsFromRoutine(original, library, DEFAULTS);
    const back = stepsFromRows(
      rows.order,
      rows.rowOptions,
      library,
      DEFAULTS,
      rows.policies,
      rows.groups,
      rows.groupOf,
      rows.waits,
    );
    expect(back).toEqual(original.steps);
    expect(sameSteps(back, original.steps)).toBe(true);
  });

  it("sameSteps notices a wait's LENGTH changing", () => {
    // 30s to 5m is an edit worth a write; comparing only the id would call it
    // unchanged and never save it.
    const a = [wait("w-1", 30_000) as unknown as RoutineStep];
    expect(sameSteps(a, [wait("w-1", 300_000) as unknown as RoutineStep])).toBe(false);
    expect(sameSteps(a, [wait("w-1", 30_000) as unknown as RoutineStep])).toBe(true);
  });

  it("does not count a wait as a test", () => {
    // The rail promises "N tests"; a pause is not one of them.
    expect(
      testCount(routine([step({ testId: "t-a" }), wait("w-1", 1_000) as unknown as RoutineStep])),
    ).toBe(1);
  });
});

describe("nextPolicy", () => {
  it("offers skipGroup only inside a group", () => {
    // `skipGroup` outside a group has no rest-of-group to skip, so offering it
    // would be offering a setting the run quietly ignores.
    expect(nextPolicy("continue", false)).toBe("stopRoutine");
    expect(nextPolicy("stopRoutine", false)).toBe("continue");
    expect(nextPolicy("stopRoutine", true)).toBe("skipGroup");
    expect(nextPolicy("skipGroup", true)).toBe("continue");
  });

  it("lands on stopRoutine from anything it does not recognise", () => {
    expect(nextPolicy(undefined, false)).toBe("stopRoutine");
    expect(nextPolicy("detonate" as never, true)).toBe("stopRoutine");
  });
});

describe("round trip", () => {
  it("opening and committing a Routine leaves it unchanged", () => {
    // The property that matters: merely LOOKING at a Routine must not rewrite
    // it. Everything below hangs on this — the view commits on every gesture,
    // and a mount that counts as a gesture re-dates every job you open.
    const original = routine([
      step({ testId: "t-c", browsers: ["firefox", "webkit"], headless: true }),
      step({ testId: "t-a", onFailure: "stopRoutine" }),
    ]);
    const library = tests("t-a", "t-b", "t-c");
    const rows = rowsFromRoutine(original, library, DEFAULTS);
    const back = flatSteps(rows.order, rows.rowOptions, library, DEFAULTS, rows.policies);
    expect(back).toEqual(original.steps);
    expect(sameSteps(back, original.steps)).toBe(true);
  });
});

describe("sameSteps", () => {
  it("is true for two descriptions of the same job", () => {
    expect(sameSteps([step()], [step()])).toBe(true);
  });

  it("notices a changed order, engine, headedness or policy", () => {
    const base = [step({ testId: "t-a" }), step({ testId: "t-b" })];
    expect(sameSteps(base, [base[1], base[0]])).toBe(false);
    expect(sameSteps([step()], [step({ browsers: ["webkit"] })])).toBe(false);
    expect(sameSteps([step()], [step({ headless: true })])).toBe(false);
    expect(sameSteps([step()], [step({ onFailure: "stopRoutine" })])).toBe(false);
    expect(sameSteps([step()], [])).toBe(false);
  });

  it("notices an engine added to a step", () => {
    expect(sameSteps([step()], [step({ browsers: ["chromium", "webkit"] })])).toBe(false);
  });
});

describe("broken steps", () => {
  it("returns the whole step, not just an id", () => {
    // "Login, Chromium + WebKit, deleted" is something a person can act on.
    const broken = brokenSteps(
      routine([step({ testId: "t-a" }), step({ testId: "t-gone", browsers: ["webkit"] })]),
      tests("t-a"),
    );
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ testId: "t-gone", browsers: ["webkit"] });
  });

  it("counts a flagged step even while its test still exists", () => {
    // The flag and the library can disagree for one render — the delete handler
    // marks the step, and the library query has not refetched yet. Trusting
    // only the library would blink the row back as if nothing happened.
    const broken = brokenSteps(routine([step({ testDeleted: true })]), tests("t-a"));
    expect(broken.map((s) => s.testId)).toEqual(["t-a"]);
  });

  it("is empty for a Routine whose tests all exist", () => {
    expect(brokenSteps(routine([step()]), tests("t-a"))).toEqual([]);
    expect(brokenSteps(null, tests("t-a"))).toEqual([]);
  });
});

describe("untickedRow", () => {
  it("agrees with what opening a Routine produces for the same test", () => {
    // Two opinions of "not in this job" is how a Select-none leaves rows that
    // look ticked-off but are stored differently from the ones that never were.
    const remembered: RowOptionsMap = {
      "t-a": { selected: true, browsers: ["webkit"], headless: true },
    };
    const rows = rowsFromRoutine(routine([]), tests("t-a"), DEFAULTS, remembered);
    expect(untickedRow({ id: "t-a" }, DEFAULTS, remembered)).toEqual(rows.rowOptions["t-a"]);
  });
});
