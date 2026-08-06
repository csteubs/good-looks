// Tests for the renderer's pure accessibility helpers.
//
// `latestA11yRun` decides which run the Accessibility tab describes. Picking
// the wrong one is silent in the worst way: the panel renders perfectly and
// reports a run the user isn't thinking about.

import { describe, expect, it } from "vitest";

import { countA11ySteps, latestA11yRun, worstNewImpact, type A11yRunLike } from "./a11y-format";

function run(over: Partial<A11yRunLike> & { startedAt: number }): A11yRunLike {
  return { testId: "t1", ...over };
}

describe("latestA11yRun", () => {
  it("ignores runs belonging to other tests", () => {
    const mine = run({ startedAt: 10, a11yChecks: 2 });
    const theirs = run({ startedAt: 99, testId: "other", a11yChecks: 5 });
    expect(latestA11yRun([theirs, mine], "t1")).toBe(mine);
  });

  it("ignores runs that never checked", () => {
    const checked = run({ startedAt: 10, a11yChecks: 3 });
    const plain = run({ startedAt: 50 });
    expect(latestA11yRun([plain, checked], "t1")).toBe(checked);
  });

  it("counts a run where the check ran but completed nothing", () => {
    // The case that matters. axe executed and every check failed, so `a11yChecks`
    // is 0 while the time was still spent. Skipping it here would show the same
    // "nothing has been checked yet" empty state as a test with the feature
    // switched off — the two are opposite problems and must not look alike.
    const broken = run({ startedAt: 10, a11yMs: 1700, a11yChecks: 0 });
    expect(latestA11yRun([broken], "t1")).toBe(broken);
  });

  it("returns the newest, whatever order it was handed", () => {
    const older = run({ startedAt: 10, a11yChecks: 1 });
    const newer = run({ startedAt: 20, a11yChecks: 1 });
    expect(latestA11yRun([older, newer], "t1")).toBe(newer);
    expect(latestA11yRun([newer, older], "t1")).toBe(newer);
  });

  it("is null when this test has never been checked", () => {
    expect(latestA11yRun([run({ startedAt: 1 })], "t1")).toBeNull();
    expect(latestA11yRun([], "t1")).toBeNull();
  });
});

describe("countA11ySteps", () => {
  it("counts only steps with UNACCEPTED violations", () => {
    // An accepted violation is signed off; counting it would keep the tab
    // badged forever and train the user to ignore the number.
    expect(
      countA11ySteps([
        { a11y: { violations: [], newKeys: ["a|.x"], acceptedCount: 0 } },
        { a11y: { violations: [], newKeys: [], acceptedCount: 4 } },
        {},
      ]),
    ).toBe(1);
  });
});

describe("worstNewImpact mirrors the backend ranking", () => {
  it("ranks by severity, not by count", () => {
    expect(
      worstNewImpact({
        violations: [
          { id: "a", impact: "minor", help: "", nodes: [".1", ".2", ".3"] },
          { id: "b", impact: "critical", help: "", nodes: [".4"] },
        ],
        newKeys: ["a|.1", "a|.2", "a|.3", "b|.4"],
        acceptedCount: 0,
      }),
    ).toBe("critical");
  });
});
