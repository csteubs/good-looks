// Drift — this frame across its recent runs. REDESIGN §6.6.
//
// The Visual screen answers "did this frame change?" for ONE run. Drift answers
// the question that follows and that nothing in the app could answer before: is
// it changing repeatedly?
//
// Those are different problems with different fixes. A frame that changed once
// is a change to look at. A frame that has been over threshold in seven of the
// last ten runs is a baseline nobody has re-pinned — the comparison has been
// failing for a week and the pictures have been telling somebody so, one run at
// a time, where it reads as ten separate small changes instead of one standing
// problem.
//
// PURE, over data the view already fetches: one `RunReplay` per recent run, each
// of which carries its steps' diff ratios. No new backend analysis — that is
// what separates this from the region breakdown, which needs pixel work that
// does not exist yet and is the remaining piece of §6.6.

/** One run's reading for one step. */
export interface DriftPoint {
  runId: string;
  startedAt: number;
  /**
   * The step's diff ratio in that run, or null when there is no reading.
   *
   * NULL IS NOT ZERO AND THE DISTINCTION IS THE WHOLE POINT. A run where this
   * step was skipped, or where capture was off, or which predates the step
   * existing, has no measurement — and drawing it as a zero-height bar says
   * "this frame was identical that time", which is a claim nobody made. It
   * renders as a gap.
   */
  ratio: number | null;
  /** Whether that run's comparison was over its threshold. */
  changed: boolean;
}

export interface Drift {
  points: DriftPoint[];
  /** Runs that actually measured this step. */
  measured: number;
  /** …and how many of those were over threshold. */
  changedRuns: number;
  /** The largest ratio seen, for scaling the bars. Null when nothing measured. */
  peak: number | null;
  verdict: DriftVerdict;
}

/**
 * What the series says, in one word.
 *
 * `settled` is deliberately the answer for "no change in the window" AND for a
 * single isolated change: one change against a baseline is the ordinary,
 * healthy case — somebody edits a page, the frame moves once, they re-pin. It
 * is not drift and calling it drift would make the readout cry wolf on the most
 * common thing that happens here.
 */
export type DriftVerdict = "unknown" | "settled" | "drifting";

/** Below this there is no series to read — two points is an anecdote. */
export const MIN_RUNS_FOR_DRIFT = 4;

/**
 * How many recent runs the strip reads.
 *
 * Ten because the series has to be long enough to tell a standing problem from
 * one bad afternoon, and short enough that "recent" still means recent — a
 * baseline re-pinned last month should not be indicted by the month before it.
 * It also bounds the cost: each run in the window is one replay read, and they
 * are per-RUN rather than per-step, so moving between steps of the same run is
 * free once the window is loaded.
 */
export const DRIFT_WINDOW = 10;

/** Over threshold in this fraction of measured runs, and it is drifting. */
export const DRIFT_SHARE = 0.4;

/**
 * A share of the window rather than a count, because a count says nothing
 * without a denominator: two changes out of forty runs is noise and two out of
 * four is a pattern.
 *
 * THE TWO CONSTANTS TOGETHER GUARANTEE A SINGLE CHANGE IS NEVER DRIFT, and that
 * is the property that matters most here — one edit, one moved frame, one
 * re-pin is the ordinary healthy case. The smallest readable window is four
 * runs, so one change is at most 1/4 = 0.25, comfortably under 0.4. Lowering
 * either constant breaks it, which is why a test pins it across the whole range
 * rather than trusting the arithmetic to stay true.
 */
export function driftVerdict(measured: number, changedRuns: number): DriftVerdict {
  if (measured < MIN_RUNS_FOR_DRIFT) return "unknown";
  return changedRuns / measured >= DRIFT_SHARE ? "drifting" : "settled";
}

/**
 * The series for one step, newest LAST.
 *
 * Chronological rather than newest-first, because it is drawn as a strip and a
 * strip that reads right-to-left is a chart nobody can read. The caller passes
 * runs in whatever order it has them; this sorts.
 */
export function computeDrift(points: readonly DriftPoint[]): Drift {
  const sorted = [...points].sort((a, b) => a.startedAt - b.startedAt);
  const measuredPoints = sorted.filter((p) => p.ratio !== null);
  const changedRuns = measuredPoints.filter((p) => p.changed).length;
  const peak = measuredPoints.length > 0 ? Math.max(...measuredPoints.map((p) => p.ratio ?? 0)) : null;

  return {
    points: sorted,
    measured: measuredPoints.length,
    changedRuns,
    peak,
    verdict: driftVerdict(measuredPoints.length, changedRuns),
  };
}

/** The shape this reads out of a `RunReplay`. Structural rather than the real
 *  type, so the join is testable without building whole replays and so the lib
 *  stays free of the view's imports. */
export interface DriftRun {
  runId: string;
  startedAt: number;
  steps: readonly { stepId: string; diff?: { state?: string; ratio?: number } }[];
}

/**
 * One step's series, joined out of a window of runs.
 *
 * A run that does not contain the step at all still contributes a point with no
 * reading, because it IS a run in the window and drawing nothing there would
 * silently shorten the strip. What it must not contribute is a zero — see
 * `DriftPoint.ratio`.
 *
 * `state === "unable"` is likewise no reading rather than a match: the
 * comparison could not be made, which is not the same as making it and finding
 * nothing.
 */
export function driftPointsFor(runs: readonly DriftRun[], stepId: string): DriftPoint[] {
  return runs.map((run) => {
    const step = run.steps.find((s) => s.stepId === stepId);
    const diff = step?.diff;
    const measured = diff !== undefined && diff.state !== "unable" && diff.ratio !== undefined;
    return {
      runId: run.runId,
      startedAt: run.startedAt,
      ratio: measured ? (diff.ratio as number) : null,
      changed: diff?.state === "changed",
    };
  });
}

/**
 * A bar's height as a fraction of the strip, 0–1.
 *
 * SCALED TO THE PEAK, not to 100%. Diff ratios here are small numbers — a 4%
 * change is a large one — so scaling against a full 100% axis draws every bar
 * as a flat line and the strip says nothing. Against the window's own peak, the
 * shape of the series is visible, which is the only thing a strip this size can
 * usefully carry.
 *
 * A measured-but-identical frame still gets a visible bar rather than nothing:
 * zero height and "no reading" would look the same, and they are the two states
 * this whole component has to keep apart.
 *
 * THE FLOOR IS SET BY WHAT IS DISTINGUISHABLE ON SCREEN, NOT BY TASTE. At 0.06
 * of a 20px strip a floored bar is one pixel, which in the preview was visually
 * identical to the dash that means "no reading" — the exact collapse the
 * previous paragraph exists to prevent, shipped. The gap marker also floats to
 * mid-height so it cannot read as a zero-height bar; both halves are needed,
 * since either alone still leaves two dashes on the same baseline.
 */
export const MIN_BAR = 0.14;

export function barHeight(ratio: number | null, peak: number | null): number | null {
  if (ratio === null) return null;
  if (peak === null || peak <= 0) return MIN_BAR;
  return Math.max(MIN_BAR, Math.min(1, ratio / peak));
}

/** What the strip says in words. Exported so the test asserts the sentence the
 *  user reads rather than walking bars. */
export function driftLine(drift: Drift): string {
  if (drift.verdict === "unknown") {
    return drift.measured === 0
      ? "No other run has measured this frame yet."
      : `Only ${drift.measured} run${drift.measured === 1 ? "" : "s"} measured this frame — not enough to read a trend.`;
  }
  if (drift.verdict === "drifting") {
    return `Changed in ${drift.changedRuns} of the last ${drift.measured} runs — the baseline may need re-pinning.`;
  }
  return drift.changedRuns === 0
    ? `Steady across the last ${drift.measured} runs.`
    : `Changed once in the last ${drift.measured} runs.`;
}
