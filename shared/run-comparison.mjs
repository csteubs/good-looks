// Then-vs-now comparison for a re-executed run.
//
// Pure (see the admission rule in run-pacing.mjs): it takes two already-read
// replay models and returns a verdict. Reading them off disk is the caller's
// job, which is what lets the app read through its artifact store and the MCP
// server read the same files directly.
//
// Re-running a past run against the live site is only useful if you can see
// what MOVED. The stated worry about live replay is environment drift — the
// site changed, auth expired, data is gone — so this is built around telling
// those apart rather than just reporting a new pass/fail:
//
//   • A step that passed then and passes now  → stable.
//   • A step that failed then and passes now  → fixed (or flaky).
//   • A step that passed then and fails now   → regressed OR drifted. We can't
//     tell which from the run alone, so we say "changed since" and let the
//     screenshots and error make the case — we never claim it's a regression.
//   • Visual state is reported separately, since a step can pass functionally
//     while looking different.

function classify(before, after) {
  if (before === "unknown" || after === "unknown") return "unknown";
  if (before === "passed" && after === "passed") return "stable";
  if (before === "failed" && after === "passed") return "fixed";
  if (before === "passed" && after === "failed") return "changed-since";
  if (before === "failed" && after === "failed") return "still-failing";
  return "unknown"; // skipped on either side tells us nothing
}

/** Compare two persisted replay models. Returns null when either is missing —
 *  retention prunes run directories, so "the run is gone" is ordinary. */
export function compareReplays(base, replay) {
  if (!base || !replay) return null;

  // Match on stepId, not index — a re-run generates its spec from the recorded
  // steps, so ids line up even if indices shift.
  const afterById = new Map(replay.steps.map((s) => [s.stepId, s]));
  const steps = base.steps.map((b) => {
    const a = afterById.get(b.stepId);
    return {
      stepId: b.stepId,
      label: b.label,
      before: b.status,
      after: a?.status ?? "unknown",
      delta: a ? classify(b.status, a.status) : "unknown",
      ...(a?.diff ? { visual: a.diff.state } : {}),
    };
  });

  return {
    testId: base.testId,
    baseRunId: base.runId,
    replayRunId: replay.runId,
    steps,
    changedSinceCount: steps.filter((s) => s.delta === "changed-since").length,
    fixedCount: steps.filter((s) => s.delta === "fixed").length,
    stepsDiverged:
      base.steps.length !== replay.steps.length ||
      base.steps.some((b) => !afterById.has(b.stepId)),
  };
}
