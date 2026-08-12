// The Cost panel. REDESIGN §6.4.
//
// The arithmetic is tested in `renderer/lib/cost-model.test.ts`. What is here is
// the thing that makes the arithmetic trustworthy: the two assumptions are ON
// SCREEN, they are editable in place, and editing them moves the figures. A
// panel that showed the same numbers with its assumptions hidden in Settings
// would pass every arithmetic test and still be the thing the plan warned
// against — "a number nobody can check is a number nobody believes".

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { RunRecord } from "../lib/recorder-types";
import { COST_DEFAULTS } from "../lib/cost-model";
import { CostPanel, REVIEW_COPY } from "./cost-panel";

const MIN = 60_000;

function run(over: Partial<RunRecord> & { id: string; startedAt: number }): RunRecord {
  return {
    testId: "t1",
    testName: "Checkout",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    finishedAt: over.startedAt + MIN,
    durationMs: MIN,
    logFile: "/x.log",
    logBytes: 1,
    ...over,
  };
}

/** The value under a named figure.
 *
 *  Matched against the LABEL element rather than any text on the panel: the
 *  notes under these figures quote each other's words, and a loose `getByText`
 *  becomes ambiguous the moment one of them is reworded — which reports as
 *  "found multiple elements" from a test that is about arithmetic. */
function figure(label: RegExp): string {
  const el = [...document.querySelectorAll(".gl-cost-figure")].find((f) =>
    label.test(f.querySelector(".gl-cost-figure-label")?.textContent ?? ""),
  ) as HTMLElement | undefined;
  if (!el) throw new Error(`no figure labelled ${label}`);
  return (el.querySelector(".gl-cost-figure-value") as HTMLElement).textContent ?? "";
}

describe("the assumptions are the feature", () => {
  it("states both of them, in prose, under the figures they produce", () => {
    render(<CostPanel runs={[run({ id: "r1", startedAt: 1 })]} />);
    const line = screen.getByText(/Assuming/).textContent ?? "";
    expect(line).toContain(String(COST_DEFAULTS.costPerCiMinute));
    expect(line).toContain(String(COST_DEFAULTS.minutesPerManualRun));
  });

  it("admits the shipped numbers are guesses", () => {
    // The panel's credibility rests on saying so. It stops saying it once the
    // user has supplied their own.
    render(<CostPanel runs={[run({ id: "r1", startedAt: 1 })]} />);
    expect(screen.getByText(/this app's guesses/i)).toBeTruthy();
  });

  it("edits in place, and the figures move", () => {
    // 10 runs of 1 minute each. At the default rate the spend is trivial; at 1
    // per minute it is 10 — and the whole point is that a reader can do that
    // multiplication themselves.
    const runs = Array.from({ length: 10 }, (_, i) => run({ id: `r${i}`, startedAt: i }));
    render(<CostPanel runs={runs} />);
    fireEvent.click(screen.getByRole("button", { name: /edit these/i }));
    fireEvent.change(screen.getByLabelText("Cost per CI minute"), { target: { value: "1" } });
    expect(figure(/CI spend/i)).toBe("10.00");
    fireEvent.change(screen.getByLabelText("Minutes per manual run"), { target: { value: "60" } });
    expect(figure(/Manual testing avoided/i)).toBe("10h");
  });

  it("survives a cleared field instead of reporting a confident zero", () => {
    // Someone clearing the box to retype it must not make the panel claim the
    // suite is free — see `coerceAssumption`.
    const runs = Array.from({ length: 10 }, (_, i) => run({ id: `r${i}`, startedAt: i }));
    render(<CostPanel runs={runs} />);
    fireEvent.click(screen.getByRole("button", { name: /edit these/i }));
    fireEvent.change(screen.getByLabelText("Cost per CI minute"), { target: { value: "" } });
    expect(figure(/CI spend/i)).not.toBe("0.00");
  });

  it("resets to the shipped defaults", () => {
    render(<CostPanel runs={[run({ id: "r1", startedAt: 1 })]} />);
    fireEvent.click(screen.getByRole("button", { name: /edit these/i }));
    fireEvent.change(screen.getByLabelText("Cost per CI minute"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(screen.getByText(/Assuming/).textContent).toContain(
      String(COST_DEFAULTS.costPerCiMinute),
    );
  });
});

describe("the figures", () => {
  it("says nothing at all before anything has run", () => {
    // Not zeroes. "0.00 spent" and "nothing has run" are the same pixels and
    // only one of them is true.
    render(<CostPanel runs={[]} />);
    expect(screen.getByText(/Nothing has run yet/i)).toBeTruthy();
    expect(document.querySelector(".gl-cost-figures")).toBeNull();
  });

  it("reports no return at all rather than a ratio over zero", () => {
    render(<CostPanel runs={[run({ id: "r1", startedAt: 1, durationMs: 0 })]} />);
    expect(figure(/Return on spend/i)).toBe("—");
  });

  it("puts the flake figure in amber, and only when there is flake", () => {
    const clean = render(<CostPanel runs={[run({ id: "r1", startedAt: 1 })]} />);
    const value = () =>
      [...document.querySelectorAll(".gl-cost-figure")]
        .find((f) => /Spent on flake/i.test(f.querySelector(".gl-cost-figure-label")?.textContent ?? ""))!
        .querySelector(".gl-cost-figure-value") as HTMLElement;
    expect(value().style.color).toBe("");
    clean.unmount();

    render(
      <CostPanel
        runs={[
          run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 }),
          run({ id: "r2", startedAt: 2 }),
        ]}
      />,
    );
    // Amber is what this app spends on "worth your attention", and this is the
    // one figure that is a cost with nothing bought.
    expect(value().style.color).not.toBe("");
  });
});

describe("the spend table", () => {
  const flaky = [
    // Four failures, three of them followed by an identical-settings pass.
    ...[1, 3, 5].flatMap((i) => [
      run({ id: `f${i}`, startedAt: i, status: "failed", exitCode: 1 }),
      run({ id: `p${i}`, startedAt: i + 1 }),
    ]),
    run({ id: "f9", startedAt: 9, status: "failed", exitCode: 1 }),
  ];

  it("calls out a flaky test AND says why", () => {
    // A verdict with no reason is an assertion. The reason is what makes the
    // table checkable, so it is never behind a disclosure.
    render(<CostPanel runs={flaky} />);
    const row = screen.getByText("Checkout").closest("tr") as HTMLElement;
    expect(within(row).getByText("Review")).toBeTruthy();
    expect(screen.getByText(REVIEW_COPY.flaky)).toBeTruthy();
  });

  it("gives an ordinary test no tone at all", () => {
    // Colour means outcome here, and "behaving normally" is not an outcome — a
    // column of green chips would also drown the few rows this table exists to
    // surface.
    render(<CostPanel runs={[run({ id: "r1", startedAt: 1 })]} />);
    const chip = document.querySelector('[data-gl="status-chip"]') as HTMLElement;
    expect(chip.textContent).toBe("Earning");
    expect(chip.dataset.tone).toBe("neutral");
  });

  it("lists the dearest test first", () => {
    render(
      <CostPanel
        runs={[
          run({ id: "a", startedAt: 1, testId: "cheap", testName: "Cheap", durationMs: MIN }),
          run({ id: "b", startedAt: 2, testId: "dear", testName: "Dear", durationMs: 9 * MIN }),
        ]}
      />,
    );
    const names = screen.getAllByText(/Cheap|Dear/).map((e) => e.textContent);
    expect(names[0]).toBe("Dear");
  });
});
