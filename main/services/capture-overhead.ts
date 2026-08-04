// What screenshot capture actually costs, computed from run history.
//
// The roadmap's cross-cutting "Performance" risk asks for this explicitly: the
// per-run capture toggle is the mitigation for capture overhead, but its
// cost/benefit was assumed rather than measured. This turns it into a number.
//
// Pure (no fs/IPC) so it can be regression-checked directly — the caller hands
// it RunRecords and gets a summary back.

import type { RunRecord } from "../recorder/types.js";

export interface CaptureOverheadSummary {
  /** capture runs that reported instrumented timings */
  capturedRuns: number;
  /** non-capture runs available for the side-by-side comparison */
  uncapturedRuns: number;
  /** mean ms spent taking screenshots, across instrumented capture runs */
  meanCaptureMs: number;
  /** mean ms per individual screenshot */
  meanMsPerShot: number;
  /** mean total duration of instrumented capture runs */
  meanCapturedDurationMs: number;
  /** mean total duration of non-capture runs (null when there are none) */
  meanUncapturedDurationMs: number | null;
  /** capture time as a share (0–1) of a captured run's total duration */
  captureShareOfRun: number;
  /** total screenshots taken across instrumented capture runs */
  totalShots: number;
}

function mean(ns: number[]): number {
  if (ns.length === 0) return 0;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

/** Summarize capture overhead over a set of runs. Only real "run" records count
 *  — baseline-update events aren't executions. Pass a testId to scope it to one
 *  test, which is the fair comparison (different tests do different work). */
export function summarizeCaptureOverhead(
  records: readonly RunRecord[],
  testId?: string,
): CaptureOverheadSummary {
  const runs = records.filter(
    (r) => (r.kind ?? "run") === "run" && (testId === undefined || r.testId === testId),
  );
  // Only runs from the instrumented fixture carry timings; older capture runs
  // are excluded rather than counted as zero-cost.
  const captured = runs.filter((r) => r.captureArtifacts && typeof r.captureOverheadMs === "number");
  const uncaptured = runs.filter((r) => !r.captureArtifacts);

  const captureMs = captured.map((r) => r.captureOverheadMs as number);
  const totalShots = captured.reduce((a, r) => a + (r.shotCount ?? 0), 0);
  const meanCaptureMs = mean(captureMs);
  const meanCapturedDurationMs = mean(captured.map((r) => r.durationMs));

  return {
    capturedRuns: captured.length,
    uncapturedRuns: uncaptured.length,
    meanCaptureMs,
    meanMsPerShot: totalShots > 0 ? captureMs.reduce((a, b) => a + b, 0) / totalShots : 0,
    meanCapturedDurationMs,
    meanUncapturedDurationMs: uncaptured.length > 0 ? mean(uncaptured.map((r) => r.durationMs)) : null,
    captureShareOfRun: meanCapturedDurationMs > 0 ? meanCaptureMs / meanCapturedDurationMs : 0,
    totalShots,
  };
}
