// The three Phase 4 panels.
//
// The logic behind them is pinned by check:step-insights and check:metrics-db.
// What's covered here is the part that lives in the components, where being
// wrong is quiet — the panel renders, the numbers are plausible, and the reader
// draws the wrong conclusion:
//
//   • "Metrics are unavailable on this runtime" must not render as "you have no
//     history". One is nothing to fix, the other is an instruction to go and
//     run something.
//   • A NULL duration must render as a dash, never a zero. These columns get
//     sorted, and a fabricated 0 sorts to the top of "fastest".
//   • "No slowdowns" must not be claimed when nothing was comparable. On a young
//     history that is the normal case, and it reads as a clean bill of health.
//   • A count must travel with its denominator. "4 heals" means different things
//     across 5 runs and across 400.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import type { StepDurationRow, StepHealthRow } from "../../shared/metrics-query.mjs";
import type { CostBreakdown, DivergentStep } from "../../shared/step-insights.mjs";
import { DENSE_PAGE_SIZE } from "../lib/paginate";
import { StepHealthPanel, formatMs } from "./step-health-panel";
import { SuiteCostPanel, trendUnavailableReason } from "./suite-cost-panel";
import { DivergencePanel, VERDICT_COPY } from "./divergence-panel";

function health(over: Partial<StepHealthRow> = {}): StepHealthRow {
  return {
    stepId: "s1",
    label: "Click Pay",
    type: "click",
    testId: "t1",
    testName: "Checkout",
    runs: 20,
    failed: 0,
    failRate: 0,
    heals: 0,
    healFailures: 0,
    visualChanges: 0,
    a11yNew: 0,
    pageErrors: 0,
    timedRuns: 20,
    minMs: 120,
    maxMs: 800,
    lastSeenAt: 1,
    ...over,
  };
}

describe("step health", () => {
  it("distinguishes 'metrics are off' from 'you have no history'", () => {
    const { unmount } = render(<StepHealthPanel rows={[]} available={false} />);
    expect(screen.getByText(/aren’t available on this runtime/)).toBeTruthy();
    // Crucially NOT the "go and run a test" copy — there is nothing to run that
    // would fix it.
    expect(screen.queryByText(/Run a test and its steps/)).toBeNull();
    unmount();

    render(<StepHealthPanel rows={[]} available />);
    expect(screen.getByText(/Run a test and its steps/)).toBeTruthy();
  });

  it("shows the row the join exists to surface: healed often, never failed", () => {
    render(<StepHealthPanel rows={[health({ heals: 4, failed: 0, failRate: 0 })]} available />);
    // The heal count is visible against its denominator, and the fail column
    // stays empty — the whole point is that this row looks fine everywhere else.
    const row = screen.getByText("Click Pay").closest("tr")!;
    expect(within(row).getByText("4")).toBeTruthy();
    expect(within(row).getByText("/ 20")).toBeTruthy();
  });

  it("renders an unmeasured duration as a dash, never a zero", () => {
    // Asserted POSITIVELY — that the cell holds exactly a dash — after a
    // mutation showed the negative form ("no 0ms on screen") passing against a
    // component that had lost the guard entirely. Both halves are pinned: the
    // formatter's answer for null, and what the row actually renders.
    expect(formatMs(null)).toBe("—");

    render(
      <StepHealthPanel rows={[health({ timedRuns: 0, minMs: null, maxMs: null })]} available />,
    );
    const cells = screen.getByText("Click Pay").closest("tr")!.querySelectorAll("td");
    expect(cells[cells.length - 1].textContent).toBe("—");
  });

  it("still renders a measured range", () => {
    // The other direction: a step that HAS timings must not be dashed out,
    // which is what a guard written one character wrong would do.
    render(<StepHealthPanel rows={[health({ timedRuns: 20, minMs: 120, maxMs: 800 })]} available />);
    const cells = screen.getByText("Click Pay").closest("tr")!.querySelectorAll("td");
    expect(cells[cells.length - 1].textContent).toBe("120ms–800ms");
  });

  it("sorts by a column when its header is clicked", () => {
    render(
      <StepHealthPanel
        rows={[
          health({ stepId: "a", label: "Alpha", heals: 1 }),
          health({ stepId: "b", label: "Beta", heals: 9 }),
        ]}
        available
      />,
    );
    const labels = () => screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
    expect(labels()[0]).toContain("Alpha");

    fireEvent.click(screen.getByLabelText("Sort by Heals"));
    expect(labels()[0]).toContain("Beta");
  });

  // A 200-row table was the state before paging: everything on one page.
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      health({ stepId: `s${i}`, label: `Step ${String(i).padStart(3, "0")}`, heals: n - i }),
    );
  const bodyRows = () => screen.getAllByRole("row").slice(1);

  it("shows at most one page of steps, with the total still on the panel", () => {
    render(<StepHealthPanel rows={many(200)} available />);
    expect(bodyRows()).toHaveLength(DENSE_PAGE_SIZE);
    expect(DENSE_PAGE_SIZE).toBe(25);
    // The count in the panel header is the whole set, not the page — otherwise
    // paging looks like history disappearing.
    expect(screen.getByText("200 steps")).toBeTruthy();
    expect(screen.getByText(/Page 1 of 8/)).toBeTruthy();
    expect(screen.getByText(/1–25 of 200 steps/)).toBeTruthy();
  });

  it("pages through to the rows the first page doesn't hold", () => {
    render(<StepHealthPanel rows={many(200)} available />);
    expect(screen.queryByText("Step 025")).toBeNull();

    fireEvent.click(screen.getByLabelText("Next page"));
    expect(screen.getByText("Step 025")).toBeTruthy();
    expect(screen.queryByText("Step 024")).toBeNull();
    expect(bodyRows()).toHaveLength(DENSE_PAGE_SIZE);

    fireEvent.click(screen.getByLabelText("Previous page"));
    expect(screen.getByText("Step 024")).toBeTruthy();
  });

  it("sorts across every row, not just the page on screen", () => {
    // The failure this pins: sorting the 25 visible rows rather than all 200
    // ranks the wrong set, so the worst step in the suite stays invisible while
    // the column header claims to have ranked it.
    render(<StepHealthPanel rows={many(200)} available />);
    fireEvent.click(screen.getByLabelText("Sort by Heals")); // desc — most heals first
    expect(bodyRows()[0].textContent).toContain("Step 000");

    fireEvent.click(screen.getByLabelText("Sort by Heals")); // asc — fewest heals first
    // Step 199 has the fewest heals and lives on the last received page.
    expect(bodyRows()[0].textContent).toContain("Step 199");
  });

  it("returns to page 1 when the sort changes", () => {
    render(<StepHealthPanel rows={many(200)} available />);
    fireEvent.click(screen.getByLabelText("Next page"));
    expect(screen.getByText(/Page 2 of 8/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Sort by Heals"));
    expect(screen.getByText(/Page 1 of 8/)).toBeTruthy();
  });

  it("hides the pager when everything fits on one page", () => {
    render(<StepHealthPanel rows={many(25)} available />);
    expect(screen.queryByLabelText("Next page")).toBeNull();
    expect(bodyRows()).toHaveLength(25);
  });

  it("clamps a page that outlives its rows instead of rendering an empty table", () => {
    // Retention prunes and the row count drops under the page you were on.
    const { rerender } = render(<StepHealthPanel rows={many(200)} available />);
    fireEvent.click(screen.getByLabelText("Next page"));
    fireEvent.click(screen.getByLabelText("Next page"));
    expect(screen.getByText(/Page 3 of 8/)).toBeTruthy();

    rerender(<StepHealthPanel rows={many(30)} available />);
    expect(screen.getByText(/Page 2 of 2/)).toBeTruthy();
    expect(bodyRows()).toHaveLength(5);
  });
});

function duration(over: Partial<StepDurationRow> = {}): StepDurationRow {
  return {
    stepId: "s1",
    label: "Submit",
    type: "click",
    testId: "t1",
    testName: "Checkout",
    recentRuns: 5,
    previousRuns: 5,
    recentP50Ms: 4800,
    recentP95Ms: 5200,
    previousP50Ms: 1200,
    changeRatio: 4,
    ...over,
  };
}

const cost: CostBreakdown = {
  runs: 10,
  totalMs: 100_000,
  captureMs: 20_000,
  a11yMs: 10_000,
  shots: 40,
  bySpeed: [{ speed: "slow", runs: 10, totalMs: 100_000 }],
  instrumentedMs: 30_000,
  otherMs: 70_000,
  instrumentedShare: 0.3,
};

describe("suite cost", () => {
  it("names the instrumentation as a share, which is the actionable form", () => {
    render(<SuiteCostPanel cost={cost} rows={[duration()]} slowed={[duration()]} available />);
    expect(screen.getByText(/30%/)).toBeTruthy();
    expect(screen.getByText(/switch off/)).toBeTruthy();
  });

  it("reports the speed breakdown separately from the measured overhead", () => {
    render(<SuiteCostPanel cost={cost} rows={[duration()]} slowed={[]} available />);
    // The speed's own total, not the instrumentation figure — the two must not
    // be added together, since only one of them is measured. Matched on the
    // element's full text because the speed name is its own span (it is
    // capitalized in CSS, so the DOM still holds the lowercase value).
    // `getAllByText`, not `getByText`: the span and its wrapper both carry this
    // exact text, and an ambiguous getBy* retries until timeout and then reports
    // as "never rendered" — which reads as wrong copy rather than a loose query.
    expect(
      screen.getAllByText((_, el) => el?.textContent === "slow: 1m40s over 10 runs").length,
    ).toBeGreaterThan(0);
  });

  it("shows a slowdown with both ends of the comparison", () => {
    render(<SuiteCostPanel cost={cost} rows={[duration()]} slowed={[duration()]} available />);
    // Before AND after. "4.8s" alone does not say anything got worse.
    expect(screen.getByText(/1\.2s/)).toBeTruthy();
    expect(screen.getByText(/4\.8s/)).toBeTruthy();
    expect(screen.getByText(/4\.0×/)).toBeTruthy();
  });

  it("does not claim 'no slowdowns' when nothing was comparable", () => {
    // The normal state of a young history: every step has been run once, so
    // there is no previous window. Claiming a clean result here is the quiet
    // failure — it reads as reassurance.
    const young = [duration({ recentRuns: 1, previousRuns: 0, previousP50Ms: null, changeRatio: null })];
    render(<SuiteCostPanel cost={cost} rows={young} slowed={[]} available />);

    expect(screen.getByText(/nothing to compare/)).toBeTruthy();
    expect(screen.queryByText(/That is the good answer/)).toBeNull();
  });

  it("does say so when steps WERE comparable and none moved", () => {
    const steady = [duration({ changeRatio: 1.0, recentP50Ms: 1200 })];
    render(<SuiteCostPanel cost={cost} rows={steady} slowed={[]} available />);
    expect(screen.getByText(/That is the good answer/)).toBeTruthy();
  });

  it("explains the reason in the same words the helper returns", () => {
    const young = [duration({ recentRuns: 1, previousRuns: 0 })];
    expect(trendUnavailableReason(young)).toContain("timed runs");
    expect(trendUnavailableReason([duration()])).toBeNull();
  });
});

function divergent(over: Partial<DivergentStep> = {}): DivergentStep {
  return {
    stepId: "s1",
    testId: "t1",
    testName: "Checkout",
    label: "Click Pay",
    browsers: [
      { browser: "chromium", runs: 5, failed: 0 },
      { browser: "webkit", runs: 5, failed: 2 },
    ],
    verdict: "single-engine",
    failingBrowsers: ["webkit"],
    passingBrowsers: ["chromium"],
    ...over,
  };
}

describe("cross-browser divergence", () => {
  it("names both sides of the comparison", () => {
    render(<DivergencePanel steps={[divergent()]} available />);
    expect(screen.getByText(VERDICT_COPY["single-engine"], { exact: false })).toBeTruthy();
    expect(screen.getByText("webkit")).toBeTruthy();
    expect(screen.getByText("chromium")).toBeTruthy();
  });

  it("summarises single-engine steps as a count instead of listing them", () => {
    const steps = [
      divergent(),
      ...Array.from({ length: 30 }, (_, i) =>
        divergent({ stepId: `u${i}`, verdict: "insufficient", label: `Untested ${i}` }),
      ),
    ];
    render(<DivergencePanel steps={steps} available />);

    expect(screen.getByText(/30 steps have only ever run on one engine/)).toBeTruthy();
    // Not listed — a table where nine tenths of the rows say "we don't know"
    // trains people to stop reading it.
    expect(screen.queryByText("Untested 0")).toBeNull();
  });

  it("does not claim a clean bill of health for a one-engine suite", () => {
    const steps = [divergent({ verdict: "insufficient" })];
    render(<DivergencePanel steps={steps} available />);
    // The count is shown, but "no step disagrees" must not be, because nothing
    // has been compared.
    expect(screen.getByText(/only ever run on one engine/)).toBeTruthy();
    expect(screen.queryByText(/no step disagrees/)).toBeNull();
  });

  it("renders nothing at all when there is nothing to say", () => {
    const { container } = render(
      <DivergencePanel steps={[divergent({ verdict: "clean" })]} available />,
    );
    expect(container.textContent).toBe("");
  });
});
