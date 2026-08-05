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
  /** runs that ran accessibility checks and reported a timing */
  a11yRuns: number;
  /** mean ms spent on accessibility checks across those runs */
  meanA11yMs: number;
  /** mean ms per individual accessibility check */
  meanMsPerA11yCheck: number;
  /** accessibility time as a share (0–1) of such a run's total duration */
  a11yShareOfRun: number;
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

  // Accessibility is measured on its OWN axis, not folded into the capture
  // numbers: axe typically costs more per step than the screenshot does, and
  // one combined figure would make "capture is expensive" the wrong conclusion.
  const a11yRuns = runs.filter((r) => typeof r.a11yMs === "number" && (r.a11yChecks ?? 0) > 0);
  const a11yMsAll = a11yRuns.map((r) => r.a11yMs as number);
  const meanA11yMs = mean(a11yMsAll);
  const totalA11yChecks = a11yRuns.reduce((a, r) => a + (r.a11yChecks ?? 0), 0);
  const meanA11yDurationMs = mean(a11yRuns.map((r) => r.durationMs));

  return {
    capturedRuns: captured.length,
    uncapturedRuns: uncaptured.length,
    meanCaptureMs,
    meanMsPerShot: totalShots > 0 ? captureMs.reduce((a, b) => a + b, 0) / totalShots : 0,
    meanCapturedDurationMs,
    meanUncapturedDurationMs: uncaptured.length > 0 ? mean(uncaptured.map((r) => r.durationMs)) : null,
    captureShareOfRun: meanCapturedDurationMs > 0 ? meanCaptureMs / meanCapturedDurationMs : 0,
    totalShots,
    a11yRuns: a11yRuns.length,
    meanA11yMs,
    meanMsPerA11yCheck:
      totalA11yChecks > 0 ? a11yMsAll.reduce((a, b) => a + b, 0) / totalA11yChecks : 0,
    a11yShareOfRun: meanA11yDurationMs > 0 ? meanA11yMs / meanA11yDurationMs : 0,
  };
}
