// Tests for the Stats pane.
//
// The readout is the reason the pane exists. "Total runs" on the Stats board
// read 1000 for as long as the run index was capped at 1000 records, because
// the count WAS the length of that list — and the difference between "1240 runs
// happened" and "1000 of them are still stored" is stated nowhere else in the
// app. Two numbers that must not be confused for each other, in the largest
// type on the pane, is exactly the shape that ships wrong and looks right.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { StatsPane } from "./stats-pane";

const TOTALS = { runs: 1240, passed: 1100, failed: 140, retained: 1000, pruned: 240, prunedDays: [] };

describe("the history readout", () => {
  it("leads with every run ever, not the number still stored", () => {
    renderPane(<StatsPane />, { controller: makeController({ runTotals: TOTALS }) });
    expect(screen.getByTestId("run-history-total").textContent).toBe("1,240");
  });

  it("says how many of them the app can still show you", () => {
    // Without this the pane states a total the Run history table cannot
    // produce, and the reader has to decide which of the two is broken.
    renderPane(<StatsPane />, { controller: makeController({ runTotals: TOTALS }) });
    expect(screen.getByText(/1,000 still stored, 240 counted but pruned/)).toBeTruthy();
  });

  it("says nothing about pruning when nothing has been pruned", () => {
    const runTotals = { runs: 12, passed: 12, failed: 0, retained: 12, pruned: 0, prunedDays: [] };
    renderPane(<StatsPane />, { controller: makeController({ runTotals }) });
    expect(screen.getByText(/all still stored/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/pruned/);
  });

  it("renders a placeholder rather than NaN before the counts arrive", () => {
    // `runTotals` is null for the first frame and stays null if the IPC call
    // fails. Formatting null would print "NaN" in the largest type here.
    renderPane(<StatsPane />);
    expect(screen.getByTestId("run-history-total").textContent).toBe("—");
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("reports a history whose records have all been pruned", () => {
    const runTotals = { runs: 800, passed: 800, failed: 0, retained: 0, pruned: 800, prunedDays: [] };
    renderPane(<StatsPane />, { controller: makeController({ runTotals }) });
    expect(screen.getByTestId("run-history-total").textContent).toBe("800");
  });
});

describe("the log budget", () => {
  it("is a separate dial from how many records are kept", () => {
    // The two were one number, which rationed a ~700-byte record at the rate of
    // the tens of KB of console output beside it.
    const controller = makeController();
    renderPane(<StatsPane />, { controller });
    const field = screen.getByLabelText(/keep console logs for/i) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "250" } });
    expect(savedPatch(controller)).toEqual({ runLogRetainedRuns: 250 });
  });

  it("accepts zero as a real choice rather than snapping to the default", () => {
    // Keep the records and their counts, keep no console output. The `|| default`
    // idiom the other numeric settings use would silently rewrite this to 1000.
    const controller = makeController();
    renderPane(<StatsPane />, { controller });
    fireEvent.change(screen.getByLabelText(/keep console logs for/i), { target: { value: "0" } });
    expect(savedPatch(controller)).toEqual({ runLogRetainedRuns: 0 });
  });

  it("clamps above the ceiling rather than storing it", () => {
    // A log with no record behind it is unreachable — nothing can open it.
    const controller = makeController();
    renderPane(<StatsPane />, { controller });
    fireEvent.change(screen.getByLabelText(/keep console logs for/i), {
      target: { value: "999999" },
    });
    expect(savedPatch(controller)).toEqual({ runLogRetainedRuns: 50_000 });
  });
});

describe("clearing the history", () => {
  it("keeps the logs when the user asked only to reset the stats", () => {
    // Two destructive controls one row apart, and the difference between them
    // is the entire distinction "stats" vs "logs" that this store is built on.
    const resetRunStats = vi.fn(async () => {});
    const deleteRunStatsAndLogs = vi.fn(async () => {});
    renderPane(<StatsPane />, {
      controller: makeController({ resetRunStats, deleteRunStatsAndLogs }),
    });
    fireEvent.click(screen.getByRole("button", { name: /^reset stats$/i }));
    expect(resetRunStats).toHaveBeenCalledTimes(1);
    expect(deleteRunStatsAndLogs).not.toHaveBeenCalled();
  });

  it("deletes both only from the control that says so", () => {
    const resetRunStats = vi.fn(async () => {});
    const deleteRunStatsAndLogs = vi.fn(async () => {});
    renderPane(<StatsPane />, {
      controller: makeController({ resetRunStats, deleteRunStatsAndLogs }),
    });
    fireEvent.click(screen.getByRole("button", { name: /delete everything/i }));
    expect(deleteRunStatsAndLogs).toHaveBeenCalledTimes(1);
    expect(resetRunStats).not.toHaveBeenCalled();
  });

  it("disables both while one of them is running", () => {
    // They write the same file. A second click mid-delete is a race over the
    // run index, and the readout above would be reporting a history that is
    // being rewritten underneath it.
    renderPane(<StatsPane />, { controller: makeController({ clearingRuns: true }) });
    expect((screen.getByRole("button", { name: /clearing/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /deleting/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
