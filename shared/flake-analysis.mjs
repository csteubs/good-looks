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
//
// LIVES IN shared/ AS OF PHASE 4. It was `main/services/flake-analysis.ts`, and
// the plan scheduled the move for exactly this point: `get_flake_report` has to
// serve the same verdicts the app's Stability panel shows, and an MCP that
// re-derived "flaky" from its own rules would disagree with the screen the user
// is looking at. `main/services/flake-analysis.ts` re-exports it, so no app
// caller moved.
//
// The move also retired a real copy. `renderer/lib/recorder-types.ts` carried a
// hand-written mirror of `StabilityVerdict` and `MIN_RUNS_FOR_VERDICT`, kept
// honest by an assertion in check:flake-analysis — because a renderer cannot
// import from `main/`. It can import from here, so the mirror is gone and the
// assertion with it: there is nothing left to drift.

import { errorSignature } from "./error-signature.mjs";

/** How many runs before a verdict means anything. Below this, "50% pass rate"
 *  is one pass and one fail — noise, presented as a statistic. */
export const MIN_RUNS_FOR_VERDICT = 4;

// The signature itself lives in shared/error-signature.mjs: the metrics rollup
// has to compute it at ingest (the run log it reads is capped and pruned), and
// the MCP needs the same clustering the app shows. Re-exported because callers
// already import it from the flake module.
import { flakeSignal } from "./run-attempts.mjs";

export { errorSignature } from "./error-signature.mjs";

/** Count consecutive-run disagreements. Runs must be oldest-first. */
export function countTransitions(statuses) {
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
function verdictFor(statuses, transitions, dataDependent, browserDependent, retried = 0) {
  if (statuses.length < MIN_RUNS_FOR_VERDICT) return "unknown";
  const failed = statuses.filter((s) => s === "failed").length;
  // A run that failed and passed on a retry went red. Checked BEFORE the
  // stable rule, and this order is the whole reason ROUTINES.md refused a
  // retry policy in v1: `statuses` holds OUTCOMES, so a test that needs a
  // retry on every single run has `failed === 0` and would report "stable" —
  // "precisely the signal the Stability panel exists to give", inverted.
  //
  // Consistent with how a bare failure is already treated: one failure among
  // fifty passes yields two transitions and reads "flaky" today. A retry is
  // that failure, absorbed.
  if (failed === 0 && retried > 0) return "flaky";
  if (failed === 0) return "stable";
  if (failed === statuses.length) return "still-failing";
  if (dataDependent) return "data-dependent";
  // Checked after the data rule, which is the more specific claim when both
  // hold: a row that fails on every engine is about the row.
  if (browserDependent) return "browser-dependent";
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
function analyseDatasets(runs) {
  const byDataset = new Map();
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
    alwaysFails.length > 0 &&
    alwaysPasses.length > 0 &&
    alwaysFails.length + alwaysPasses.length === rows.length;
  return { rows: rows.filter((r) => r.failed > 0), dataDependent };
}

/**
 * Whether a test's failures are confined to particular BROWSERS.
 *
 * The same shape as `analyseDatasets`, and for the same reason — a cause the
 * run history can name is worth more than a verdict that says "sometimes".
 *
 * This one also fixes a verdict that was actively wrong (R20). Transitions were
 * counted across the interleaved sequence, so a test that passes on Chromium
 * and Firefox and fails EVERY time on WebKit reads as pass, pass, fail, pass,
 * pass, fail — four state changes and a confident "flaky", for a test that has
 * never once changed its mind. The cross-browser matrix made the stability
 * signal worse the more it was used, which is the opposite of what running on
 * three engines is for.
 */
function analyseBrowsers(runs) {
  const byBrowser = new Map();
  let withoutBrowser = 0;
  for (const r of runs) {
    if (!r.runBrowser) {
      withoutBrowser++;
      continue;
    }
    const entry = byBrowser.get(r.runBrowser) ?? { runs: 0, failed: 0 };
    entry.runs++;
    if (r.status === "failed") entry.failed++;
    byBrowser.set(r.runBrowser, entry);
  }
  const rows = [...byBrowser.entries()].map(([browser, e]) => ({
    browser,
    failed: e.failed,
    runs: e.runs,
  }));
  // Needs at least two engines to be ABOUT the engine, and no un-attributed
  // runs muddying the comparison — the same two guards the dataset rule uses.
  if (rows.length < 2 || withoutBrowser > 0) {
    return { rows: rows.filter((r) => r.failed > 0), browserDependent: false };
  }
  const alwaysFails = rows.filter((r) => r.failed === r.runs);
  const alwaysPasses = rows.filter((r) => r.failed === 0);
  const browserDependent =
    alwaysFails.length > 0 &&
    alwaysPasses.length > 0 &&
    alwaysFails.length + alwaysPasses.length === rows.length;
  return { rows: rows.filter((r) => r.failed > 0), browserDependent };
}

/**
 * Transitions counted WITHIN each engine, then summed.
 *
 * A state change only means something between two runs that were comparable.
 * Counting chromium-pass -> webkit-fail as a change is counting the engine, not
 * the test. Runs with no engine recorded fall into one group, which is exactly
 * the old behaviour for a history that predates the picker.
 *
 * Returns the pairs it counted over as well, since the flake RATE has to be
 * over the same population — three engines of four runs each offer nine
 * adjacent pairs, not eleven.
 */
function transitionsByBrowser(runs) {
  const groups = new Map();
  for (const r of runs) {
    const key = r.runBrowser ?? "";
    const list = groups.get(key) ?? [];
    // The SIGNAL, not the status: a retried pass is a "failed" entry here and
    // a "passed" one in the outcome tally below. Both are true of it, and
    // which one a caller wants depends on the question — see
    // shared/run-attempts.mjs.
    list.push(flakeSignal(r));
    groups.set(key, list);
  }
  let transitions = 0;
  let pairs = 0;
  for (const statuses of groups.values()) {
    transitions += countTransitions(statuses);
    pairs += Math.max(0, statuses.length - 1);
  }
  return { transitions, pairs };
}

/**
 * Analyse a run history.
 *
 * `records` may be in any order; they're sorted oldest-first here, because
 * transitions are meaningless otherwise and `runHistoryStore.list()` returns
 * newest-first — an easy and completely silent mistake to make at a call site.
 */
export function analyseFlake(records, details = []) {
  const detailById = new Map(details.map((d) => [d.runId, d]));
  // Baseline-update events aren't executions and would distort every count.
  //
  // A run the USER stopped is excluded for the same reason, one step further
  // on: it is an execution, but its outcome is a keystroke rather than evidence
  // about the test. Because this function counts TRANSITIONS between
  // consecutive runs, a stop inserted between two passes manufactures two of
  // them — so three interrupted runs over a week are enough to move an
  // eight-run test to "flaky", which is the one verdict that sends someone
  // hunting for a race condition that is not there.
  //
  // `process-timeout` is deliberately NOT excluded. That run really did fail:
  // the test outran its budget and hung, which is exactly the kind of
  // intermittent behaviour this analysis exists to surface. Dropping it would
  // be the opposite mistake — hiding a real flake rather than inventing one.
  const runs = records.filter(
    (r) => (r.kind ?? "run") === "run" && r.endedBy !== "user",
  );

  const byTest = new Map();
  for (const r of runs) {
    const list = byTest.get(r.testId) ?? [];
    list.push(r);
    byTest.set(r.testId, list);
  }

  const tests = [];
  for (const [testId, unsorted] of byTest) {
    const testRuns = [...unsorted].sort((a, b) => a.startedAt - b.startedAt);
    const statuses = testRuns.map((r) => r.status);
    // Segmented, not sequential — see `transitionsByBrowser`.
    const { transitions, pairs } = transitionsByBrowser(testRuns);
    const { rows, dataDependent } = analyseDatasets(testRuns);
    const { rows: browserRows, browserDependent } = analyseBrowsers(testRuns);

    // Per-step: which step was the failure point, and which needed healing.
    const stepStats = new Map();
    let healedRuns = 0;
    // Runs that went red and recovered inside themselves. Counted from the
    // runs rather than from `details`, because it is a property of the record
    // and every run has one — `details` covers only runs with a replay.
    const retriedRuns = testRuns.filter((r) => r.passedOnRetry === true).length;
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
      // Over the pairs the transitions were actually counted over, or three
      // engines would divide a per-engine count by a whole-history denominator
      // and report a third of the real rate.
      flakeRate: pairs > 0 ? transitions / pairs : 0,
      verdict: verdictFor(statuses, transitions, dataDependent, browserDependent, retriedRuns),
      failingDatasets: rows,
      failingBrowsers: browserRows,
      steps,
      healedRuns,
      // Beside `healedRuns` and for the same reason: a pass that only happened
      // because something was retried is not the same evidence as a pass that
      // happened. The verdict already accounts for it; this is what lets a
      // reader see how much of a "flaky" verdict is retries.
      retriedRuns,
    });
  }

  // Cluster failures across every test: one root cause showing up in twenty
  // runs should read as one problem, not twenty.
  const clusters = new Map();
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
    clusters: [...clusters.values()].sort(
      (a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt,
    ),
    analysedTests: tests.filter((t) => t.verdict !== "unknown").length,
  };
}

/** Sort order for verdicts — what a person should look at first. */
function verdictRank(v) {
  switch (v) {
    case "flaky":
      return 0;
    case "data-dependent":
      return 1;
    // Beside data-dependent, not below "changed-since": both name a CAUSE, and
    // a named cause is what someone can act on this morning.
    case "browser-dependent":
      return 2;
    case "changed-since":
      return 3;
    case "still-failing":
      return 4;
    case "fixed":
      return 5;
    case "stable":
      return 6;
    default:
      return 7;
  }
}
