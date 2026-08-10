// The Stats category arithmetic.
//
// NODE PROJECT, no React and no jsdom — `renderer/lib/**/*.test.ts` is matched
// by the node config. That is deliberate rather than incidental: the failure
// this file guards against is a WRONG NUMBER, and a component test is worst at
// noticing one. A tile rendering `0` looks perfectly correct.
//
// The first describe block is the one that matters, and it was written before
// the implementation for that reason.

import { describe, it, expect } from "vitest";

import {
  CATEGORIES,
  bandReading,
  categoryMeta,
  isCategoryId,
  isMeasured,
  summariseA11y,
  summariseAll,
  summariseHeals,
  summariseOutcomes,
  summariseSpeed,
  summariseStability,
  summariseSteps,
  summariseVisual,
  type CategorySummary,
} from "./stats-categories";
import type { FlakeReport, HealListEntry, RunRecord, RunReplaySummary } from "./recorder-types";

// ── Fixtures ──────────────────────────────────────────────────────────

function run(over: Partial<RunRecord> & { id: string }): RunRecord {
  return {
    testId: "t1",
    testName: "Alpha",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    durationMs: 1000,
    logFile: `${over.id}.log`,
    logBytes: 10,
    ...over,
  } as RunRecord;
}

function flake(over: Partial<FlakeReport> = {}): FlakeReport {
  return {
    tests: [],
    clusters: [],
    analysedTests: 0,
    windowRuns: 0,
    windowCap: 200,
    ...over,
  } as FlakeReport;
}

function testFlake(over: Record<string, unknown>) {
  return {
    testId: "t1",
    testName: "Alpha",
    runs: 10,
    passed: 5,
    failed: 5,
    transitions: 4,
    flakeRate: 0.4,
    verdict: "flaky",
    failingDatasets: [],
    steps: [],
    healedRuns: 0,
    ...over,
  } as never;
}

function heal(over: Partial<HealListEntry> & { id: string }): HealListEntry {
  return {
    testId: "t1",
    testName: "Alpha",
    stepId: "s1",
    stepIndex: 0,
    stepLabel: "click Pay",
    source: "run",
    appliedLocator: { k: "testid", v: "pay" },
    candidates: [],
    applied: true,
    status: "pending",
    at: 1_700_000_000_000,
    ...over,
  } as HealListEntry;
}

function replay(over: Partial<RunReplaySummary> & { runId: string }): RunReplaySummary {
  return {
    testId: "t1",
    testName: "Alpha",
    status: "passed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    stepCount: 4,
    failedIndex: null,
    changedSteps: 0,
    ...over,
  } as RunReplaySummary;
}

const COST = {
  runs: 3,
  totalMs: 30_000,
  captureMs: 1000,
  a11yMs: 500,
  shots: 6,
  bySpeed: [],
  instrumentedMs: 1500,
  otherMs: 28_500,
  instrumentedShare: 0.05,
};

// ══════════════════════════════════════════════════════════════════════

describe("zero is not the same as never measured", () => {
  // THE RULE THE WHOLE FEATURE RESTS ON. A category rendering `0` when the
  // truth is "you have never switched this on" is a confident, wrong all-clear
  // — and it is what a naive implementation produces, because summing an empty
  // list gives 0 in every one of these cases.
  //
  // Every assertion below is therefore paired: the clean case DOES print a
  // number, the unmeasured case prints NOTHING. Asserting only the second would
  // pass against an implementation that never prints a number at all.

  it("separates a checked-and-clean accessibility run from one never checked", () => {
    const checked = summariseA11y([run({ id: "r1", a11yChecks: 12, a11yNewSteps: 0 })]);
    expect(checked.state).toBe("clean");
    expect(checked.display).toBe("0");

    const never = summariseA11y([run({ id: "r1" })]);
    expect(never.state).toBe("unmeasured");
    expect(never.display).toBeNull();
    expect(never.say).toMatch(/check accessibility/i);
  });

  it("does not count a run whose check completed zero checks as measured", () => {
    // The toggle was on and the check produced nothing. `a11y-panel.tsx` calls
    // that a fault, not a clean bill of health — so it must not read as one
    // here either, and `a11yChecks: 0` with the field PRESENT is the shape that
    // would fool a truthiness test.
    const s = summariseA11y([run({ id: "r1", a11yChecks: 0, a11yNewSteps: 0 })]);
    expect(s.state).toBe("unmeasured");
    expect(s.display).toBeNull();
  });

  it("separates a captured-and-clean visual run from one never captured", () => {
    const captured = summariseVisual([replay({ runId: "r1", changedSteps: 0 })]);
    expect(captured.state).toBe("clean");
    expect(captured.display).toBe("0");

    const never = summariseVisual([]);
    expect(never.state).toBe("unmeasured");
    expect(never.display).toBeNull();
  });

  it("separates no-heals-needed from nothing-has-run", () => {
    const clean = summariseHeals([], [run({ id: "r1" })]);
    expect(clean.state).toBe("clean");
    expect(clean.display).toBe("0");

    const never = summariseHeals([], []);
    expect(never.state).toBe("unmeasured");
    expect(never.display).toBeNull();
  });

  it("separates a settled suite from one with too few runs to judge", () => {
    const settled = summariseStability(
      flake({ analysedTests: 4, windowRuns: 20, tests: [testFlake({ verdict: "stable" })] }),
    );
    expect(settled.state).toBe("clean");
    expect(settled.display).toBe("0");

    const tooFew = summariseStability(flake({ analysedTests: 0 }));
    expect(tooFew.state).toBe("unmeasured");
    expect(tooFew.display).toBeNull();
  });

  it("separates an empty metrics DB from an absent one", () => {
    // Both produce no rows. Only one of them is the user's to fix, and the
    // copy has to differ or the honest answer is indistinguishable from the
    // broken one.
    const empty = summariseSteps({ available: true, rows: [] });
    expect(empty.state).toBe("unmeasured");

    const absent = summariseSteps({ available: false, rows: [] });
    expect(absent.state).toBe("unavailable");
    expect(absent.say).toMatch(/aren.t available on this runtime/i);
    expect(empty.say).not.toBe(absent.say);
  });

  it("prints no number in either non-measured state, for every category", () => {
    // The general form of the rule, over every summary this module can produce
    // — so a category added later cannot quietly opt out of it.
    const all: CategorySummary[] = [
      summariseOutcomes([]),
      summariseStability(flake()),
      summariseHeals([], []),
      summariseA11y([]),
      summariseVisual([]),
      summariseSpeed({ available: false, cost: COST, rows: [], slowed: [] }),
      summariseSteps({ available: false, rows: [] }),
    ];
    for (const s of all) {
      expect(isMeasured(s.state), `${s.id} is not measured`).toBe(false);
      expect(s.display, `${s.id} prints no number`).toBeNull();
      expect(s.say.length, `${s.id} still says something`).toBeGreaterThan(0);
    }
  });
});

describe("the band counts categories, never their values", () => {
  const summary = (id: string, state: CategorySummary["state"]): CategorySummary =>
    ({ id, state, display: null, say: "", window: null, tone: null }) as CategorySummary;

  it("says all three things when all three are present", () => {
    const r = bandReading([
      summary("outcomes", "findings"),
      summary("stability", "findings"),
      summary("heals", "clean"),
      summary("visual", "clean"),
      summary("a11y", "unmeasured"),
    ]);
    expect(r.needAttention).toBe(2);
    expect(r.clean).toBe(2);
    expect(r.unmeasured).toBe(1);
    expect(r.sentence).toBe(
      "2 categories need attention, 2 are clean, and 1 has never been measured.",
    );
  });

  it("never folds never-measured into clean", () => {
    // The four-state rule at page level. A band that said "5 are clean" here
    // would be making the same claim the tiles are forbidden from making.
    const r = bandReading([summary("a11y", "unmeasured"), summary("visual", "unmeasured")]);
    expect(r.clean).toBe(0);
    expect(r.unmeasured).toBe(2);
    expect(r.sentence).not.toMatch(/clean/);
  });

  it("counts unavailable separately from unmeasured", () => {
    const r = bandReading([summary("steps", "unavailable"), summary("a11y", "unmeasured")]);
    expect(r.sentence).toMatch(/never been measured/);
    expect(r.sentence).toMatch(/cannot be reported on this machine/);
  });

  it("is singular for one", () => {
    expect(bandReading([summary("a11y", "findings")]).sentence).toBe(
      "1 category needs attention.",
    );
  });

  it("says so when nothing has been measured at all", () => {
    expect(bandReading([]).sentence).toBe("Nothing has been measured yet.");
    expect(bandReading([]).tone).toBeNull();
  });

  it("IGNORES the values entirely — the band is a count of states", () => {
    // The load-bearing property, asserted directly: two boards with wildly
    // different numbers but the same states must read identically. If anyone
    // ever sums or scores across categories, this is what goes red.
    const small = bandReading([
      { ...summary("a11y", "findings"), display: "1" },
      { ...summary("heals", "clean"), display: "0" },
    ]);
    const huge = bandReading([
      { ...summary("a11y", "findings"), display: "9412" },
      { ...summary("heals", "clean"), display: "0" },
    ]);
    expect(small.sentence).toBe(huge.sentence);
    expect(small.tone).toBe(huge.tone);
  });
});

describe("the numbers themselves", () => {
  it("reads the outcomes tone off the RATE, not the count of failures", () => {
    // One failure in four hundred and one in four are not the same news, and a
    // tone driven by the count cannot tell them apart.
    const many = [...Array(399)].map((_, i) => run({ id: `p${i}` }));
    const rare = summariseOutcomes([...many, run({ id: "f", status: "failed" })]);
    expect(rare.state).toBe("findings");
    expect(rare.tone).toBe("amber");

    const often = summariseOutcomes([
      run({ id: "p", status: "passed" }),
      run({ id: "f1", status: "failed" }),
      run({ id: "f2", status: "failed" }),
      run({ id: "f3", status: "failed" }),
    ]);
    expect(often.tone).toBe("red");
  });

  it("keeps baseline updates out of the outcome rate", () => {
    // Their `status` is incidental — they are events, not executions, and
    // counting them would inflate the pass rate on any test with a pinned
    // baseline.
    const s = summariseOutcomes([
      run({ id: "r1", status: "failed" }),
      run({ id: "b1", status: "passed", kind: "baseline-update" }),
    ]);
    expect(s.display).toBe("0%");
    expect(s.window).toBe("1 run");
  });

  it("goes red for stability only when something broke and stayed broken", () => {
    const flaky = summariseStability(
      flake({ analysedTests: 3, windowRuns: 20, tests: [testFlake({ verdict: "flaky" })] }),
    );
    expect(flaky.tone).toBe("amber");

    const broken = summariseStability(
      flake({ analysedTests: 3, windowRuns: 20, tests: [testFlake({ verdict: "changed-since" })] }),
    );
    expect(broken.tone).toBe("red");
  });

  it("never goes red for accessibility, which is reported and not enforced", () => {
    // A11y findings do not decide whether a test passes. A red tile beside a
    // red Outcomes tile would claim they do.
    const s = summariseA11y([run({ id: "r1", a11yChecks: 9, a11yNewSteps: 40 })]);
    expect(s.state).toBe("findings");
    expect(s.tone).toBe("amber");
  });

  it("counts only the latest CHECKED run per test", () => {
    // The rule a11y-panel.tsx follows. Without it, running one test with the
    // toggle off drops the tile from "14 steps" to "clean" while the violations
    // are still there.
    const s = summariseA11y([
      run({ id: "old", testId: "t1", startedAt: 1000, a11yChecks: 5, a11yNewSteps: 3 }),
      run({ id: "new", testId: "t1", startedAt: 2000 }), // toggle off — ignored
      run({ id: "other", testId: "t2", startedAt: 1500, a11yChecks: 5, a11yNewSteps: 2 }),
    ]);
    expect(s.display).toBe("5");
    expect(s.window).toBe("2 tests checked");
  });

  it("counts a step as unhealthy on any of failing, healing or throwing", () => {
    const rows = [
      { stepId: "a", failed: 0, heals: 0, pageErrors: 0 },
      { stepId: "b", failed: 2, heals: 0, pageErrors: 0 },
      { stepId: "c", failed: 0, heals: 1, pageErrors: 0 },
      { stepId: "d", failed: 0, heals: 0, pageErrors: 4 },
    ] as never[];
    const s = summariseSteps({ available: true, rows });
    expect(s.display).toBe("3");
    expect(s.window).toBe("4 steps tracked");
  });

  it("counts only pending heals, not settled ones", () => {
    const s = summariseHeals(
      [
        heal({ id: "h1", status: "pending" }),
        heal({ id: "h2", status: "accepted" }),
        heal({ id: "h3", status: "reverted" }),
      ],
      [run({ id: "r1" })],
    );
    expect(s.display).toBe("1");
    expect(s.window).toBe("3 heals recorded");
  });

  it("reports the metrics DB as unavailable rather than as no slowdowns", () => {
    const s = summariseSpeed({ available: false, cost: COST, rows: [], slowed: [] });
    expect(s.state).toBe("unavailable");
    expect(s.display).toBeNull();
  });
});

describe("the registry", () => {
  it("gives every category an unmeasured sentence", () => {
    // The type already requires it; this proves none is an empty string, which
    // would render as a blank tile and read as a bug rather than as a prompt.
    for (const c of CATEGORIES) {
      expect(c.unmeasured.length, `${c.id} says what to do`).toBeGreaterThan(10);
      expect(c.label.length, `${c.id} has a label`).toBeGreaterThan(0);
      expect(c.unit.length, `${c.id} names its unit`).toBeGreaterThan(0);
    }
  });

  it("has unique ids", () => {
    expect(new Set(CATEGORIES.map((c) => c.id)).size).toBe(CATEGORIES.length);
  });

  it("recognises its own ids and rejects anything else", () => {
    // Route params are strings out of history — an unknown one has to be
    // rejectable rather than crash a dashboard.
    for (const c of CATEGORIES) expect(isCategoryId(c.id)).toBe(true);
    expect(isCategoryId("outcome")).toBe(false);
    expect(isCategoryId("__proto__")).toBe(false);
    expect(categoryMeta("nope")).toBeNull();
  });

  it("omits a category whose query has not resolved, rather than calling it unmeasured", () => {
    // "Loading" and "you have never switched this on" are different sentences,
    // and flashing the second at someone who switched it on last week is the
    // file's own rule breaking on a technicality.
    const partial = summariseAll({ runs: [run({ id: "r1" })] });
    const ids = partial.map((s) => s.id);
    expect(ids).toContain("outcomes");
    expect(ids).toContain("a11y");
    expect(ids).not.toContain("stability");
    expect(ids).not.toContain("steps");
  });

  it("returns summaries in registry order", () => {
    const all = summariseAll({
      runs: [run({ id: "r1" })],
      flake: flake({ analysedTests: 2, windowRuns: 10 }),
      heals: [],
      replays: [],
      stepHealth: { available: true, rows: [] },
      slowness: { available: true, cost: COST, rows: [], slowed: [] },
    });
    expect(all.map((s) => s.id)).toEqual(CATEGORIES.map((c) => c.id));
  });
});
