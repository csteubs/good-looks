// The Accessibility dashboard and its severity leaf.
//
// The arithmetic behind these screens is tested where it lives, in
// main/services/a11y-rollup.test.ts. What is proved here is what the rollup
// cannot: that "never checked", "checked and clean" and "checked with findings"
// are three different screens rather than three renderings of zero, and that a
// rule firing on four tests is four rows you can act on rather than one row
// pointing at a test picked out of a hat.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { A11yRollup, A11yRuleRollup } from "../../../shared/a11y-rollup.mjs";
import { A11yDashboard, A11yLeaf, ruleRows } from "./a11y-dashboard";

function rule(over: Partial<A11yRuleRollup> & { id: string }): A11yRuleRollup {
  return {
    impact: "serious",
    help: "Elements must have sufficient colour contrast",
    steps: 1,
    nodes: 1,
    where: [
      {
        testId: "t1",
        testName: "Checkout",
        runId: "r1",
        startedAt: 1,
        stepId: "s1",
        stepLabel: "click Submit",
        index: 0,
        nodes: 1,
      },
    ],
    ...over,
  };
}

function rollup(over: Partial<A11yRollup> = {}): A11yRollup {
  return {
    checkedRuns: 2,
    stepsWithNew: 1,
    byImpact: [
      { impact: "critical", steps: 0, rules: 0 },
      { impact: "serious", steps: 1, rules: 1 },
      { impact: "moderate", steps: 0, rules: 0 },
      { impact: "minor", steps: 0, rules: 0 },
    ],
    rules: [rule({ id: "color-contrast" })],
    ...over,
  };
}

describe("A11yDashboard", () => {
  it("tells someone who has never run a check what to switch on", () => {
    render(
      <A11yDashboard
        rollup={rollup({ checkedRuns: 0, stepsWithNew: 0, rules: [] })}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.getByText(/switch on “check accessibility”/i)).toBeTruthy();
  });

  it("reports a clean result differently from a never-measured one", () => {
    // The four-state rule, restated inside the category: "nothing found" and
    // "nothing looked" must never produce the same screen.
    render(
      <A11yDashboard
        rollup={rollup({ checkedRuns: 3, stepsWithNew: 0, rules: [] })}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.getByText(/no unaccepted violations/i)).toBeTruthy();
    expect(screen.queryByText(/switch on/i)).toBeNull();
  });

  it("draws a row for every severity, including the empty ones", () => {
    render(<A11yDashboard rollup={rollup()} onDrill={vi.fn()} />);
    for (const label of ["Critical", "Serious", "Moderate", "Minor"]) {
      expect(screen.getByRole("button", { name: new RegExp(label, "i") })).toBeTruthy();
    }
  });

  it("states that a step can be under more than one severity", () => {
    render(<A11yDashboard rollup={rollup()} onDrill={vi.fn()} />);
    expect(screen.getByText(/a step can be in more than one/i)).toBeTruthy();
  });

  it("drills into a severity", () => {
    const onDrill = vi.fn();
    render(<A11yDashboard rollup={rollup()} onDrill={onDrill} />);
    fireEvent.click(screen.getByRole("button", { name: /serious/i }));
    expect(onDrill).toHaveBeenCalledWith("serious");
  });
});

describe("ruleRows", () => {
  it("splits one rule into a row per test", () => {
    const shared = rule({
      id: "color-contrast",
      steps: 3,
      nodes: 3,
      where: [
        { testId: "t1", testName: "Checkout", runId: "r1", startedAt: 1, stepId: "s1", stepLabel: null, index: 0, nodes: 1 },
        { testId: "t1", testName: "Checkout", runId: "r1", startedAt: 1, stepId: "s2", stepLabel: null, index: 1, nodes: 2 },
        { testId: "t2", testName: "Login", runId: "r2", startedAt: 2, stepId: "s1", stepLabel: null, index: 0, nodes: 4 },
      ],
    });
    const rows = ruleRows([shared]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ testId: "t1", steps: 2, nodes: 3 });
    expect(rows[1]).toMatchObject({ testId: "t2", steps: 1, nodes: 4 });
  });

  it("names a deleted test rather than rendering null", () => {
    const orphan = rule({
      id: "label",
      where: [
        { testId: "gone", testName: null, runId: "r1", startedAt: 1, stepId: "s1", stepLabel: null, index: 0, nodes: 1 },
      ],
    });
    expect(ruleRows([orphan])[0].testName).toBe("deleted test");
  });
});

describe("A11yLeaf", () => {
  it("lists the rules at one severity, naming the rule and its axe id", () => {
    render(<A11yLeaf facet="serious" rollup={rollup()} onOpenTest={vi.fn()} />);
    expect(screen.getByText(/sufficient colour contrast \(color-contrast\)/i)).toBeTruthy();
  });

  it("shows only the rules at the severity you opened", () => {
    const r = rollup({
      rules: [
        rule({ id: "color-contrast", impact: "serious" }),
        rule({ id: "label", impact: "critical", help: "Form elements must have labels" }),
      ],
    });
    render(<A11yLeaf facet="critical" rollup={r} onOpenTest={vi.fn()} />);
    expect(screen.getByText(/must have labels/i)).toBeTruthy();
    expect(screen.queryByText(/colour contrast/i)).toBeNull();
  });

  it("exits to the test the rule fires on", () => {
    const onOpenTest = vi.fn();
    render(<A11yLeaf facet="serious" rollup={rollup()} onOpenTest={onOpenTest} />);
    fireEvent.click(screen.getByRole("button", { name: /open test/i }));
    expect(onOpenTest).toHaveBeenCalledWith("t1");
  });

  it("explains a severity that is not one", () => {
    render(<A11yLeaf facet="catastrophic" rollup={rollup()} onOpenTest={vi.fn()} />);
    expect(screen.getByText(/not an accessibility severity/i)).toBeTruthy();
  });

  it("says so when a severity has nothing at it", () => {
    render(<A11yLeaf facet="minor" rollup={rollup()} onOpenTest={vi.fn()} />);
    expect(screen.getByText(/no unaccepted violation at this severity/i)).toBeTruthy();
  });

  it("carries no accept control", () => {
    // Stats reports; the test detail view acts. check:stats-categories proves
    // no mutation is imported; this proves none is offered.
    render(<A11yLeaf facet="serious" rollup={rollup()} onOpenTest={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^accept/i })).toBeNull();
  });
});
