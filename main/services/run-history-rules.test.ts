// The pruning rules both writers now share.
//
// `check:mcp-run-history` proves the two PROCESSES agree end-to-end. These
// cover the edges of the rule itself — the all-or-none read and the day window
// — which are cheap here and would need a 50,000-record fixture there.

import { describe, it, expect } from "vitest";

import {
  PRUNED_DAYS_KEPT,
  RUN_HISTORY_CAP,
  dayStartOf,
  emptyPrunedTally,
  foldPrunedRun,
  readPrunedTally,
} from "../../shared/run-history-rules.mjs";

const day = 24 * 60 * 60 * 1000;
const run = (over: Record<string, unknown> = {}) => ({
  startedAt: Date.UTC(2026, 0, 15, 12),
  status: "passed",
  ...over,
});

describe("the cap", () => {
  it("is the app's, not the MCP's old one", () => {
    // The regression this forbids: 1000 was the pre-#158 value the MCP kept for
    // months, and one append at that cap pruned 49,001 records.
    expect(RUN_HISTORY_CAP).toBe(50_000);
  });
});

describe("foldPrunedRun", () => {
  it("counts a run into the totals and its own day", () => {
    const t = emptyPrunedTally();
    expect(foldPrunedRun(t, run())).toBe(true);
    expect(t).toMatchObject({ runs: 1, passed: 1, failed: 0 });
    expect(t.days).toEqual([
      { dayStart: dayStartOf(run().startedAt as number), runs: 1, passed: 1, failed: 0 },
    ]);
  });

  it("keeps a failed run on the failed side of both counters", () => {
    const t = emptyPrunedTally();
    foldPrunedRun(t, run({ status: "failed" }));
    expect(t).toMatchObject({ runs: 1, passed: 0, failed: 1 });
    expect(t.days[0]).toMatchObject({ runs: 1, passed: 0, failed: 1 });
  });

  it("skips a baseline update — an event, not a run", () => {
    // The same rule every counter in the app applies to these. Counting one
    // would make "total runs" include something that never executed.
    const t = emptyPrunedTally();
    expect(foldPrunedRun(t, run({ kind: "baseline-update" }))).toBe(false);
    expect(t.runs).toBe(0);
    expect(t.days).toEqual([]);
  });

  it("merges runs from the same day into one bucket", () => {
    const t = emptyPrunedTally();
    const at = Date.UTC(2026, 0, 15, 9);
    foldPrunedRun(t, run({ startedAt: at }));
    foldPrunedRun(t, run({ startedAt: at + 60_000, status: "failed" }));
    expect(t.days).toHaveLength(1);
    expect(t.days[0]).toMatchObject({ runs: 2, passed: 1, failed: 1 });
  });

  it("keeps the newest days and drops the rest, with the totals still whole", () => {
    // The flat counters are what the cards and the pass rate read, so they must
    // survive a day falling out of the window — otherwise trimming the
    // breakdown would quietly shrink the lifetime total too.
    const t = emptyPrunedTally();
    const base = Date.UTC(2026, 0, 1, 12);
    const total = PRUNED_DAYS_KEPT + 10;
    for (let i = 0; i < total; i++) foldPrunedRun(t, run({ startedAt: base + i * day }));
    expect(t.days).toHaveLength(PRUNED_DAYS_KEPT);
    expect(t.runs).toBe(total);
    // The window keeps the LATEST days, and stays sorted oldest-first.
    const starts = t.days.map((d) => d.dayStart);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(starts[starts.length - 1]).toBe(dayStartOf(base + (total - 1) * day));
  });
});

describe("readPrunedTally", () => {
  it("round-trips a coherent tally", () => {
    const t = emptyPrunedTally();
    foldPrunedRun(t, run());
    expect(readPrunedTally(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it("answers zeroes for a file whose parts do not add up", () => {
    // ALL THREE FIELDS OR NONE. Sanitising each on its own once produced a
    // total SMALLER than the outcome counts beside it — three numbers on one
    // screen that cannot all be true. A corrupt counter should understate the
    // history, never make the screen incoherent.
    expect(readPrunedTally({ runs: 10, passed: 2, failed: 3, days: [] }).runs).toBe(0);
    expect(readPrunedTally({ runs: -1, passed: 0, failed: 0 }).runs).toBe(0);
    expect(readPrunedTally({ runs: 1.5, passed: 1, failed: 0.5 }).runs).toBe(0);
    expect(readPrunedTally(null).runs).toBe(0);
    expect(readPrunedTally("nonsense").runs).toBe(0);
  });

  it("keeps the totals when only the day breakdown is unusable", () => {
    // Dropping the breakdown degrades two windowed figures to what they showed
    // before it existed. Dropping the totals with it would lose far more.
    const t = readPrunedTally({ runs: 4, passed: 3, failed: 1, days: [{ dayStart: "nope" }] });
    expect(t).toMatchObject({ runs: 4, passed: 3, failed: 1 });
    expect(t.days).toEqual([]);
  });

  it("rejects a breakdown describing more runs than ever happened", () => {
    const t = readPrunedTally({
      runs: 1,
      passed: 1,
      failed: 0,
      days: [{ dayStart: 0, runs: 9, passed: 9, failed: 0 }],
    });
    expect(t.runs).toBe(1);
    expect(t.days).toEqual([]);
  });

  it("accepts a day bucket before 1970 rather than throwing the breakdown away", () => {
    // Timestamps are SIGNED, unlike the counters. Validating a day with the
    // counter's rule discarded the whole breakdown for a machine whose clock
    // the app does not control.
    const t = readPrunedTally({
      runs: 1,
      passed: 1,
      failed: 0,
      days: [{ dayStart: -86_400_000, runs: 1, passed: 1, failed: 0 }],
    });
    expect(t.days).toHaveLength(1);
  });

  it("treats an absent `adopted` as not-yet, so an upgrade seeds once", () => {
    expect(readPrunedTally({ runs: 0, passed: 0, failed: 0 }).adopted).toBe(false);
    expect(readPrunedTally({ runs: 0, passed: 0, failed: 0, adopted: true }).adopted).toBe(true);
  });
});
