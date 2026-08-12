// Drift — this frame across its recent runs. REDESIGN §6.6.
//
// Two things here would be quietly wrong and neither would throw. A run with no
// reading must not be drawn as a zero — that says "identical", which is a claim
// nobody made. And a single change must not be called drift: one edit, one moved
// frame, one re-pin is the ordinary healthy case, and a readout that cries wolf
// on it is a readout people stop reading.
//
// The sentence is asserted rather than the bars, for the same reason as §6.6's
// provenance line: what this feature IS is what it says.

import { describe, expect, it } from "vitest";

import {
  DRIFT_SHARE,
  type DriftPoint,
  MIN_BAR,
  MIN_RUNS_FOR_DRIFT,
  barHeight,
  computeDrift,
  driftLine,
  driftPointsFor,
  driftVerdict,
} from "./baseline-drift";

function point(over: Partial<DriftPoint> & { startedAt: number }): DriftPoint {
  return { runId: `r${over.startedAt}`, ratio: 0, changed: false, ...over };
}

/** N runs, `changed` of them over threshold, in ascending time. */
function series(n: number, changed: number): DriftPoint[] {
  return Array.from({ length: n }, (_, i) =>
    point({ startedAt: 1000 + i, ratio: i < changed ? 0.05 : 0.001, changed: i < changed }),
  );
}

describe("the verdict", () => {
  it("refuses to read a trend from too few runs", () => {
    // Two points is an anecdote. The honest answer is that there is no answer,
    // not a cheerful "settled" from a window that contains nothing.
    expect(driftVerdict(MIN_RUNS_FOR_DRIFT - 1, 0)).toBe("unknown");
    expect(driftVerdict(MIN_RUNS_FOR_DRIFT - 1, 2)).toBe("unknown");
    expect(driftVerdict(MIN_RUNS_FOR_DRIFT, 0)).toBe("settled");
  });

  it("NEVER calls a single change drift, at any window size", () => {
    // Somebody edits a page, the frame moves once, they re-pin. That is the most
    // common thing that happens on this screen and it is not drift.
    //
    // The guarantee is emergent — it falls out of MIN_RUNS_FOR_DRIFT and
    // DRIFT_SHARE together, not out of a branch — so it is pinned across the
    // whole range rather than at one point. Lowering either constant fails here,
    // which is the only warning anyone would get.
    for (let measured = MIN_RUNS_FOR_DRIFT; measured <= 100; measured++) {
      expect(driftVerdict(measured, 1)).toBe("settled");
    }
  });

  it("calls a real share of a window drift", () => {
    expect(driftVerdict(10, 4)).toBe("drifting");
    expect(driftVerdict(4, 2)).toBe("drifting");
  });

  it("does not call two changes in a long window drift", () => {
    // Two out of forty is noise. Both halves of the rule are load-bearing:
    // count alone would fire here, share alone would fire on 1-of-2.
    expect(10 / 40).toBeLessThan(DRIFT_SHARE);
    expect(driftVerdict(40, 2)).toBe("settled");
  });
});

describe("the series", () => {
  it("is chronological regardless of what the caller hands it", () => {
    // It is drawn as a strip, and a strip that reads right-to-left is a chart
    // nobody can read. The view fetches runs newest-first.
    const drift = computeDrift([
      point({ startedAt: 300 }),
      point({ startedAt: 100 }),
      point({ startedAt: 200 }),
    ]);
    expect(drift.points.map((p) => p.startedAt)).toEqual([100, 200, 300]);
  });

  it("counts only runs that measured the frame", () => {
    // A skipped step, capture off, or a run predating the step: no reading. Four
    // points, two readings — which is below the floor, so no trend.
    const drift = computeDrift([
      point({ startedAt: 1, ratio: null }),
      point({ startedAt: 2, ratio: 0.01 }),
      point({ startedAt: 3, ratio: null }),
      point({ startedAt: 4, ratio: 0.02, changed: true }),
    ]);
    expect(drift.points).toHaveLength(4);
    expect(drift.measured).toBe(2);
    expect(drift.changedRuns).toBe(1);
    expect(drift.verdict).toBe("unknown");
  });

  it("takes the peak from readings only, and reports none when there are none", () => {
    expect(computeDrift(series(3, 1)).peak).toBe(0.05);
    expect(computeDrift([point({ startedAt: 1, ratio: null })]).peak).toBeNull();
    expect(computeDrift([]).peak).toBeNull();
  });
});

describe("joining a step to a window of runs", () => {
  const runs = [
    { runId: "a", startedAt: 1, steps: [{ stepId: "s1", diff: { state: "match", ratio: 0 } }] },
    { runId: "b", startedAt: 2, steps: [{ stepId: "s1", diff: { state: "changed", ratio: 0.04 } }] },
    // The step is not in this run at all — an older run, or one that failed
    // before reaching it.
    { runId: "c", startedAt: 3, steps: [{ stepId: "s2", diff: { state: "match", ratio: 0 } }] },
    // The comparison could not be made. It carries a ratio anyway — `VisualDiff`
    // is one flat interface, so `unable` with a leftover `ratio` is a shape
    // TypeScript permits and only a runtime check excludes.
    { runId: "d", startedAt: 4, steps: [{ stepId: "s1", diff: { state: "unable", ratio: 0.9 } }] },
  ];

  it("keeps a run with no reading in the window, without inventing a zero", () => {
    // Dropping it would silently shorten the strip; drawing it as zero would
    // claim the frame was identical that time.
    const points = driftPointsFor(runs, "s1");
    expect(points).toHaveLength(4);
    expect(points.map((p) => p.ratio)).toEqual([0, 0.04, null, null]);
  });

  it("treats 'unable' as no reading, not as a match", () => {
    // The comparison could not be made, which is not the same as making it and
    // finding nothing.
    expect(driftPointsFor(runs, "s1")[3]).toEqual({
      runId: "d",
      startedAt: 4,
      ratio: null,
      changed: false,
    });
  });

  it("carries the over-threshold flag from the run, not from the ratio", () => {
    // The threshold is per-test and lives on the replay; re-deriving it from
    // the ratio here would need a threshold this module does not have.
    expect(driftPointsFor(runs, "s1").filter((p) => p.changed).map((p) => p.runId)).toEqual(["b"]);
  });
});

describe("bar heights", () => {
  it("keeps 'no reading' distinguishable from 'identical'", () => {
    // THE distinction this component exists to hold. A null must not come back
    // as a number, because every number draws as a bar.
    expect(barHeight(null, 0.1)).toBeNull();
    expect(barHeight(0, 0.1)).toBe(MIN_BAR);
  });

  it("scales to the window's own peak, not to 100%", () => {
    // Diff ratios here are small — a 4% change is a large one — so a full-scale
    // axis draws every bar as the same flat line and the strip says nothing.
    expect(barHeight(0.04, 0.04)).toBe(1);
    expect(barHeight(0.02, 0.04)).toBeCloseTo(0.5);
  });

  it("never draws past the top or below the floor", () => {
    expect(barHeight(0.09, 0.04)).toBe(1);
    expect(barHeight(0.000001, 0.04)).toBe(MIN_BAR);
    // A peak of zero means every reading was identical; there is nothing to
    // scale against and dividing would give NaN, which renders as no bar at all.
    expect(barHeight(0, 0)).toBe(MIN_BAR);
    expect(barHeight(0.01, null)).toBe(MIN_BAR);
  });
});

describe("what it says", () => {
  it("says nothing has measured it, rather than something reassuring", () => {
    expect(driftLine(computeDrift([]))).toBe("No other run has measured this frame yet.");
  });

  it("names how thin the window is when it is too thin", () => {
    expect(driftLine(computeDrift(series(2, 0)))).toContain("Only 2 runs measured");
    expect(driftLine(computeDrift(series(1, 0)))).toContain("Only 1 run measured");
  });

  it("points at the baseline when the frame keeps moving", () => {
    expect(driftLine(computeDrift(series(10, 6)))).toBe(
      "Changed in 6 of the last 10 runs — the baseline may need re-pinning.",
    );
  });

  it("distinguishes steady from changed-once", () => {
    expect(driftLine(computeDrift(series(6, 0)))).toBe("Steady across the last 6 runs.");
    expect(driftLine(computeDrift(series(6, 1)))).toBe("Changed once in the last 6 runs.");
  });
});
