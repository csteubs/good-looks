// Component tests for the Stability panel.
//
// The analysis is tested in check:flake-analysis; what's tested here is whether
// the panel SAYS the right thing. That matters more than usual for this feature:
// the whole point is to replace a number nobody can act on with a word they can,
// so a panel that renders the verdict as an unlabelled percentage would be
// working correctly and still useless.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { MIN_RUNS_FOR_VERDICT } from "../lib/recorder-types";
import type { FlakeReport, StabilityVerdict, TestFlake } from "../lib/recorder-types";
import { FlakePanel, VERDICT_COPY } from "./flake-panel";

function test_(partial: Partial<TestFlake> = {}): TestFlake {
  return {
    testId: "t1",
    testName: "Checkout",
    runs: 8,
    passed: 4,
    failed: 4,
    transitions: 7,
    flakeRate: 1,
    verdict: "flaky",
    failingDatasets: [],
    failingBrowsers: [],
    steps: [],
    healedRuns: 0,
    ...partial,
  };
}

function report(partial: Partial<FlakeReport> = {}): FlakeReport {
  return {
    tests: [],
    clusters: [],
    analysedTests: 1,
    windowRuns: 20,
    windowCap: 200,
    ...partial,
  };
}

describe("FlakePanel", () => {
  it("renders nothing until a verdict means something", () => {
    // A "50% flaky" badge computed from two runs is noise wearing a statistic's
    // clothes — the panel stays away entirely rather than showing it.
    const { container } = render(<FlakePanel report={report({ analysedTests: 0 })} />);
    expect(container.firstChild).toBeNull();
  });

  it("names the problem in words, not just a percentage", () => {
    render(<FlakePanel report={report({ tests: [test_()] })} />);
    expect(screen.getByText("Flaky")).toBeTruthy();
  });

  it("calls a broken-and-stayed test a regression, not flake", () => {
    // Same pass rate as the flaky case above. Different word, because it's a
    // different problem with a different fix.
    render(
      <FlakePanel
        report={report({ tests: [test_({ verdict: "changed-since", transitions: 1 })] })}
      />,
    );
    expect(screen.getByText("Broke recently")).toBeTruthy();
    expect(screen.queryByText("Flaky")).toBeNull();
  });

  it("calls a row-specific failure data-dependent and names the row", () => {
    render(
      <FlakePanel
        report={report({
          tests: [
            test_({
              verdict: "data-dependent",
              failingDatasets: [{ id: "d3", name: "JPY", failed: 2, runs: 2 }],
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText("Data-dependent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("JPY")).toBeTruthy();
  });

  it("explains the verdict when expanded, rather than leaving it as jargon", () => {
    render(<FlakePanel report={report({ tests: [test_()] })} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/coin toss/i)).toBeTruthy();
    // And shows the measure it's actually based on.
    expect(screen.getByText(/Changed between passing and failing 7 times/i)).toBeTruthy();
  });

  it("hides stable tests by default, and can show them", () => {
    render(
      <FlakePanel
        report={report({
          tests: [test_({ testId: "a", testName: "Flaky one" }), test_({ testId: "b", testName: "Fine one", verdict: "stable" })],
          analysedTests: 2,
        })}
      />,
    );
    expect(screen.queryByText("Fine one")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /show all 2 tests/i }));
    expect(screen.getByText("Fine one")).toBeTruthy();
  });

  it("says so plainly when everything is healthy", () => {
    render(
      <FlakePanel report={report({ tests: [test_({ verdict: "stable" })] })} />,
    );
    expect(screen.getByText(/passing consistently/i)).toBeTruthy();
  });

  it("surfaces steps that keep needing to be healed", () => {
    // Distinct from failing: the step isn't breaking the run, its locator is
    // wrong and something keeps papering over it. Worth naming separately.
    render(
      <FlakePanel
        report={report({
          tests: [
            test_({
              healedRuns: 3,
              steps: [{ stepId: "s1", label: 'getByTestId("pay").click()', failures: 0, heals: 3, failureRate: 0 }],
            }),
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText('getByTestId("pay").click()')).toBeTruthy();
  });

  it("groups failure causes so one root cause reads as one problem", () => {
    render(
      <FlakePanel
        report={report({
          tests: [test_()],
          clusters: [
            {
              signature: "Error: Timeout <ms> exceeded",
              example: "Error: Timeout 30000ms exceeded waiting for locator('#pay')",
              stepId: "s2",
              stepLabel: 'getByTestId("pay").click()',
              count: 12,
              lastSeenAt: 1_700_000_000_000,
              runIds: [],
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Failure causes")).toBeTruthy();
    expect(screen.getByText("12 runs")).toBeTruthy();
    expect(screen.getByText(/Timeout 30000ms exceeded/)).toBeTruthy();
  });

  it("renders every row inline, with nothing scrolling inside the panel", () => {
    // The reported bug. The list was wrapped in a ScrollArea with only a
    // max-height, so it neither grew nor clipped — it overflowed and painted
    // over the "Show all" button and the Failure causes section below it.
    //
    // jsdom has no layout engine, so it cannot see that overlap. What it CAN
    // check is the structural cause: every row present in one container with no
    // scroller between them and the panel. The geometry itself is guarded at
    // source level by check:scroll-layout.
    const tests = Array.from({ length: 12 }, (_, i) =>
      test_({ testId: `t${i}`, testName: `Test ${i}` }),
    );
    const { container } = render(<FlakePanel report={report({ tests, analysedTests: 12 })} />);

    // All twelve are in the DOM — none dropped behind a fixed-height box.
    for (let i = 0; i < 12; i++) expect(screen.getByText(`Test ${i}`)).toBeTruthy();
    // And the content below them is a SIBLING of the list, not something the
    // list can overflow across.
    expect(container.querySelector("[data-radix-scroll-area-viewport]")).toBeNull();
  });

  it("keeps every other row reachable when one is expanded", () => {
    // "Doesn't resize when the details are expanded", concretely: after opening
    // a row, its detail AND all the other rows are still rendered. A fixed-height
    // scroller is what made this feel broken.
    const tests = Array.from({ length: 8 }, (_, i) =>
      test_({ testId: `t${i}`, testName: `Test ${i}` }),
    );
    render(<FlakePanel report={report({ tests, analysedTests: 8 })} />);

    const rows = screen.getAllByRole("button", { expanded: false });
    fireEvent.click(rows[0]);

    expect(screen.getByText(/coin toss/i)).toBeTruthy();
    for (let i = 0; i < 8; i++) expect(screen.getByText(`Test ${i}`)).toBeTruthy();
    // The rest stay collapsed — expanding one row must not open them all.
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(7);
  });

  it("says when the analysis window is capped", () => {
    // Presenting a truncated history as the whole one would quietly overstate
    // every verdict in the panel.
    render(<FlakePanel report={report({ tests: [test_()], windowRuns: 200, windowCap: 200 })} />);
    expect(screen.getByText(/capped at 200/i)).toBeTruthy();
  });

  it("does not claim a cap when the whole history fits", () => {
    render(<FlakePanel report={report({ tests: [test_()], windowRuns: 20, windowCap: 200 })} />);
    expect(screen.queryByText(/capped at/i)).toBeNull();
  });
});

// ── The verdict copy ─────────────────────────────────────────────────
// Asserted on the exported map rather than through the tooltip that shows it:
// the SDK's Tooltip is Radix-backed and CANNOT be opened under jsdom (its
// pointer tracking needs APIs jsdom doesn't implement), the same class of
// problem as the native-menu Select. Driving the hover is not on offer; the
// words being right is, and that is the part that can be wrong. The expanded
// row renders the same strings, and is covered below.
describe("verdict copy", () => {
  const VERDICTS: StabilityVerdict[] = [
    "flaky",
    "data-dependent",
    "changed-since",
    "still-failing",
    "fixed",
    "stable",
    "unknown",
  ];

  it("gives every verdict both a meaning and a rule", () => {
    for (const v of VERDICTS) {
      const copy = VERDICT_COPY[v];
      expect(copy.label.length, `${v} has a label`).toBeGreaterThan(0);
      expect(copy.hint.length, `${v} says what it means`).toBeGreaterThan(0);
      expect(copy.rule.length, `${v} says how it was decided`).toBeGreaterThan(0);
    }
  });

  it("explains the three mixed-result verdicts by FLIPS, not by pass rate", () => {
    // The whole reason these tooltips exist: flaky, broke-recently and fixed
    // can all sit at the same pass rate, and the thing that separates them is
    // how many times consecutive runs disagreed. A tooltip that talked about
    // percentages would explain the wrong mechanism convincingly.
    for (const v of ["flaky", "changed-since", "fixed"] as StabilityVerdict[]) {
      expect(VERDICT_COPY[v].rule, `${v} names flips`).toMatch(/flip/i);
      expect(VERDICT_COPY[v].rule, `${v} avoids talking about a rate`).not.toMatch(/rate|%/i);
    }
  });

  it("quotes the real minimum-runs threshold", () => {
    // MIN_RUNS_FOR_VERDICT is mirrored from the backend and pinned by
    // check:flake-analysis, so this copy can't drift from the analysis.
    expect(VERDICT_COPY.unknown.rule).toContain(String(MIN_RUNS_FOR_VERDICT));
  });

  it("distinguishes one flip that ended badly from one that ended well", () => {
    expect(VERDICT_COPY["changed-since"].rule).toMatch(/most recent run failed/i);
    expect(VERDICT_COPY.fixed.rule).toMatch(/most recent run passed/i);
  });

  it("shows the rule in the expanded row, where hover isn't available", () => {
    // The tooltip is mouse-only by construction (its trigger sits inside the
    // row's button, so it can't be focusable). The expanded body is the
    // keyboard and touch path to the same explanation.
    render(<FlakePanel report={report({ tests: [test_()] })} />);
    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]);
    expect(screen.getByText(VERDICT_COPY.flaky.rule)).toBeTruthy();
  });
});
