// The checklist and a Routine, in both directions. REDESIGN §7.1.
//
// Every case here is one where the translation could produce a perfectly
// well-formed Routine that describes a different job from the one on screen —
// a step missing, an order changed, a failure policy quietly reset. None of
// those throw, and none of them look wrong in the checklist.

import { describe, it, expect } from "vitest";

import type { Routine, RoutineStep } from "./recorder-types";
import type { RowDefaults, RowOptionsMap, RowTest } from "./batch-run-plan";
import {
  brokenSteps,
  rowsFromRoutine,
  sameSteps,
  stepsFromRows,
  untickedRow,
} from "./routine-rows";

const DEFAULTS: RowDefaults = { defaultRunBrowser: "chromium", defaultRunHeadless: false };

function tests(...ids: string[]): RowTest[] {
  return ids.map((id) => ({ id }));
}

function step(over: Partial<RoutineStep> = {}): RoutineStep {
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
    const steps = stepsFromRows(["t-c", "t-b", "t-a"], rowOptions, tests("t-a", "t-b", "t-c"), DEFAULTS);
    expect(steps.map((s) => s.testId)).toEqual(["t-c", "t-a"]);
    expect(steps[0]).toMatchObject({ browsers: ["webkit"], headless: true });
  });

  it("preserves a failure policy the checklist cannot show", () => {
    // The checklist has no control for it, so rebuilding from rows alone would
    // reset every step to `continue` the next time anyone ticked a box —
    // turning "stop if seeding fails" into "carry on", silently.
    const previous = [step({ testId: "t-a", onFailure: "stopRoutine" })];
    const rowOptions: RowOptionsMap = {
      "t-a": { selected: true, browsers: ["firefox"], headless: false },
    };
    const steps = stepsFromRows(["t-a"], rowOptions, tests("t-a"), DEFAULTS, previous);
    expect(steps[0].onFailure).toBe("stopRoutine");
    // …and the rest of the step still comes from the row.
    expect(steps[0].browsers).toEqual(["firefox"]);
  });

  it("defaults a newly ticked row to continue", () => {
    const rowOptions: RowOptionsMap = {
      "t-new": { selected: true, browsers: ["chromium"], headless: false },
    };
    const steps = stepsFromRows(["t-new"], rowOptions, tests("t-new"), DEFAULTS, [
      step({ testId: "t-a", onFailure: "stopRoutine" }),
    ]);
    expect(steps[0].onFailure).toBe("continue");
  });

  it("leaves a test with no stored row out, because an absent row is unticked", () => {
    // `resolveRow` falls back to `defaultRow`, which is `selected: false`. This
    // is the same fact the migration turns on, asserted from the other side:
    // an id in the order with nothing stored for it is not in the job.
    expect(stepsFromRows(["t-a"], {}, tests("t-a"), DEFAULTS)).toEqual([]);
  });

  it("gives a ticked row with an engine the test's own record would not have", () => {
    // The row is authoritative once it exists — `resolveRow` returns the stored
    // entry whole, so a per-row engine is not re-derived from the test.
    const rowOptions: RowOptionsMap = {
      "t-a": { selected: true, browsers: ["webkit"], headless: false },
    };
    const steps = stepsFromRows(["t-a"], rowOptions, [{ id: "t-a", runBrowser: "firefox" }], DEFAULTS);
    expect(steps[0].browsers).toEqual(["webkit"]);
  });

  it("ignores an id the library no longer has", () => {
    const rowOptions: RowOptionsMap = {
      "t-gone": { selected: true, browsers: ["chromium"], headless: false },
    };
    expect(stepsFromRows(["t-gone"], rowOptions, tests("t-a"), DEFAULTS)).toEqual([]);
  });

  it("produces one step for an id listed twice", () => {
    const rowOptions: RowOptionsMap = {
      "t-a": { selected: true, browsers: ["chromium"], headless: false },
    };
    expect(stepsFromRows(["t-a", "t-a"], rowOptions, tests("t-a"), DEFAULTS)).toHaveLength(1);
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
    const back = stepsFromRows(rows.order, rows.rowOptions, library, DEFAULTS, original.steps);
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
