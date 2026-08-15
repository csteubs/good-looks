// The Step health dashboard.
//
// Two properties worth pinning. The metrics-unavailable state must be SAID,
// not rendered as an empty list. And a step that is failing AND healing appears
// under both — the overlap is the honest shape, and a future "primary finding"
// rule that quietly picked one would hide the other.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { StepHealthRow } from "../../../shared/metrics-query.mjs";
import { StepsDashboard, StepsLeaf, stepsIn } from "./steps-dashboard";

function healthRow(over: Partial<StepHealthRow> & { stepId: string }): StepHealthRow {
  return {
    label: "click Submit",
    type: "click",
    testId: "t1",
    testName: "Checkout",
    runs: 10,
    failed: 0,
    failRate: 0,
    heals: 0,
    healFailures: 0,
    visualChanges: 0,
    a11yNew: 0,
    pageErrors: 0,
    timedRuns: 10,
    minMs: 100,
    maxMs: 200,
    lastSeenAt: 1_700_000_000_000,
    ...over,
  };
}

describe("stepsIn", () => {
  it("puts a step that fails AND heals in both lists", () => {
    const both = healthRow({ stepId: "s1", failed: 2, heals: 3 });
    expect(stepsIn([both], "failing")).toHaveLength(1);
    expect(stepsIn([both], "healing")).toHaveLength(1);
  });

  it("returns nothing for a finding it does not have", () => {
    expect(stepsIn([healthRow({ stepId: "s1", failed: 1 })], "sideways")).toEqual([]);
  });
});

describe("StepsDashboard", () => {
  it("says the metrics DB cannot answer, rather than reporting zero findings", () => {
    render(<StepsDashboard stepHealth={{ available: false, rows: [] }} onDrill={vi.fn()} />);
    expect(screen.getByText(/aren’t available on this runtime/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^failing/i })).toBeNull();
  });

  it("distinguishes 'no steps recorded' from 'no findings'", () => {
    const { rerender } = render(
      <StepsDashboard stepHealth={{ available: true, rows: [] }} onDrill={vi.fn()} />,
    );
    expect(screen.getByText(/no steps recorded yet/i)).toBeTruthy();

    rerender(
      <StepsDashboard
        stepHealth={{ available: true, rows: [healthRow({ stepId: "s1" })] }}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^failing/i }).textContent).toContain("0");
  });

  it("states that the three findings overlap", () => {
    // Without this the counts look like a broken partition of the headline.
    render(
      <StepsDashboard
        stepHealth={{ available: true, rows: [healthRow({ stepId: "s1", failed: 1, heals: 1 })] }}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.getByText(/a step can be in more than one/i)).toBeTruthy();
  });

  it("drills into a finding", () => {
    const onDrill = vi.fn();
    render(
      <StepsDashboard
        stepHealth={{ available: true, rows: [healthRow({ stepId: "s1", pageErrors: 4 })] }}
        onDrill={onDrill}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /throwing page errors/i }));
    expect(onDrill).toHaveBeenCalledWith("throwing");
  });
});

describe("StepsLeaf", () => {
  it("describes what the row contributes to the finding you opened", () => {
    const row = healthRow({ stepId: "s1", failed: 3, heals: 2, runs: 10 });
    const { rerender } = render(
      <StepsLeaf facet="failing" stepHealth={{ available: true, rows: [row] }} onOpenTest={vi.fn()} />,
    );
    expect(screen.getByText(/failed 3 of 10 runs/i)).toBeTruthy();

    rerender(
      <StepsLeaf facet="healing" stepHealth={{ available: true, rows: [row] }} onOpenTest={vi.fn()} />,
    );
    expect(screen.getByText(/healed 2 times/i)).toBeTruthy();
  });

  it("names the heals Auto-Heal could not rescue", () => {
    render(
      <StepsLeaf
        facet="healing"
        stepHealth={{
          available: true,
          rows: [healthRow({ stepId: "s1", heals: 2, healFailures: 1 })],
        }}
        onOpenTest={vi.fn()}
      />,
    );
    expect(screen.getByText(/could not be rescued/i)).toBeTruthy();
  });

  it("exits to the test that owns the step", () => {
    const onOpenTest = vi.fn();
    render(
      <StepsLeaf
        facet="failing"
        stepHealth={{ available: true, rows: [healthRow({ stepId: "s1", testId: "t9", failed: 1 })] }}
        onOpenTest={onOpenTest}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open test/i }));
    expect(onOpenTest).toHaveBeenCalledWith("t9");
  });

  it("falls back to the step's type, then its id, when it has no label", () => {
    render(
      <StepsLeaf
        facet="failing"
        stepHealth={{
          available: true,
          rows: [healthRow({ stepId: "s-42", label: null, type: null, failed: 1 })],
        }}
        onOpenTest={vi.fn()}
      />,
    );
    expect(screen.getByText("s-42")).toBeTruthy();
  });

  it("explains a finding it does not have", () => {
    render(
      <StepsLeaf facet="sideways" stepHealth={{ available: true, rows: [] }} onOpenTest={vi.fn()} />,
    );
    expect(screen.getByText(/not a step-health finding/i)).toBeTruthy();
  });

  it("carries the unavailable sentence too", () => {
    render(
      <StepsLeaf facet="failing" stepHealth={{ available: false, rows: [] }} onOpenTest={vi.fn()} />,
    );
    expect(screen.getByText(/aren’t available on this runtime/i)).toBeTruthy();
  });
});
