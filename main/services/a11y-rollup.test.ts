// The suite-wide accessibility rollup, and the run selection under it.
//
// This is the file that matters most for the a11y category, because what it
// guards is a WRONG NUMBER rather than a broken render — and a wrong number is
// exactly what a component test is worst at noticing. Every case below was
// written against a specific way of being confidently wrong:
//
//   - counting accepted violations, which makes a real site report dozens of
//     findings the user already dismissed;
//   - counting a run that had the toggle on but completed no checks, which
//     turns a broken fixture into a clean bill of health;
//   - counting an older run of the same test, which blanks findings that are
//     still true the moment somebody runs one test without a11y on.

import { describe, it, expect } from "vitest";

import { rollupA11y, selectLatestA11yRuns, keysOf, violationKey } from "../../shared/a11y-rollup.mjs";

function violation(over: Partial<{ id: string; impact: string; help: string; nodes: string[] }> = {}) {
  return {
    id: "color-contrast",
    impact: "serious",
    help: "Elements must have sufficient colour contrast",
    nodes: [".a"],
    ...over,
  };
}

/** A step carrying violations, with every one of them counted as new unless
 *  `newKeys` says otherwise. */
function step(
  violations: ReturnType<typeof violation>[],
  over: Partial<{ stepId: string; label: string; index: number; newKeys: string[] }> = {},
) {
  const allKeys = violations.flatMap((v) => keysOf(v));
  return {
    stepId: over.stepId ?? "s1",
    label: over.label ?? "click Submit",
    index: over.index ?? 0,
    a11y: { violations, newKeys: over.newKeys ?? allKeys },
  };
}

function run(steps: ReturnType<typeof step>[], over: Partial<{ testId: string; testName: string; runId: string }> = {}) {
  return {
    testId: over.testId ?? "t1",
    testName: over.testName ?? "Checkout",
    runId: over.runId ?? "r1",
    startedAt: 1_700_000_000_000,
    steps,
  };
}

describe("violation identity", () => {
  it("keys on the rule AND the node, not the rule alone", () => {
    // Keying on the rule would make accepting one low-contrast label accept
    // every future contrast failure on the page.
    expect(violationKey("color-contrast", ".a")).not.toBe(violationKey("color-contrast", ".b"));
  });

  it("gives a violation with no nodes exactly one key", () => {
    expect(keysOf({ id: "region" })).toEqual([violationKey("region", "")]);
  });
});

describe("selectLatestA11yRuns", () => {
  const base = { startedAt: 0, a11yChecks: 3 };

  it("takes the most recent run per test", () => {
    const picked = selectLatestA11yRuns([
      { ...base, testId: "t1", startedAt: 100 },
      { ...base, testId: "t1", startedAt: 300 },
      { ...base, testId: "t2", startedAt: 200 },
    ]);
    expect(picked.map((r) => r.startedAt).sort()).toEqual([200, 300]);
  });

  it("ignores a run that completed no checks, however recent", () => {
    // A run with the toggle on that checked nothing is a FAULT. Letting it win
    // would blank a test's findings and report the result as clean.
    const picked = selectLatestA11yRuns([
      { ...base, testId: "t1", startedAt: 100, a11yChecks: 4 },
      { ...base, testId: "t1", startedAt: 900, a11yChecks: 0 },
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0].startedAt).toBe(100);
  });

  it("ignores baseline updates, which are events rather than runs", () => {
    const picked = selectLatestA11yRuns([
      { ...base, testId: "t1", startedAt: 100 },
      { ...base, testId: "t1", startedAt: 900, kind: "baseline-update" },
    ]);
    expect(picked[0].startedAt).toBe(100);
  });

  it("returns nothing when nothing ever checked", () => {
    expect(selectLatestA11yRuns([{ testId: "t1", startedAt: 5 }])).toEqual([]);
  });
});

describe("rollupA11y", () => {
  it("reports nothing for runs with no unaccepted violations", () => {
    const rolled = rollupA11y([run([step([violation()], { newKeys: [] })])]);
    expect(rolled.stepsWithNew).toBe(0);
    expect(rolled.rules).toEqual([]);
    // Still one checked run — "measured and clean" is not "never measured".
    expect(rolled.checkedRuns).toBe(1);
  });

  it("counts only violations that are NEW", () => {
    // Two rules on one step, one of them already accepted. Counting both is the
    // failure that makes the feature unreadable against a real site.
    const accepted = violation({ id: "region", nodes: ["body"] });
    const fresh = violation({ id: "label", impact: "critical", nodes: ["#email"] });
    const rolled = rollupA11y([
      run([step([accepted, fresh], { newKeys: keysOf(fresh) })]),
    ]);
    expect(rolled.stepsWithNew).toBe(1);
    expect(rolled.rules.map((r) => r.id)).toEqual(["label"]);
  });

  it("counts one step under every severity it carries, and says so by not summing", () => {
    // The overlap is deliberate: filing a step under its worst severity only
    // would hide the moderate rule sharing a step with a critical one.
    const critical = violation({ id: "label", impact: "critical", nodes: ["#a"] });
    const moderate = violation({ id: "tabindex", impact: "moderate", nodes: ["#b"] });
    const rolled = rollupA11y([run([step([critical, moderate])])]);

    expect(rolled.stepsWithNew).toBe(1);
    const at = (i: string) => rolled.byImpact.find((b) => b.impact === i)!.steps;
    expect(at("critical")).toBe(1);
    expect(at("moderate")).toBe(1);
    // The point of the case: the impacts add to more than the headline.
    expect(at("critical") + at("moderate")).toBeGreaterThan(rolled.stepsWithNew);
  });

  it("counts a step once per severity however many violations of it there are", () => {
    const one = violation({ id: "label", impact: "critical", nodes: ["#a"] });
    const two = violation({ id: "aria-roles", impact: "critical", nodes: ["#b"] });
    const rolled = rollupA11y([run([step([one, two])])]);
    expect(rolled.byImpact.find((b) => b.impact === "critical")!.steps).toBe(1);
    expect(rolled.byImpact.find((b) => b.impact === "critical")!.rules).toBe(2);
  });

  it("counts offending nodes, not just steps", () => {
    const many = violation({ nodes: [".a", ".b", ".c"] });
    const rolled = rollupA11y([run([step([many])])]);
    expect(rolled.rules[0].steps).toBe(1);
    expect(rolled.rules[0].nodes).toBe(3);
  });

  it("counts only the unaccepted nodes of a partly-accepted rule", () => {
    const v = violation({ nodes: [".a", ".b", ".c"] });
    const rolled = rollupA11y([run([step([v], { newKeys: [violationKey(v.id, ".b")] })])]);
    expect(rolled.rules[0].nodes).toBe(1);
  });

  it("aggregates one rule across tests and remembers where each hit", () => {
    const v = violation();
    const rolled = rollupA11y([
      run([step([v])], { testId: "t1", testName: "Checkout", runId: "r1" }),
      run([step([v], { stepId: "s2" })], { testId: "t2", testName: "Login", runId: "r2" }),
    ]);
    expect(rolled.rules).toHaveLength(1);
    expect(rolled.rules[0].steps).toBe(2);
    expect(rolled.rules[0].where.map((w) => w.testId)).toEqual(["t1", "t2"]);
    expect(rolled.rules[0].where.map((w) => w.testName)).toEqual(["Checkout", "Login"]);
  });

  it("orders rules worst severity first, then by how many steps they hit", () => {
    const rolled = rollupA11y([
      run([
        step([violation({ id: "minor-one", impact: "minor", nodes: ["#m"] })], { stepId: "s1" }),
        step([violation({ id: "crit", impact: "critical", nodes: ["#c"] })], { stepId: "s2" }),
        step([violation({ id: "ser-a", impact: "serious", nodes: ["#x"] })], { stepId: "s3" }),
        step([violation({ id: "ser-a", impact: "serious", nodes: ["#y"] })], { stepId: "s4" }),
        step([violation({ id: "ser-b", impact: "serious", nodes: ["#z"] })], { stepId: "s5" }),
      ]),
    ]);
    expect(rolled.rules.map((r) => r.id)).toEqual(["crit", "ser-a", "ser-b", "minor-one"]);
  });

  it("files an unrecognised severity under minor rather than dropping it", () => {
    // axe's vocabulary is not ours to police, and a violation that vanished
    // because of an unexpected string is the worst possible handling.
    const rolled = rollupA11y([run([step([violation({ impact: "catastrophic" })])])]);
    expect(rolled.byImpact.find((b) => b.impact === "minor")!.steps).toBe(1);
    expect(rolled.rules[0].impact).toBe("minor");
  });

  it("survives a step with no a11y result at all", () => {
    const rolled = rollupA11y([{ testId: "t1", runId: "r1", steps: [{ stepId: "s1" }] }]);
    expect(rolled.stepsWithNew).toBe(0);
  });

  it("reports every severity even when nothing is at it", () => {
    // The dashboard draws a row per severity; a missing key would render as a
    // gap rather than as a zero.
    const rolled = rollupA11y([]);
    expect(rolled.byImpact.map((b) => b.impact)).toEqual([
      "critical",
      "serious",
      "moderate",
      "minor",
    ]);
    expect(rolled.byImpact.every((b) => b.steps === 0)).toBe(true);
  });
});
