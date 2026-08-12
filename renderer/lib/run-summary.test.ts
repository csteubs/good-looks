// The six-state decision, and the facts each state carries.
//
// This is where §6.1 is actually verified. The panels that render these facts
// are checked in run-summary.test.tsx, but jsdom has no layout engine and no
// cascade, so "the healed panel warns about an unreviewed heal" is a claim
// about THIS function, not about the markup.

import { describe, expect, it } from "vitest";

import type { HealEntry, RunRecord } from "./recorder-types";
import { median, runDifferences, runsForTest, summariseRun } from "./run-summary";
import type { LiveRun } from "./run-summary";

const T = "t-login";

function run(over: Partial<RunRecord> & { id: string; startedAt: number }): RunRecord {
  return {
    testId: T,
    testName: "Login",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    finishedAt: over.startedAt + 1000,
    durationMs: 1000,
    logFile: "/tmp/x.log",
    logBytes: 10,
    ...over,
  };
}

function heal(over: Partial<HealEntry> & { id: string }): HealEntry {
  return {
    testId: T,
    stepId: "s1",
    stepIndex: 0,
    stepLabel: "click Sign in",
    source: "run",
    appliedLocator: { kind: "css", value: "#signin" },
    candidates: [],
    applied: true,
    status: "pending",
    at: 1000,
    ...over,
  } as HealEntry;
}

function live(over: Partial<LiveRun> = {}): LiveRun {
  return { running: false, code: 0, stepStatus: {}, startedAt: 0, ...over };
}

const NO_HEALS: HealEntry[] = [];

describe("summariseRun — which state", () => {
  it("is `never` with no live run and no history", () => {
    const s = summariseRun({ testId: T, runs: [], heals: NO_HEALS, stepCount: 4, now: 0 });
    expect(s.state).toBe("never");
    expect(s).toMatchObject({ stepCount: 4 });
  });

  it("is `never` when the only records belong to another test", () => {
    const runs = [run({ id: "r1", startedAt: 1, testId: "t-other" })];
    expect(summariseRun({ testId: T, runs, heals: NO_HEALS, stepCount: 2, now: 0 }).state).toBe(
      "never",
    );
  });

  it("is `running` while a run is in flight, whatever the history says", () => {
    const runs = [run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 })];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 5,
      live: live({ running: true, code: null, startedAt: 500, stepStatus: { 0: "passed", 1: "failed", 2: "running" } }),
      now: 3_500,
    });
    expect(s).toEqual({ state: "running", done: 2, total: 5, failedSoFar: 1, elapsedMs: 3_000 });
  });

  it("is `failed` for a finished failing run", () => {
    const runs = [run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 })];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ code: 1, recordId: "r1" }),
      now: 0,
    });
    expect(s).toEqual({ state: "failed", recordId: "r1" });
  });

  it("is `failed` from the exit code alone before the record is written", () => {
    const s = summariseRun({
      testId: T,
      runs: [],
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ code: 1 }),
      now: 0,
    });
    expect(s.state).toBe("failed");
  });

  it("is `healed` when the run substituted a locator, even though it passed", () => {
    const runs = [run({ id: "r1", startedAt: 1, healedSteps: 2, healFailedSteps: 1 })];
    const heals = [
      heal({ id: "h1", runId: "r1", at: 5 }),
      heal({ id: "h2", runId: "r1", at: 9, status: "accepted" }),
      heal({ id: "h3", runId: "other-run", at: 7 }),
    ];
    const s = summariseRun({
      testId: T,
      runs,
      heals,
      stepCount: 3,
      live: live({ recordId: "r1" }),
      now: 0,
    });
    expect(s).toMatchObject({ state: "healed", healedSteps: 2, healFailedSteps: 1, pendingReview: 1 });
    // Only this run's rows, newest first.
    expect(s.state === "healed" && s.entries.map((e) => e.id)).toEqual(["h2", "h1"]);
  });

  it("reports healFailedSteps as null on a run recorded before the field existed", () => {
    const runs = [run({ id: "r1", startedAt: 1, healedSteps: 1 })];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 1,
      live: live({ recordId: "r1" }),
      now: 0,
    });
    // NOT 0: "it never tried" and "it tried and failed nothing" are different
    // claims, and only the second is evidence.
    expect(s).toMatchObject({ state: "healed", healFailedSteps: null });
  });

  it("is `retry` when the previous run of the same test failed", () => {
    const runs = [
      run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1, runBrowser: "webkit" }),
      run({ id: "r2", startedAt: 2, runBrowser: "chromium" }),
    ];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ recordId: "r2" }),
      now: 0,
    });
    expect(s.state).toBe("retry");
    expect(s.state === "retry" && s.previous.id).toBe("r1");
    expect(s.state === "retry" && s.differences).toEqual([
      { label: "Browser", before: "WebKit", after: "Chromium" },
    ]);
  });

  it("prefers `healed` over `retry` when a run did both", () => {
    const runs = [
      run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 }),
      run({ id: "r2", startedAt: 2, healedSteps: 1 }),
    ];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ recordId: "r2" }),
      now: 0,
    });
    expect(s.state).toBe("healed");
  });

  it("does not call it a retry when the previous run also passed", () => {
    const runs = [run({ id: "r1", startedAt: 1 }), run({ id: "r2", startedAt: 2 })];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ recordId: "r2" }),
      now: 0,
    });
    expect(s.state).toBe("passed");
  });

  it("ignores a baseline-update record when deciding what came before", () => {
    const runs = [
      run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 }),
      run({ id: "b1", startedAt: 2, kind: "baseline-update" }),
      run({ id: "r2", startedAt: 3 }),
    ];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ recordId: "r2" }),
      now: 0,
    });
    // The failure is still the run before this one — accepting baselines is an
    // audit event, not an execution.
    expect(s.state).toBe("retry");
    expect(s.state === "retry" && s.previous.id).toBe("r1");
  });

  it("summarises the most recent record when nothing ran this session", () => {
    const runs = [run({ id: "r1", startedAt: 1 }), run({ id: "r2", startedAt: 2, healedSteps: 1 })];
    const s = summariseRun({ testId: T, runs, heals: NO_HEALS, stepCount: 3, now: 0 });
    expect(s.state).toBe("healed");
  });

  it("summarises the run it was told about, not the newest one", () => {
    // A batch can write another test's run in between; within one test, a
    // record arriving late must not make the panel describe a stranger.
    const runs = [
      run({ id: "r1", startedAt: 1, healedSteps: 1 }),
      run({ id: "r2", startedAt: 9 }),
    ];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ recordId: "r1" }),
      now: 0,
    });
    expect(s.state).toBe("healed");
  });
});

describe("summariseRun — the passed facts", () => {
  it("measures against the median of previous PASSED runs only", () => {
    const runs = [
      run({ id: "r1", startedAt: 1, durationMs: 1_000 }),
      run({ id: "r2", startedAt: 2, durationMs: 3_000 }),
      // A failure's duration is not evidence about how long a pass takes.
      run({ id: "r3", startedAt: 3, durationMs: 60_000, status: "failed", exitCode: 1 }),
      run({ id: "r4", startedAt: 4, durationMs: 2_000 }),
      run({ id: "r5", startedAt: 5, durationMs: 4_000 }),
    ];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ recordId: "r5" }),
      now: 0,
    });
    // r5 follows a PASS (r4), so this is a plain pass, not a retry.
    expect(s).toMatchObject({ state: "passed", durationMs: 4_000, medianMs: 2_000, deltaPct: 100 });
  });

  it("prefers the metrics median over the one it can derive from run history", () => {
    // Retention prunes run-history.json and not the metrics DB, so after a
    // prune the history-derived median is computed from a silently truncated
    // sample — it stays plausible and stops being true.
    const runs = [
      run({ id: "r1", startedAt: 1, durationMs: 1_000 }),
      run({ id: "r2", startedAt: 2, durationMs: 3_000 }),
    ];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ recordId: "r2" }),
      now: 0,
      medianMs: 9_000,
    });
    expect(s).toMatchObject({ state: "passed", medianMs: 9_000 });
    // …and the delta is measured against it, not against the 1_000 the
    // history would have given.
    expect(s.state === "passed" && Math.round(s.deltaPct!)).toBe(-67);
  });

  it("falls back to run history when metrics are unavailable, not to no median", () => {
    // The metrics DB is a derived shadow that is allowed to be absent. Losing
    // the better source must not mean losing the answer.
    const runs = [
      run({ id: "r1", startedAt: 1, durationMs: 1_000 }),
      run({ id: "r2", startedAt: 2, durationMs: 3_000 }),
    ];
    for (const medianMs of [null, undefined]) {
      const s = summariseRun({
        testId: T,
        runs,
        heals: NO_HEALS,
        stepCount: 3,
        live: live({ recordId: "r2" }),
        now: 0,
        medianMs,
      });
      expect(s).toMatchObject({ state: "passed", medianMs: 1_000 });
    }
  });

  it("has no median on a test's first ever run", () => {
    const runs = [run({ id: "r1", startedAt: 1, durationMs: 1_000 })];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ recordId: "r1" }),
      now: 0,
    });
    // Not 0% — one sample is not a median, and a distance from it is a
    // measurement claim with no measurement behind it.
    expect(s).toMatchObject({ state: "passed", medianMs: null, deltaPct: null });
  });

  it("carries what the run actually did", () => {
    const runs = [
      run({ id: "r1", startedAt: 1, captureArtifacts: true, a11yChecks: 4, a11yNewSteps: 2 }),
    ];
    const s = summariseRun({
      testId: T,
      runs,
      heals: NO_HEALS,
      stepCount: 3,
      live: live({ recordId: "r1" }),
      now: 0,
    });
    expect(s).toMatchObject({ captured: true, a11yChecks: 4, a11yNewSteps: 2 });
  });
});

describe("runDifferences", () => {
  const before = run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 });

  it("is empty when nothing this app records changed", () => {
    expect(runDifferences(before, run({ id: "r2", startedAt: 2 }))).toEqual([]);
  });

  it("reads an absent browser as Chromium on both sides", () => {
    // Every run predating the picker really did run on chromium, so this is
    // history rather than a default — and inventing a difference here would
    // have the panel blame an engine change that never happened.
    const after = run({ id: "r2", startedAt: 2, runBrowser: "chromium" });
    expect(runDifferences(before, after)).toEqual([]);
  });

  it("reads an absent speed as Unknown rather than as fast", () => {
    const after = run({ id: "r2", startedAt: 2, speed: "fast" });
    expect(runDifferences(before, after)).toEqual([
      { label: "Pacing", before: "Unknown", after: "Fast" },
    ]);
  });

  it("orders the engine first", () => {
    const after = run({
      id: "r2",
      startedAt: 2,
      runBrowser: "firefox",
      speed: "crawl",
      captureArtifacts: true,
    });
    expect(runDifferences(before, after).map((d) => d.label)).toEqual([
      "Browser",
      "Pacing",
      "Capture",
    ]);
  });

  it("names the dataset row", () => {
    const after = run({ id: "r2", startedAt: 2, datasetName: "admin" });
    expect(runDifferences(before, after)).toEqual([
      { label: "Dataset row", before: "—", after: "admin" },
    ]);
  });
});

describe("helpers", () => {
  it("median takes the mean of the middle pair on an even list", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it("runsForTest sorts oldest first and drops other tests and baseline events", () => {
    const runs = [
      run({ id: "r2", startedAt: 20 }),
      run({ id: "b1", startedAt: 15, kind: "baseline-update" }),
      run({ id: "x1", startedAt: 5, testId: "t-other" }),
      run({ id: "r1", startedAt: 10 }),
    ];
    expect(runsForTest(runs, T).map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});
