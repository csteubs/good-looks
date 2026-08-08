// Run + artifacts → metric rows.
//
// Pure (see the admission rule in run-pacing.mjs): everything is handed in
// already read. Reading it off disk is metrics-store.ts's job on the app side
// and the MCP's on the other, and keeping the reading out of here is what lets
// one function serve all three write points — the app runner, the batch runner,
// and the MCP's executeTest — so they cannot drift in what a run means.
//
// THE INDEX PROBLEM, which is the whole reason this file is careful.
//
// This app counts steps two different ways and both appear in the inputs:
//
//   • Step[] order — what the test record, the UI and replay.json use.
//   • ACTION order — what the capture fixture numbers screenshots by, and what
//     it tags every console.json and network.json entry with. It counts only
//     steps that perform a page action, so an assertion or a wait advances one
//     and not the other.
//
// Joining logs to steps therefore needs a translation, and getting it wrong is
// silent: every number still lands in a row, just against the wrong step. The
// translation is `ReplayStep.actionIndex`, which buildReplay records because it
// is the thing that matched the manifest entry in the first place. Nothing here
// re-derives it — a second implementation of that matching is exactly how the
// two would drift.

import { errorSignature, firstErrorLine } from "./error-signature.mjs";
import { stripAnsi } from "./strip-ansi.mjs";

/**
 * The ACTION index for a replay step.
 *
 * `actionIndex` is authoritative and is what buildReplay records. Every
 * replay.json written before 2026-08-07 predates that field, so for the whole
 * existing history — which the backfill is about to read — it falls back to the
 * screenshot's FILENAME, which the builder names after exactly the same number.
 *
 * The fallback is not a second implementation of the matching: it reads back
 * what the one implementation already wrote. It recovers nothing for a step
 * whose screenshot failed or was never attempted (an a11y-only or logs-only
 * run), and that is the honest answer there — undefined means "no join", and a
 * step with no join must contribute no network or console rather than borrow
 * another step's.
 */
function actionIndexOf(step) {
  if (typeof step?.actionIndex === "number") return step.actionIndex;
  const m = /^(\d+)\.png$/.exec(String(step?.screenshot ?? ""));
  return m ? Number(m[1]) : undefined;
}

/** Worst (highest) HTTP status among a set of requests, or undefined when none
 *  had a status. `0` is what the fixture records for a request that never got a
 *  response at all (blocked, DNS, CORS) and is deliberately NOT treated as a
 *  status — it would sort as the best one. */
function worstStatus(entries) {
  let worst;
  for (const e of entries) {
    const s = Number(e?.status ?? 0);
    if (!s) continue;
    if (worst === undefined || s > worst) worst = s;
  }
  return worst;
}

/** A request the page navigated to, as opposed to one it called.
 *
 *  The distinction matters because a 4xx means opposite things on either side:
 *  on a navigation it is very often the page under test (a 404 page is a
 *  legitimate thing to have a test for), and on anything else it means an API
 *  contract broke. */
function isNavigation(entry) {
  return entry?.resourceType === "document";
}

/**
 * Group console and network entries by the ACTION index they were tagged with.
 *
 * Entries arrive flat with a `step` field that is an action index. Everything
 * downstream wants them per step, so this is the one place the grouping
 * happens.
 */
function byAction(entries) {
  const out = new Map();
  for (const e of entries ?? []) {
    const key = Number(e?.step ?? -1);
    if (!Number.isFinite(key) || key < 0) continue;
    const list = out.get(key);
    if (list) list.push(e);
    else out.set(key, [e]);
  }
  return out;
}

/**
 * Build the rows for one run.
 *
 * @param {object} input
 * @param {object} input.run            the RunRecord
 * @param {object|null} input.replay    replay.json, or null when the run captured nothing
 * @param {object|null} input.manifest  manifest.json, for the per-step durations
 * @param {object|null} input.logs      { console, network }, or null
 * @param {Array}  input.healFailures   heal-failures.json entries
 * @param {Array}  input.heals          heal-journal entries for THIS run
 * @param {string} input.logText        the run's raw log, for the error signature
 * @param {"app"|"mcp"} input.source
 * @returns {{ run: object, steps: object[] }}
 *
 * IDEMPOTENT BY CONSTRUCTION: the output is a pure function of the inputs and
 * every row carries its own primary key, so ingesting the same run twice
 * produces one row set rather than two. The backfill and the write-through path
 * can both reach the same run, and neither knows about the other.
 */
export function rollupRun(input) {
  const run = input.run ?? {};
  const replay = input.replay ?? null;
  const logs = input.logs ?? null;
  const healFailures = input.healFailures ?? [];

  const consoleByAction = byAction(logs?.console);
  const networkByAction = byAction(logs?.network);

  // Manifest entries keyed by their own action index, for the step durations.
  const manifestByAction = new Map();
  for (const e of input.manifest?.steps ?? []) {
    if (typeof e?.index === "number") manifestByAction.set(e.index, e);
  }

  // Keyed by stepId, not by index: both a heal and a failed attempt record the
  // index they saw at run time, and matching on that would break the moment a
  // step moved.
  const failureByStepId = new Map();
  for (const f of healFailures) {
    if (f?.stepId) failureByStepId.set(f.stepId, f.outcome);
  }
  const healedStepIds = new Set();
  for (const h of input.heals ?? []) {
    if (h?.stepId) healedStepIds.add(h.stepId);
  }

  const steps = (replay?.steps ?? []).map((s) => {
    // `undefined` rather than a default: a step with no action index captured
    // nothing, and there is no console or network to attribute to it. Falling
    // back to the step index would silently attribute ANOTHER step's requests
    // to it, which reads as evidence rather than as a missing join.
    const action = actionIndexOf(s);
    const net = action === undefined ? [] : (networkByAction.get(action) ?? []);
    const con = action === undefined ? [] : (consoleByAction.get(action) ?? []);
    const apiCalls = net.filter((e) => !isNavigation(e));

    return {
      run_id: run.id,
      step_index: s.index,
      step_id: s.stepId,
      action_index: action,
      label: s.label,
      type: s.type,
      status: s.status,
      // `stepMs`, NOT the manifest's `ms`. The latter times the SCREENSHOT and
      // is summed into captureMs; reading it here would make "this step went
      // from 1.2s to 4.8s" a statement about how long a PNG took to write.
      // Absent on runs recorded before the fixture measured the action itself,
      // and deliberately left null there rather than substituted.
      ms: action === undefined ? undefined : manifestByAction.get(action)?.stepMs,
      diff_state: s.diff?.state,
      diff_ratio: s.diff?.ratio,
      a11y_violations: s.a11y ? (s.a11y.violations?.length ?? 0) : undefined,
      a11y_new: s.a11y ? (s.a11y.newKeys?.length ?? 0) : undefined,
      healed: healedStepIds.has(s.stepId) ? 1 : 0,
      heal_failed: failureByStepId.get(s.stepId),
      net_requests: action === undefined ? undefined : net.length,
      net_failures: action === undefined ? undefined : net.filter((e) => !e?.ok).length,
      net_worst_status: worstStatus(net),
      net_worst_api_status: worstStatus(apiCalls),
      net_total_ms:
        action === undefined ? undefined : net.reduce((sum, e) => sum + Number(e?.ms ?? 0), 0),
      console_errors:
        action === undefined
          ? undefined
          : con.filter((e) => e?.type === "error" || e?.type === "pageerror").length,
      // The page's own JavaScript throwing — the strong half, kept apart from
      // console.error, which plenty of healthy sites emit on every load.
      console_page_errors:
        action === undefined ? undefined : con.filter((e) => e?.type === "pageerror").length,
    };
  });

  const failedStep =
    replay && replay.failedIndex !== null && replay.failedIndex !== undefined
      ? replay.steps?.[replay.failedIndex]
      : undefined;

  return {
    run: {
      id: run.id,
      test_id: run.testId,
      test_name: run.testName,
      url: run.url,
      status: run.status,
      kind: run.kind ?? "run",
      started_at: run.startedAt,
      duration_ms: run.durationMs ?? Math.max(0, (run.finishedAt ?? 0) - (run.startedAt ?? 0)),
      browser: run.runBrowser,
      speed: run.speed,
      headless: run.runHeadless,
      batch_id: run.batchId,
      dataset_id: run.datasetId,
      dataset_name: run.datasetName,
      healed_steps: run.healedSteps ?? 0,
      heal_failed_steps: run.healFailedSteps ?? healFailures.length,
      a11y_ms: run.a11yMs,
      a11y_checks: run.a11yChecks,
      a11y_new_steps: run.a11yNewSteps,
      capture_ms: run.captureOverheadMs,
      shot_count: run.shotCount,
      test_timeout_ms: run.testTimeoutMs,
      failed_step_id: failedStep?.stepId,
      // Computed at INGEST, not on read: the log this comes from is capped at
      // 1000 runs and pruned out from under any later reader.
      //
      // ANSI is stripped FIRST. Playwright colours its failures and the escape
      // sequences land inside the message, so an unstripped signature is full
      // of control characters and matches no other run unless that one happened
      // to be coloured identically. Every log written before 2026-08-07 is
      // still on disk with its colours in, which is most of the history this
      // rolls up.
      error_signature: errorSignature(firstErrorLine(stripAnsi(input.logText ?? ""))),
      source: input.source ?? "app",
      // The difference between "captured nothing, so there is no evidence" and
      // "captured, and had nothing to report". Without it a run with no step
      // rows reads as the second when it is the first — and the triage
      // classifier's honest `unknown` depends on telling them apart.
      has_artifacts: Boolean(replay),
      // How much of the evidence was thrown away before it reached disk. The
      // fixture's head/tail cap is OVERALL, not per step, so on a busy site
      // whole steps can end up with nothing recorded. A query that cannot see
      // this reports "no failing request on that step" for a step whose
      // requests were simply discarded.
      console_dropped: logs?.consoleDropped ?? 0,
      network_dropped: logs?.networkDropped ?? 0,
      replay_of_run_id: run.replayOfRunId,
    },
    steps,
  };
}
