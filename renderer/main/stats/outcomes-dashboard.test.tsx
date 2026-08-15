// The Outcomes dashboard — the chart, the cards, and the drill under them.
//
// The chart-above-cards test MOVED HERE from stats-view.test.tsx with the
// components themselves. Reading order is a property of the screen that renders
// them, and that is no longer the Stats landing.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import type { RunRecord } from "../../lib/recorder-types";
import { OutcomesDashboard, OutcomesLeaf, buildDailyBuckets } from "./outcomes-dashboard";

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

/** The KPI card with this label, as text.
 *
 *  SCOPED TO THE KPI ROW on purpose: "Failed" is also a word on the drill row
 *  below, and an unscoped `getByText` matches both and reports as "found
 *  multiple elements" — which reads as a duplicate-render bug rather than an
 *  ambiguous query. */
function card(label: string): string {
  const kpis = document.querySelector(".gl-kpis") as HTMLElement;
  return within(kpis).getByText(label).parentElement?.textContent ?? "";
}

describe("OutcomesDashboard", () => {
  it("explains itself with no runs instead of reporting 0%", async () => {
    // A pass rate of 0% and "you have not run anything" are different facts,
    // and only one of them is alarming.
    render(<OutcomesDashboard runs={[]} onDrill={vi.fn()} />);
    expect(screen.getByText(/no runs yet/i)).toBeTruthy();
    expect(screen.queryByText("Total runs")).toBeNull();
  });

  it("counts pass rate over executions only", async () => {
    render(
      <OutcomesDashboard
        runs={[
          run({ id: "r1", status: "passed" }),
          run({ id: "r2", status: "failed" }),
          // A baseline update is an event, not a run. Its `status` is
          // incidental and counting it moves a rate nothing executed changed.
          run({ id: "r3", status: "passed", kind: "baseline-update" }),
        ]}
        onDrill={vi.fn()}
      />,
    );
    expect(card("Total runs")).toContain("2");
    expect(card("Passed")).toContain("1");
    expect(card("Failed")).toContain("1");
  });

  it("leaves the pass rate to the category head above it", () => {
    // The head states it at 32px. A card repeating it two inches lower is the
    // same figure twice within one screenful.
    render(<OutcomesDashboard runs={[run({ id: "r1" })]} onDrill={vi.fn()} />);
    expect(screen.queryByText("Pass rate")).toBeNull();
  });

  it("puts the chart above the summary cards", () => {
    // The shape of the last week is the thing you can read without reading — a
    // rising red band answers "is something wrong?" before any number does.
    // Asserted by DOM order, since jsdom cannot see which is higher on screen.
    const { container } = render(
      <OutcomesDashboard runs={[run({ id: "r1" })]} onDrill={vi.fn()} />,
    );
    const chart = screen.getByText(/pass \/ fail over time/i).closest('[data-gl="panel"]')!;
    const cards = screen.getByText("Total runs").closest("div")!;
    const kids = Array.from(container.firstElementChild ? container.children : []);
    const idx = (el: Element) => kids.findIndex((k) => k.contains(el));
    expect(idx(chart)).toBeGreaterThanOrEqual(0);
    expect(idx(chart)).toBeLessThan(idx(cards));
  });

  it("drills into failed runs", () => {
    const onDrill = vi.fn();
    render(
      <OutcomesDashboard runs={[run({ id: "r1", status: "failed" })]} onDrill={onDrill} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /failed runs/i }));
    expect(onDrill).toHaveBeenCalledWith("failed");
  });

  it("hides capture overhead until something has been measured", () => {
    render(<OutcomesDashboard runs={[run({ id: "r1" })]} onDrill={vi.fn()} />);
    expect(screen.queryByText(/capture overhead/i)).toBeNull();
  });
});

describe("OutcomesLeaf", () => {
  it("lists the runs of one outcome, newest first, each exiting to its test", () => {
    const onOpenTest = vi.fn();
    render(
      <OutcomesLeaf
        facet="failed"
        runs={[
          run({ id: "r1", status: "failed", testId: "t1", testName: "Older", startedAt: 1 }),
          run({ id: "r2", status: "failed", testId: "t2", testName: "Newer", startedAt: 900 }),
          run({ id: "r3", status: "passed", testName: "Not this one" }),
        ]}
        onOpenTest={onOpenTest}
      />,
    );
    const rows = screen.getAllByRole("button", { name: /open test/i });
    expect(rows).toHaveLength(2);
    expect(screen.queryByText("Not this one")).toBeNull();

    // Newest first: after a failure the run you want is the one that just
    // happened.
    const names = screen.getAllByText(/Older|Newer/).map((n) => n.textContent);
    expect(names).toEqual(["Newer", "Older"]);

    fireEvent.click(rows[0]);
    expect(onOpenTest).toHaveBeenCalledWith("t2");
  });

  it("explains an outcome it does not have rather than rendering blank", () => {
    // Route params are strings out of history, so this is reachable.
    render(<OutcomesLeaf facet="sideways" runs={[]} onOpenTest={vi.fn()} />);
    expect(screen.getByText(/not a run outcome/i)).toBeTruthy();
  });

  it("says so when an outcome has no runs", () => {
    render(<OutcomesLeaf facet="failed" runs={[run({ id: "r1" })]} onOpenTest={vi.fn()} />);
    expect(screen.getByText(/no run has this outcome/i)).toBeTruthy();
  });
});

describe("buildDailyBuckets", () => {
  it("always returns seven days, so a gap reads as a gap", () => {
    const buckets = buildDailyBuckets([run({ id: "r1", startedAt: Date.now() })]);
    expect(buckets).toHaveLength(7);
    expect(buckets[6].passed).toBe(1);
    expect(buckets[0].passed + buckets[0].failed).toBe(0);
  });

  it("keeps baseline updates out of the chart", () => {
    const buckets = buildDailyBuckets([
      run({ id: "r1", startedAt: Date.now(), kind: "baseline-update" }),
    ]);
    expect(buckets.every((b) => b.passed === 0 && b.failed === 0)).toBe(true);
  });
});
