// The Speed & cost dashboard.
//
// THE TEST THAT MATTERS HERE IS THE UNAVAILABLE ONE. `SuiteCostPanel` renders
// nothing at all when the metrics DB cannot be opened, so a dashboard that
// simply passed the flag through would show an empty screen — which reads as
// "no slow steps", a confident all-clear over a measurement that never
// happened. Both the dashboard and its leaf must say the sentence.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { StepDurationRow } from "../../../shared/metrics-query.mjs";
import type { CostBreakdown } from "../../../shared/step-insights.mjs";
import { SpeedDashboard, SpeedLeaf, type Slowness } from "./speed-dashboard";

const COST: CostBreakdown = {
  runs: 12,
  totalMs: 120_000,
  captureMs: 20_000,
  a11yMs: 10_000,
  instrumentedMs: 30_000,
  otherMs: 90_000,
  instrumentedShare: 0.25,
  shots: 40,
  bySpeed: [],
};

function durationRow(over: Partial<StepDurationRow> & { stepId: string }): StepDurationRow {
  return {
    label: "click Submit",
    type: "click",
    testId: "t1",
    testName: "Checkout",
    recentRuns: 5,
    previousRuns: 5,
    recentP50Ms: 4000,
    recentP95Ms: 5000,
    previousP50Ms: 2000,
    changeRatio: 2,
    ...over,
  };
}

function slowness(over: Partial<Slowness> = {}): Slowness {
  return { available: true, cost: COST, rows: [], slowed: [], ...over };
}

describe("SpeedDashboard", () => {
  it("says the metrics DB cannot answer, rather than rendering an empty screen", () => {
    render(<SpeedDashboard slowness={slowness({ available: false })} onDrill={vi.fn()} />);
    expect(screen.getByText(/aren’t available on this runtime/i)).toBeTruthy();
    // And no count anywhere, because nothing was measured.
    expect(screen.queryByRole("button", { name: /got slower/i })).toBeNull();
  });

  it("distinguishes 'nothing timed yet' from 'nothing got slower'", () => {
    const { rerender } = render(
      <SpeedDashboard
        slowness={slowness({ cost: { ...COST, runs: 0 } })}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.getByText(/no run has been timed yet/i)).toBeTruthy();

    rerender(<SpeedDashboard slowness={slowness()} onDrill={vi.fn()} />);
    const row = screen.getByRole("button", { name: /got slower/i });
    expect(row.textContent).toContain("0");
  });

  it("counts the steps that got slower and drills into them", () => {
    const onDrill = vi.fn();
    render(
      <SpeedDashboard
        slowness={slowness({ slowed: [durationRow({ stepId: "s1" })] })}
        onDrill={onDrill}
      />,
    );
    const row = screen.getByRole("button", { name: /got slower/i });
    expect(row.textContent).toContain("1");
    fireEvent.click(row);
    expect(onDrill).toHaveBeenCalledWith("slower");
  });
});

describe("SpeedLeaf", () => {
  it("shows what a step used to take, what it takes now, and by how much", () => {
    const onOpenTest = vi.fn();
    render(
      <SpeedLeaf
        facet="slower"
        slowness={slowness({ slowed: [durationRow({ stepId: "s1", testId: "t4" })] })}
        onOpenTest={onOpenTest}
      />,
    );
    const detail = screen.getByText(/2\.0× slower/i).textContent ?? "";
    expect(detail).toContain("Checkout");
    expect(detail).toContain("→");

    fireEvent.click(screen.getByRole("button", { name: /open test/i }));
    expect(onOpenTest).toHaveBeenCalledWith("t4");
  });

  it("names a heal-orphaned step's deleted test rather than rendering null", () => {
    render(
      <SpeedLeaf
        facet="slower"
        slowness={slowness({ slowed: [durationRow({ stepId: "s1", testName: null })] })}
        onOpenTest={vi.fn()}
      />,
    );
    expect(screen.getByText(/deleted test/i)).toBeTruthy();
  });

  it("carries the unavailable sentence too", () => {
    // Reachable by typing the route while the DB is down.
    render(
      <SpeedLeaf facet="slower" slowness={slowness({ available: false })} onOpenTest={vi.fn()} />,
    );
    expect(screen.getByText(/aren’t available on this runtime/i)).toBeTruthy();
  });

  it("explains a breakdown it does not have", () => {
    render(<SpeedLeaf facet="sideways" slowness={slowness()} onOpenTest={vi.fn()} />);
    expect(screen.getByText(/not a Speed & cost breakdown/i)).toBeTruthy();
  });

  it("says so when no step has moved", () => {
    render(<SpeedLeaf facet="slower" slowness={slowness()} onOpenTest={vi.fn()} />);
    expect(screen.getByText(/no step’s median has moved/i)).toBeTruthy();
  });
});
