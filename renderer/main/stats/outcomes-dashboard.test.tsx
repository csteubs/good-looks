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

  // ── The cards count every run; the lists count what survived the cap ──
  //
  // The run index is capped, so `runs.length` is the size of a cache, not the
  // size of a history. Counting it is what made this card climb to 1000 and
  // stop: the suite kept running and the headline number did not move.

  const TOTALS = { runs: 1240, passed: 1100, failed: 140, retained: 1000, pruned: 240, prunedDays: [] };

  it("states the lifetime total, not the length of the run list", () => {
    render(
      <OutcomesDashboard
        runs={[run({ id: "r1", status: "passed" }), run({ id: "r2", status: "failed" })]}
        totals={TOTALS}
        onDrill={vi.fn()}
      />,
    );
    expect(card("Total runs")).toContain("1,240");
    expect(card("Passed")).toContain("1,100");
    expect(card("Failed")).toContain("140");
    // The two retained runs are the whole run list. If the cards were counting
    // it, this is the number they would show.
    expect(card("Total runs")).not.toContain("2 ");
  });

  it("says out loud why the total is bigger than the lists below it", () => {
    // Two numbers disagreeing with no explanation reads as a bug in whichever
    // one the reader trusts less.
    render(
      <OutcomesDashboard runs={[run({ id: "r1" })]} totals={TOTALS} onDrill={vi.fn()} />,
    );
    expect(card("Total runs")).toContain("1,000 kept in history");
    expect(card("Total runs")).toContain("240 older runs");
  });

  it("says nothing about pruning when nothing has been pruned", () => {
    render(
      <OutcomesDashboard
        runs={[run({ id: "r1" })]}
        totals={{ runs: 1, passed: 1, failed: 0, retained: 1, pruned: 0, prunedDays: [] }}
        onDrill={vi.fn()}
      />,
    );
    expect(card("Total runs")).not.toMatch(/kept in history/);
  });

  it("counts the drill rows over the runs they can actually list", () => {
    // A row promising 140 failures and then opening a list of one is worse than
    // a row promising what it can deliver.
    render(
      <OutcomesDashboard
        runs={[run({ id: "r1", status: "failed" }), run({ id: "r2", status: "passed" })]}
        totals={TOTALS}
        onDrill={vi.fn()}
      />,
    );
    const row = screen.getByRole("button", { name: /failed runs/i });
    expect(row.textContent).toContain("1");
    expect(row.textContent).not.toContain("140");
  });

  it("falls back to the retained counts before the totals query resolves", () => {
    // `undefined` is "not loaded yet", and a card that renders 0 while waiting
    // reports a suite that has never run.
    render(
      <OutcomesDashboard
        runs={[run({ id: "r1", status: "passed" }), run({ id: "r2", status: "failed" })]}
        onDrill={vi.fn()}
      />,
    );
    expect(card("Total runs")).toContain("2");
  });

  it("still reports a history whose records have all been pruned", () => {
    // Every record gone to the cap, the counter intact. Counting the list here
    // renders "No runs yet" over a suite that has run a thousand times.
    render(
      <OutcomesDashboard
        runs={[]}
        totals={{ runs: 1000, passed: 900, failed: 100, retained: 0, pruned: 1000, prunedDays: [] }}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.queryByText(/no runs yet/i)).toBeNull();
    expect(card("Total runs")).toContain("1,000");
  });

  it("hides capture overhead until something has been measured", () => {
    render(<OutcomesDashboard runs={[run({ id: "r1" })]} onDrill={vi.fn()} />);
    expect(screen.queryByText(/capture overhead/i)).toBeNull();
  });
});

const REASONS = {
  builtin: [
    { id: "regression", name: "Site regression", description: "The site broke." },
    { id: "timing", name: "Timing issue", description: "Slower than the budget." },
  ],
  custom: [{ id: "c1", name: "Vendor outage", description: "Third party down." }],
};

describe("the failures-by-reason panel", () => {
  const LABELLED = [
    run({ id: "r1", status: "failed", failureReasonId: "regression", failureReasonBy: "auto" }),
    run({ id: "r2", status: "failed", failureReasonId: "regression", failureReasonBy: "user" }),
    run({ id: "r3", status: "failed", failureReasonId: "c1", failureReasonBy: "user" }),
    run({ id: "r4", status: "failed" }),
    run({ id: "r5", status: "passed" }),
  ];

  it("counts failed runs per reason, resolving custom names, uncategorized last", () => {
    render(<OutcomesDashboard runs={LABELLED} reasons={REASONS} onDrill={vi.fn()} />);
    const panel = screen.getByText("Failures by reason").closest(".gl-panel") as HTMLElement;
    const labels = within(panel)
      .getAllByRole("button")
      .map((b) => b.querySelector(".gl-drill-label")?.textContent);
    // Biggest first; the uncategorized bucket last regardless of size — it is
    // the to-do pile, not a leading cause.
    expect(labels).toEqual(["Site regression", "Vendor outage", "Uncategorized"]);
    expect(within(panel).getByText("2")).toBeTruthy();
  });

  it("drills into a reason facet, and into the uncategorized bucket", () => {
    const onDrill = vi.fn();
    render(<OutcomesDashboard runs={LABELLED} reasons={REASONS} onDrill={onDrill} />);
    fireEvent.click(screen.getByRole("button", { name: /site regression/i }));
    expect(onDrill).toHaveBeenCalledWith("reason-regression");
    fireEvent.click(screen.getByRole("button", { name: /uncategorized/i }));
    expect(onDrill).toHaveBeenCalledWith("reason-none");
  });

  it("shows a raw id the catalog no longer knows rather than dropping the runs", () => {
    render(
      <OutcomesDashboard
        runs={[run({ id: "r1", status: "failed", failureReasonId: "gone-id" })]}
        reasons={REASONS}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.getByText("gone-id")).toBeTruthy();
  });

  it("renders no reason panel without failures, or before the vocabulary loads", () => {
    render(
      <OutcomesDashboard runs={[run({ id: "r1" })]} reasons={REASONS} onDrill={vi.fn()} />,
    );
    expect(screen.queryByText("Failures by reason")).toBeNull();
    render(
      <OutcomesDashboard runs={[run({ id: "r2", status: "failed" })]} onDrill={vi.fn()} />,
    );
    expect(screen.queryByText("Failures by reason")).toBeNull();
  });
});

describe("OutcomesLeaf", () => {
  it("lists one reason's failed runs under the reason's name", () => {
    render(
      <OutcomesLeaf
        facet="reason-c1"
        runs={[
          run({ id: "r1", status: "failed", failureReasonId: "c1", testName: "Labelled" }),
          run({ id: "r2", status: "failed", testName: "Unlabelled" }),
        ]}
        reasons={REASONS}
        onOpenTest={vi.fn()}
      />,
    );
    expect(screen.getByText("Vendor outage")).toBeTruthy();
    expect(screen.getByText("Labelled")).toBeTruthy();
    expect(screen.queryByText("Unlabelled")).toBeNull();
  });

  it("lists the uncategorized bucket under its own title", () => {
    render(
      <OutcomesLeaf
        facet="reason-none"
        runs={[
          run({ id: "r1", status: "failed", testName: "Unlabelled" }),
          run({ id: "r2", status: "failed", failureReasonId: "timing", testName: "Labelled" }),
        ]}
        reasons={REASONS}
        onOpenTest={vi.fn()}
      />,
    );
    expect(screen.getByText("Uncategorized failures")).toBeTruthy();
    expect(screen.getByText("Unlabelled")).toBeTruthy();
    expect(screen.queryByText("Labelled")).toBeNull();
  });
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

  // A DAY WHOSE RECORDS WERE PRUNED IS NOT AN EMPTY DAY. Pruning takes the
  // OLDEST records, so on a suite that hits the cap inside a week these are the
  // early days of the week now on screen — and drawing them at zero shows a
  // suite that ramped up when it did nothing of the kind.

  /** Local midnight N days ago — the same bucketing the store writes. */
  function dayAgo(n: number): number {
    const d = new Date(Date.now() - n * 86_400_000);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  it("draws days whose runs were pruned", () => {
    const buckets = buildDailyBuckets(
      [run({ id: "r1", startedAt: Date.now() })],
      [{ dayStart: dayAgo(2), runs: 30, passed: 25, failed: 5 }],
    );
    expect(buckets).toHaveLength(7);
    expect(buckets[4]).toMatchObject({ passed: 25, failed: 5 });
    expect(buckets[6].passed).toBe(1);
  });

  it("adds pruned runs to a day that also has records", () => {
    // The boundary day: pruning stopped partway through it, so the bar is part
    // record and part counter and has to be their sum.
    const buckets = buildDailyBuckets(
      [run({ id: "r1", startedAt: dayAgo(1) + 3_600_000, status: "failed" })],
      [{ dayStart: dayAgo(1), runs: 9, passed: 7, failed: 2 }],
    );
    expect(buckets[5]).toMatchObject({ passed: 7, failed: 3 });
  });

  it("ignores pruned days older than the chart's window", () => {
    const buckets = buildDailyBuckets([], [{ dayStart: dayAgo(30), runs: 99, passed: 99, failed: 0 }]);
    expect(buckets.every((b) => b.passed === 0 && b.failed === 0)).toBe(true);
  });
});
