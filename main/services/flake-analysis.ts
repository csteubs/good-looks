// Telling a flaky test apart from a broken one.
//
// Stats already showed a pass rate, and a pass rate cannot answer the question
// people actually have. A test at 50% might be alternating pass/fail on every
// run — unstable, and the next result is a coin toss — or it might have worked
// ten times and then broken and stayed broken, which is not flake at all but a
// regression with a date on it. Those need opposite responses, and until now
// they looked identical.
//
// So the measure here is TRANSITIONS, not percentages: how often consecutive
// runs disagree. And two things that masquerade as flake are separated out
// explicitly, because both are common and both are actionable in a way flake
// isn't:
//
//   • Data-dependent failure. A test swept over dataset rows that fails only on
//     one row is 100% reliable — it is telling you something true about that
//     row. Averaged over rows it looks like 33% flake.
//   • Healed instability. A step that keeps needing Auto-Heal is unstable in a
//     specific, fixable way: its locator is wrong. That is worth naming rather
//     than filing under "flaky".
//
// Pure over records handed in, with no fs or IPC, so the whole thing is
// regression-checkable without a browser or a run history on disk.

import type { RunRecord } from "../recorder/types.js";
import { errorSignature } from "../../shared/error-signature.mjs";

/** Reuses run-comparison.ts's vocabulary rather than inventing a second one for
 *  the same idea — two words for "it worked and now it doesn't" is how a
 *  codebase ends up with two subtly different definitions of it. */
export type StabilityVerdict =
  | "stable" // consistently passing
  | "still-failing" // consistently failing — broken, not flaky
  | "changed-since" // was passing, now failing, and stayed that way
  | "fixed" // was failing, now passing, and stayed that way
  | "flaky" // flips between the two
  | "data-dependent" // fails only on specific dataset rows
  | "unknown"; // not enough runs to say

/** How many runs before a verdict means anything. Below this, "50% pass rate"
 *  is one pass and one fail — noise, presented as a statistic. */
export const MIN_RUNS_FOR_VERDICT = 4;

export interface StepFlake {
  stepId: string;
  label: string;
  /** runs in which this step was the failure point */
  failures: number;
  /** runs in which run-time Auto-Heal had to substitute a locator here */
  heals: number;
  /** share (0–1) of analysed runs where this step failed */
  failureRate: number;
}

export interface FailureCluster {
  /** normalized error signature — the grouping key */
  signature: string;
  /** a real example, unnormalized, so it's recognizable */
  example: string;
  /** step this failure was attributed to, when known */
  stepId?: string;
  stepLabel?: string;
  count: number;
  /** most recent run exhibiting it */
  lastSeenAt: number;
  runIds: string[];
}

export interface TestFlake {
  testId: string;
  testName: string;
  runs: number;
  passed: number;
  failed: number;
  /** consecutive-run disagreements */
  transitions: number;
  /** transitions / (runs - 1): 0 = never changed its mind, 1 = alternates */
  flakeRate: number;
  verdict: StabilityVerdict;
  /** dataset rows that failed at least once, when the failures are confined to
   *  specific rows — the evidence behind a "data-dependent" verdict */
  failingDatasets: { id: string; name: string; failed: number; runs: number }[];
  /** steps that failed or needed healing, worst first */
  steps: StepFlake[];
  /** runs where Auto-Heal substituted a locator */
  healedRuns: number;
}

export interface FlakeReport {
  tests: TestFlake[];
  clusters: FailureCluster[];
  /** tests with enough runs to have a verdict at all */
  analysedTests: number;
}

/** What the analysis needs to know about one run beyond its RunRecord. */
export interface RunDetail {
  runId: string;
  /** stepId of the failure point, from the run's replay */
  failedStepId?: string;
  failedStepLabel?: string;
  /** first error line from the run log, unnormalized */
  error?: string;
  /** step ids run-time Auto-Heal substituted a locator for */
  healedStepIds?: string[];
}

// The signature itself lives in shared/error-signature.mjs: the metrics rollup
// has to compute it at ingest (the run log it reads is capped and pruned), and
// the MCP will need the same clustering the app shows. Re-exported because this
// module is where the app already imports it from.
export { errorSignature } from "../../shared/error-signature.mjs";

/** Count consecutive-run disagreements. Runs must be oldest-first. */
export function countTransitions(statuses: readonly ("passed" | "failed")[]): number {
  let n = 0;
  for (let i = 1; i < statuses.length; i++) {
    if (statuses[i] !== statuses[i - 1]) n++;
  }
  return n;
}

/**
 * Decide what a test's run history says about it.
 *
 * Order matters. Data-dependence is checked BEFORE flake, because a sweep whose
 * one bad row fails every time produces exactly the mixed pass/fail history
 * that reads as flake — and calling it flake would send someone hunting for a
 * race condition that isn't there.
 */
function verdictFor(
  statuses: readonly ("passed" | "failed")[],
  transitions: number,
  dataDependent: boolean,
): StabilityVerdict {
  if (statuses.length < MIN_RUNS_FOR_VERDICT) return "unknown";
  const failed = statuses.filter((s) => s === "failed").length;
  if (failed === 0) return "stable";
  if (failed === statuses.length) return "still-failing";
  if (dataDependent) return "data-dependent";
  // One transition means it changed state once and stayed there — a regression
  // or a fix, both of which have a cause you can go and find. Flake is the
  // pattern that keeps changing its mind.
  if (transitions === 1) {
    return statuses[statuses.length - 1] === "failed" ? "changed-since" : "fixed";
  }
  return "flaky";
}

/**
 * Whether a test's failures are confined to particular dataset rows.
 *
 * Requires that at least one row always passes and at least one always fails.
 * A row that itself flips is flake within that row, and calling the test
 * data-dependent would hide it.
 */
function analyseDatasets(
  runs: readonly RunRecord[],
): { rows: TestFlake["failingDatasets"]; dataDependent: boolean } {
  const byDataset = new Map<string, { name: string; runs: number; failed: number }>();
  let withoutDataset = 0;
  for (const r of runs) {
    if (!r.datasetId) {
      withoutDataset++;
      continue;
    }
    const entry = byDataset.get(r.datasetId) ?? {
      name: r.datasetName ?? r.datasetId,
      runs: 0,
      failed: 0,
    };
    entry.runs++;
    if (r.status === "failed") entry.failed++;
    byDataset.set(r.datasetId, entry);
  }
  const rows = [...byDataset.entries()].map(([id, e]) => ({
    id,
    name: e.name,
    failed: e.failed,
    runs: e.runs,
  }));
  // Needs at least two rows to be ABOUT the data, and no un-swept runs muddying
  // the comparison.
  if (rows.length < 2 || withoutDataset > 0) {
    return { rows: rows.filter((r) => r.failed > 0), dataDependent: false };
  }
  const alwaysFails = rows.filter((r) => r.failed === r.runs);
  const alwaysPasses = rows.filter((r) => r.failed === 0);
  const dataDependent =
    alwaysFails.length > 0 && alwaysPasses.length > 0 &&
    alwaysFails.length + alwaysPasses.length === rows.length;
  return { rows: rows.filter((r) => r.failed > 0), dataDependent };
}

/**
 * Analyse a run history.
 *
 * `records` may be in any order; they're sorted oldest-first here, because
 * transitions are meaningless otherwise and `runHistoryStore.list()` returns
 * newest-first — an easy and completely silent mistake to make at a call site.
 */
export function analyseFlake(
  records: readonly RunRecord[],
  details: readonly RunDetail[] = [],
): FlakeReport {
  const detailById = new Map(details.map((d) => [d.runId, d]));
  // Baseline-update events aren't executions and would distort every count.
  const runs = records.filter((r) => (r.kind ?? "run") === "run");

  const byTest = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const list = byTest.get(r.testId) ?? [];
    list.push(r);
    byTest.set(r.testId, list);
  }

  const tests: TestFlake[] = [];
  for (const [testId, unsorted] of byTest) {
    const testRuns = [...unsorted].sort((a, b) => a.startedAt - b.startedAt);
    const statuses = testRuns.map((r) => r.status);
    const transitions = countTransitions(statuses);
    const { rows, dataDependent } = analyseDatasets(testRuns);

    // Per-step: which step was the failure point, and which needed healing.
    const stepStats = new Map<string, StepFlake>();
    let healedRuns = 0;
    for (const r of testRuns) {
      const d = detailById.get(r.id);
      if (!d) continue;
      if (d.failedStepId) {
        const s = stepStats.get(d.failedStepId) ?? {
          stepId: d.failedStepId,
          label: d.failedStepLabel ?? d.failedStepId,
          failures: 0,
          heals: 0,
          failureRate: 0,
        };
        s.failures++;
        stepStats.set(d.failedStepId, s);
      }
      if (d.healedStepIds?.length) {
        healedRuns++;
        for (const stepId of d.healedStepIds) {
          const s = stepStats.get(stepId) ?? {
            stepId,
            label: stepId,
            failures: 0,
            heals: 0,
            failureRate: 0,
          };
          s.heals++;
          stepStats.set(stepId, s);
        }
      }
    }
    const steps = [...stepStats.values()]
      .map((s) => ({ ...s, failureRate: testRuns.length > 0 ? s.failures / testRuns.length : 0 }))
      // Failures first, then heals: a step that fails outright is a bigger
      // problem than one that keeps being papered over, but both belong here.
      .sort((a, b) => b.failures - a.failures || b.heals - a.heals);

    tests.push({
      testId,
      testName: testRuns[testRuns.length - 1]?.testName ?? testId,
      runs: testRuns.length,
      passed: statuses.filter((s) => s === "passed").length,
      failed: statuses.filter((s) => s === "failed").length,
      transitions,
      flakeRate: testRuns.length > 1 ? transitions / (testRuns.length - 1) : 0,
      verdict: verdictFor(statuses, transitions, dataDependent),
      failingDatasets: rows,
      steps,
      healedRuns,
    });
  }

  // Cluster failures across every test: one root cause showing up in twenty
  // runs should read as one problem, not twenty.
  const clusters = new Map<string, FailureCluster>();
  for (const r of runs) {
    if (r.status !== "failed") continue;
    const d = detailById.get(r.id);
    const signature = errorSignature(d?.error);
    if (!signature) continue;
    // Keyed by step AND signature: the same timeout on two different steps is
    // two problems, and merging them would point at neither.
    const key = `${d?.failedStepId ?? ""}::${signature}`;
    const existing = clusters.get(key);
    if (existing) {
      existing.count++;
      existing.runIds.push(r.id);
      if (r.startedAt > existing.lastSeenAt) existing.lastSeenAt = r.startedAt;
    } else {
      clusters.set(key, {
        signature,
        example: (d?.error ?? "").split("\n")[0].trim().slice(0, 300),
        ...(d?.failedStepId ? { stepId: d.failedStepId } : {}),
        ...(d?.failedStepLabel ? { stepLabel: d.failedStepLabel } : {}),
        count: 1,
        lastSeenAt: r.startedAt,
        runIds: [r.id],
      });
    }
  }

  return {
    // Worst first: flaky and data-dependent tests are the ones this panel
    // exists to surface, so they lead regardless of run count.
    tests: tests.sort(
      (a, b) => verdictRank(a.verdict) - verdictRank(b.verdict) || b.flakeRate - a.flakeRate,
    ),
    clusters: [...clusters.values()].sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt),
    analysedTests: tests.filter((t) => t.verdict !== "unknown").length,
  };
}

/** Sort order for verdicts — what a person should look at first. */
function verdictRank(v: StabilityVerdict): number {
  switch (v) {
    case "flaky":
      return 0;
    case "data-dependent":
      return 1;
    case "changed-since":
      return 2;
    case "still-failing":
      return 3;
    case "fixed":
      return 4;
    case "stable":
      return 5;
    default:
      return 6;
  }
}
