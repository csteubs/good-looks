// The Visual diff dashboard.
//
// The case this file exists for is the FIRST one: the dashboard counts the
// latest capture per test, exactly as the tile above it does. An older run of
// the same test still on disk must not add to either number, or the tile and
// the screen under it report different sizes for the same suite.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { RunReplaySummary } from "../../lib/recorder-types";
import { summariseVisual } from "../../lib/stats-categories";
import { VisualDashboard, VisualLeaf, capturesIn } from "./visual-dashboard";

function capture(over: Partial<RunReplaySummary> & { runId: string }): RunReplaySummary {
  return {
    testId: "t1",
    testName: "Checkout",
    status: "passed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    stepCount: 5,
    failedIndex: null,
    changedSteps: 0,
    ...over,
  };
}

describe("capturesIn", () => {
  it("reads only each test's latest capture", () => {
    const rows = [
      capture({ runId: "old", testId: "t1", startedAt: 1, changedSteps: 4 }),
      capture({ runId: "new", testId: "t1", startedAt: 900, changedSteps: 0 }),
    ];
    // The old run had changes; the current state of the test does not.
    expect(capturesIn(rows, "changed")).toHaveLength(0);
    expect(capturesIn(rows, "clean").map((r) => r.runId)).toEqual(["new"]);
  });

  it("agrees with the tile about the same fixture", () => {
    // The property the shared `latestCaptures` exists to hold. If these ever
    // disagree the board says one thing and its own dashboard says another.
    const rows = [
      capture({ runId: "a", testId: "t1", startedAt: 1, changedSteps: 9 }),
      capture({ runId: "b", testId: "t1", startedAt: 900, changedSteps: 2 }),
      capture({ runId: "c", testId: "t2", startedAt: 5, changedSteps: 0 }),
    ];
    const tile = summariseVisual(rows);
    const changed = capturesIn(rows, "changed");
    expect(tile.display).toBe("2");
    expect(changed).toHaveLength(1);
    expect(changed[0].changedSteps).toBe(2);
  });

  it("returns nothing for a state it does not have", () => {
    expect(capturesIn([capture({ runId: "a" })], "sideways")).toEqual([]);
  });
});

describe("VisualDashboard", () => {
  it("explains itself when nothing has been captured", () => {
    render(<VisualDashboard replays={[]} onDrill={vi.fn()} onOpenVisual={vi.fn()} />);
    expect(screen.getByText(/no test has been captured yet/i)).toBeTruthy();
  });

  it("splits captures into changed and clean", () => {
    render(
      <VisualDashboard
        replays={[
          capture({ runId: "a", testId: "t1", changedSteps: 3 }),
          capture({ runId: "b", testId: "t2", changedSteps: 0 }),
        ]}
        onDrill={vi.fn()}
        onOpenVisual={vi.fn()}
      />,
    );
    const changed = screen.getByRole("button", { name: /changed against baseline/i });
    expect(changed.textContent).toContain("1");
  });

  it("drills into a state", () => {
    const onDrill = vi.fn();
    render(
      <VisualDashboard
        replays={[capture({ runId: "a", changedSteps: 1 })]}
        onDrill={onDrill}
        onOpenVisual={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /changed against baseline/i }));
    expect(onDrill).toHaveBeenCalledWith("changed");
  });

  it("hands off to the view that can actually accept a baseline", () => {
    // Stats reports; Visual acts. The handoff is the positive half of that rule
    // — a dashboard that mutated nothing AND linked nowhere would satisfy
    // check:stats-categories while being a dead end.
    const onOpenVisual = vi.fn();
    render(
      <VisualDashboard
        replays={[capture({ runId: "a" })]}
        onDrill={vi.fn()}
        onOpenVisual={onOpenVisual}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open visual/i }));
    expect(onOpenVisual).toHaveBeenCalled();
  });

  it("carries no accept control of its own", () => {
    render(
      <VisualDashboard
        replays={[capture({ runId: "a", changedSteps: 2 })]}
        onDrill={vi.fn()}
        onOpenVisual={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /^accept/i })).toBeNull();
  });
});

describe("VisualLeaf", () => {
  it("lists the tests in a state and exits to each", () => {
    const onOpenTest = vi.fn();
    render(
      <VisualLeaf
        facet="changed"
        replays={[
          capture({ runId: "a", testId: "t7", testName: "Checkout", changedSteps: 2, stepCount: 6 }),
          capture({ runId: "b", testId: "t8", testName: "Login", changedSteps: 0 }),
        ]}
        onOpenTest={onOpenTest}
      />,
    );
    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.queryByText("Login")).toBeNull();
    expect(screen.getByText(/2 of 6 steps changed/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /open test/i }));
    expect(onOpenTest).toHaveBeenCalledWith("t7");
  });

  it("explains a state it does not have", () => {
    render(<VisualLeaf facet="sideways" replays={[]} onOpenTest={vi.fn()} />);
    expect(screen.getByText(/not a visual state/i)).toBeTruthy();
  });
});
