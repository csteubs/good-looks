// Types for metrics-query.mjs. See run-pacing.d.mts for why these are
// hand-written.
//
// `MetricsDb` is the minimal slice of node:sqlite's DatabaseSync these queries
// use, declared rather than imported: the module is loaded dynamically by both
// callers, so there is no static type to reach for — and declaring only what is
// used is also the honest description of the dependency.

import type { RunRow, StepRow } from "./metrics-schema.mjs";

export interface MetricsDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** Null is an ordinary argument: metrics are unavailable on a runtime without
 *  node:sqlite, and every query answers "nothing" rather than throwing. */
export type Db = MetricsDb | null | undefined;

export declare function isPopulated(db: Db): boolean;

export interface LifetimeRunCounts {
  runs: number;
  passed: number;
  failed: number;
  /** Per LOCAL day, `YYYY-MM-DD`, ascending. */
  days: { day: string; runs: number; passed: number; failed: number }[];
}

/** Every run the metrics DB still holds — including ones the capped run index
 *  has pruned. The seed for the lifetime counter on an app that ran for months
 *  before that counter existed. */
export declare function lifetimeRunCounts(
  db: Db,
  opts?: { sinceMs?: number },
): LifetimeRunCounts;

export declare function counts(db: Db): {
  runs: number;
  steps: number;
  runsWithArtifacts: number;
};

export interface StepHealthRow {
  stepId: string;
  label: string | null;
  type: string | null;
  testId: string;
  testName: string | null;
  runs: number;
  failed: number;
  failRate: number;
  heals: number;
  healFailures: number;
  visualChanges: number;
  a11yNew: number;
  pageErrors: number;
  /** how many of those runs have a measured duration — the rest predate it */
  timedRuns: number;
  minMs: number | null;
  maxMs: number | null;
  lastSeenAt: number;
}

export declare function stepHealth(
  db: Db,
  opts?: { testId?: string; limit?: number },
): StepHealthRow[];

export declare function stepDurationTrend(
  db: Db,
  stepId: string,
  window?: number,
): {
  stepId: string;
  window: number;
  recentMedianMs: number | null;
  previousMedianMs: number | null;
  /** recent ÷ previous, or null when either window has no timed runs */
  changeRatio: number | null;
};

export declare function suiteCost(
  db: Db,
  opts?: { since?: number },
): {
  runs: number;
  totalMs: number;
  captureMs: number;
  a11yMs: number;
  shots: number;
  bySpeed: { speed: string; runs: number; totalMs: number }[];
};

export declare function browserMatrix(
  db: Db,
  opts?: { testId?: string },
): { testId: string; testName: string | null; browser: string; runs: number; failed: number }[];

export declare function failureClusters(
  db: Db,
  opts?: { limit?: number; since?: number },
): {
  signature: string;
  runs: number;
  tests: number;
  lastSeenAt: number;
  firstSeenAt: number;
}[];

export interface StepDurationRow {
  stepId: string;
  label: string | null;
  type: string | null;
  testId: string;
  testName: string | null;
  /** how many of the most recent `window` runs had a measured duration */
  recentRuns: number;
  /** …and how many of the `window` before those */
  previousRuns: number;
  recentP50Ms: number | null;
  recentP95Ms: number | null;
  previousP50Ms: number | null;
  /** recentP50 ÷ previousP50, or null when either window has no timings */
  changeRatio: number | null;
}

export declare function stepDurations(
  db: Db,
  opts?: { testId?: string; window?: number; limit?: number },
): StepDurationRow[];

/** A TEST's own duration trend — recent median against the one before it.
 *  Passed runs only; a failure's duration is not evidence about how long a
 *  test takes. C §6.3. */
export interface TestDurationTrend {
  testId: string;
  window: number;
  /** how many of the most recent `window` PASSED runs there were */
  recentRuns: number;
  /** …and how many of the `window` before those */
  previousRuns: number;
  recentP50Ms: number | null;
  previousP50Ms: number | null;
  /** recentP50 ÷ previousP50, or null when either window is empty */
  changeRatio: number | null;
}

export declare function testDurationTrend(
  db: Db,
  testId: string,
  window?: number,
): TestDurationTrend;

export interface StepBrowserRow {
  stepId: string;
  label: string | null;
  testId: string;
  testName: string | null;
  browser: string;
  runs: number;
  failed: number;
}

export declare function stepBrowserMatrix(
  db: Db,
  opts?: { testId?: string; limit?: number },
): StepBrowserRow[];

export declare function runEvidence(
  db: Db,
  runId: string,
): { run: RunRow; steps: StepRow[] } | null;

export declare function siblingRuns(
  db: Db,
  testId: string,
  opts?: { limit?: number; excludeRunId?: string },
): Partial<RunRow>[];
