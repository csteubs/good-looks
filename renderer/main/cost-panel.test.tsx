// The Cost panel. REDESIGN §6.4.
//
// The arithmetic is tested in `renderer/lib/cost-model.test.ts`. What is here is
// the thing that makes the arithmetic trustworthy: the two assumptions are ON
// SCREEN, in prose, under the figures they produce, and the money figures say
// what currency they are in. A panel that showed the same numbers with its
// assumptions nowhere on it would pass every arithmetic test and still be the
// thing the plan warned against — "a number nobody can check is a number nobody
// believes".
//
// Where the assumptions are SET moved to Settings → Cost; that pane has its own
// tests. What must not move is the sentence, the symbol, and the way out.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { RunRecord } from "../lib/recorder-types";
import { COST_DEFAULTS } from "../lib/cost-model";
import { DENSE_PAGE_SIZE } from "../lib/paginate";
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

/** The IPC bridge, stubbed. The panel's only side effect is opening Settings. */
function stubIpc(): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async () => undefined);
  (window as unknown as { glazeAPI: unknown }).glazeAPI = { glaze: { ipc: { invoke } } };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as { glazeAPI?: unknown }).glazeAPI;
});

describe("the assumptions are the feature", () => {
  it("states both of them, in prose, under the figures they produce", () => {
    render(<CostPanel runs={[run({ id: "r1", startedAt: 1 })]} />);
    const line = screen.getByText(/Assumes/).textContent ?? "";
    expect(line).toContain(String(COST_DEFAULTS.costPerCiMinute));
    expect(line).toContain(String(COST_DEFAULTS.minutesPerManualRun));
  });

  it("states the price at full precision rather than rounding it to nothing", () => {
    // The rate is 0.008. Through the money formatter that is "<$0.01", which
    // turns the one sentence that makes the panel checkable into one that
    // withholds the number it exists to state.
    render(<CostPanel runs={[run({ id: "r1", startedAt: 1 })]} />);
    expect(screen.getByText(/Assumes/).textContent).toContain("$0.008");
  });

  it("admits the shipped numbers are guesses, and stops once they are not", () => {
    // The panel's credibility rests on saying so while they are its own.
    const shipped = render(<CostPanel runs={[run({ id: "r1", startedAt: 1 })]} />);
    expect(screen.getByText(/this app's guesses/i)).toBeTruthy();
    shipped.unmount();

    render(
      <CostPanel
        runs={[run({ id: "r1", startedAt: 1 })]}
        assumptions={{ costPerCiMinute: 0.062, minutesPerManualRun: 30 }}
      />,
    );
    expect(screen.queryByText(/this app's guesses/i)).toBeNull();
  });

  it("moves every figure when the persisted assumptions change", () => {
    // 10 runs of 1 minute each. The whole point is that a reader can do this
    // multiplication themselves from the sentence on screen.
    const runs = Array.from({ length: 10 }, (_, i) => run({ id: `r${i}`, startedAt: i }));
    render(
      <CostPanel runs={runs} assumptions={{ costPerCiMinute: 1, minutesPerManualRun: 60 }} />,
    );
    expect(figure(/CI spend/i)).toBe("$10.00");
    expect(figure(/Manual testing avoided/i)).toBe("10h");
  });

  it("offers a way to the pane that sets them, and lands on that pane", () => {
    // Not a bare "open Settings": the button's job is to answer "where do these
    // numbers come from", and dropping the reader on Appearance to go looking
    // is the scavenger hunt this panel's first design argued against.
    const invoke = stubIpc();
    render(<CostPanel runs={[run({ id: "r1", startedAt: 1 })]} />);
    fireEvent.click(screen.getByRole("button", { name: /edit in settings/i }));
    expect(invoke).toHaveBeenCalledWith("window:openSettings", "cost");
  });
});

describe("currency", () => {
  const runs = Array.from({ length: 10 }, (_, i) => run({ id: `r${i}`, startedAt: i }));
  const A = { costPerCiMinute: 1, minutesPerManualRun: 60 };

  it("stamps the chosen symbol on the money figures", () => {
    render(<CostPanel runs={runs} assumptions={A} currency="gbp" />);
    expect(figure(/CI spend/i)).toBe("£10.00");
    expect(screen.getByText(/Assumes/).textContent).toContain("£1");
  });

  it("leaves the time figures alone", () => {
    // Value is TIME here, not money — converting hours to cash needs an hourly
    // rate this app was never told. Only the ratio's denominator is a price.
    render(<CostPanel runs={runs} assumptions={A} currency="usd" />);
    expect(figure(/Manual testing avoided/i)).toBe("10h");
    expect(figure(/Manual testing avoided/i)).not.toContain("$");
    expect(figure(/Failures caught/i)).not.toContain("$");
    const ratio = document.querySelector(".gl-cost-figure-unit")?.textContent ?? "";
    expect(ratio).toContain("per $1 spent");
  });

  it("prints no symbol at all under `none`", () => {
    // The behaviour the panel shipped with, still reachable for a user whose
    // currency is not on the list.
    render(<CostPanel runs={runs} assumptions={A} currency="none" />);
    expect(figure(/CI spend/i)).toBe("10.00");
    expect(screen.getByText(/Assumes/).textContent).not.toMatch(/[$£€¥]/);
    const ratio = document.querySelector(".gl-cost-figure-unit")?.textContent ?? "";
    expect(ratio).toBe(" per 1 spent");
  });

  it("puts the symbol in the spend column too", () => {
    render(<CostPanel runs={runs} assumptions={A} currency="usd" />);
    const row = screen.getByText("Checkout").closest("tr") as HTMLElement;
    expect(within(row).getByText("$10.00")).toBeTruthy();
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

  describe("paging", () => {
    // One run each for N distinct tests, descending in duration so the order is
    // deterministic and page 2 holds the cheapest.
    const manyTests = (n: number): RunRecord[] =>
      Array.from({ length: n }, (_, i) =>
        run({
          id: `r${i}`,
          startedAt: i,
          testId: `t${i}`,
          testName: `Test ${String(i).padStart(2, "0")}`,
          durationMs: (n - i) * MIN,
        }),
      );

    const bodyRows = () => screen.getAllByRole("row").slice(1);

    it("shows nothing at all until there is more than one page", () => {
      // A pager over a three-row table is chrome for its own sake.
      render(<CostPanel runs={manyTests(3)} />);
      expect(screen.queryByLabelText("Next page")).toBeNull();
      expect(bodyRows()).toHaveLength(3);
    });

    it("cuts the table at 25 tests and says how many pages there are", () => {
      render(<CostPanel runs={manyTests(26)} />);
      expect(bodyRows()).toHaveLength(DENSE_PAGE_SIZE);
      expect(DENSE_PAGE_SIZE).toBe(25);
      expect(screen.getByText(/Page 1 of 2/)).toBeTruthy();
      expect(screen.getByText(/1–25 of 26 tests/)).toBeTruthy();
    });

    it("reaches the 26th test on the next page", () => {
      // The row that would be invisible if `size` were left at the Pager's
      // default: the counts would say one page and Next would never enable.
      render(<CostPanel runs={manyTests(26)} />);
      expect(screen.queryByText("Test 25")).toBeNull();
      fireEvent.click(screen.getByLabelText("Next page"));
      expect(screen.getByText("Test 25")).toBeTruthy();
      expect(bodyRows()).toHaveLength(1);
    });

    it("falls back to real rows when the list shrinks under the page you are on", () => {
      // Retention prunes runs and tests get deleted. An unclamped page renders
      // an empty table, which reads as "my history vanished".
      const many = render(<CostPanel runs={manyTests(60)} />);
      fireEvent.click(screen.getByLabelText("Next page"));
      fireEvent.click(screen.getByLabelText("Next page"));
      expect(screen.getByText(/Page 3 of 3/)).toBeTruthy();

      many.rerender(<CostPanel runs={manyTests(26)} />);
      expect(screen.getByText(/Page 2 of 2/)).toBeTruthy();
      expect(bodyRows().length).toBeGreaterThan(0);
    });
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
