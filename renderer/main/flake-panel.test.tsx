// Component tests for the Stability panel.
//
// The analysis is tested in check:flake-analysis; what's tested here is whether
// the panel SAYS the right thing. That matters more than usual for this feature:
// the whole point is to replace a number nobody can act on with a word they can,
// so a panel that renders the verdict as an unlabelled percentage would be
// working correctly and still useless.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { FlakeReport, TestFlake } from "../lib/recorder-types";
import { FlakePanel } from "./flake-panel";

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
