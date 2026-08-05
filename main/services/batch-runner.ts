// Batch (suite) runs — execute a set of tests back to back and report an
// aggregate result.
//
// Tests run STRICTLY SEQUENTIALLY. `playwrightRunner.start` is keyed by testId,
// so the runner would happily run several tests at once, but each run spawns its
// own Playwright process and browser: running a library of tests in parallel
// would contend for CPU and, worse, make headed runs fight over the screen.
// Sequential also keeps the existing per-run event stream (runner:output /
// runner:step / runner:done, all keyed by runId === testId) unambiguous for the
// renderer, which already renders exactly one live run.
//
// Only one batch runs at a time. Each test's own RunRecord is still written by
// the runner, so a batch shows up in Stats as ordinary runs — the batch is a
// driver, not a new kind of history.
//
// The runner is injected (see BatchDeps) so the queue's sequencing, skipping,
// and cancellation can be exercised by check:batch-runner without spawning
// browsers.

import { randomUUID } from "crypto";

import { logger } from "@glaze/core/backend";

import { sendToMain } from "./app-window.js";
import { playwrightRunner } from "./playwright-runner.js";
import { testStore } from "./test-store.js";
import { batchHistoryStore } from "./batch-history-store.js";
import { sendAlert, type BatchAlert } from "./alert-service.js";
import type {
  BatchState,
  BatchSummary,
  BatchTestStatus,
  Dataset,
  RunBrowser,
} from "../recorder/types.js";

// The batch data model is canonical in ../recorder/types.js (shared with the
// history store and mirrored in the renderer); re-exported here so callers that
// already import from this module keep working.
export type {
  BatchTestStatus,
  BatchTestResult,
  BatchSummary,
  BatchState,
  BatchRecord,
} from "../recorder/types.js";

export interface BatchRunParams {
  testIds: string[];
  captureArtifacts?: boolean;
  runHeadless?: boolean;
  browser?: RunBrowser;
  /** Run each selected test once per dataset row instead of once. Names a
   *  subset of row ids, or use `allDatasets` for every row a test has.
   *  A test with no matching rows still runs once, with its declared defaults —
   *  dropping it would turn "sweep my suite" into "silently skip the tests that
   *  aren't parameterized yet". */
  datasetIds?: string[];
  /** Sweep every dataset row each selected test declares. */
  allDatasets?: boolean;
}

/** One queued execution: a test, optionally bound to a dataset row. */
export interface BatchEntry {
  testId: string;
  datasetId?: string;
  datasetName?: string;
  vars?: Record<string, string>;
}

/**
 * Expand a selection into the queue actually executed.
 *
 * Pure, and separated from the runner, because this is where a sweep gets its
 * meaning: without dataset options the queue is exactly the selection (so
 * nothing about existing batches changes), and with them the same test appears
 * once per matching row, in the order the rows are declared.
 */
export function buildQueue(
  params: BatchRunParams,
  getDatasets: (testId: string) => Dataset[],
): BatchEntry[] {
  const wantsSweep = params.allDatasets === true || (params.datasetIds?.length ?? 0) > 0;
  if (!wantsSweep) return params.testIds.map((testId) => ({ testId }));
  const wanted = new Set(params.datasetIds ?? []);
  const out: BatchEntry[] = [];
  for (const testId of params.testIds) {
    const rows = getDatasets(testId).filter(
      (d) => params.allDatasets === true || wanted.has(d.id),
    );
    if (rows.length === 0) {
      out.push({ testId });
      continue;
    }
    for (const row of rows) {
      out.push({ testId, datasetId: row.id, datasetName: row.name, vars: row.values });
    }
  }
  return out;
}

/** Seam for testing — the real implementations talk to the Playwright runner,
 *  the test store, and the renderer. */
export interface BatchDeps {
  getTestName: (testId: string) => string | null;
  /** Dataset rows declared by a test, for expanding a sweep. */
  getDatasets: (testId: string) => Dataset[];
  startRun: (params: {
    testId: string;
    headed: boolean;
    captureArtifacts?: boolean;
    runHeadless?: boolean;
    browser?: RunBrowser;
    batchId?: string;
    vars?: Record<string, string>;
    datasetId?: string;
    datasetName?: string;
  }) => { runId: string; recordId?: string; alreadyRunning?: boolean };
  /** Resolves with the run's exit code, or null if the run isn't in flight. */
  waitFor: (runId: string) => Promise<number> | null;
  stopRun: (runId: string) => void;
  emit: (channel: string, payload: unknown) => void;
  now: () => number;
  /** Write-through persistence, called on every transition so a crash
   *  mid-batch still leaves the results collected so far. */
  persist: (record: BatchState & { summary: BatchSummary }) => void;
  /** Fire-and-forget outgoing alert when the batch finishes. */
  alert: (alert: BatchAlert) => void;
}

const realDeps: BatchDeps = {
  getTestName: (testId) => testStore.get(testId)?.name ?? null,
  getDatasets: (testId) => testStore.get(testId)?.datasets ?? [],
  startRun: (params) => playwrightRunner.start(params),
  waitFor: (runId) => playwrightRunner.waitFor(runId),
  stopRun: (runId) => playwrightRunner.stop(runId),
  emit: (channel, payload) => sendToMain(channel, payload),
  now: () => Date.now(),
  persist: (record) => {
    batchHistoryStore.save(record);
  },
  alert: (alert) => {
    void sendAlert(alert);
  },
};

/** `now` is passed in rather than read from a clock so a mid-run summary can
 *  report elapsed time, and so the check can drive it deterministically. */
export function summarize(state: BatchState, now: number): BatchSummary {
  const passed = state.results.filter((r) => r.status === "passed").length;
  const failed = state.results.filter((r) => r.status === "failed").length;
  const skipped = state.results.filter((r) => r.status === "skipped").length;
  return {
    total: state.results.length,
    passed,
    failed,
    skipped,
    // A batch is "ok" only if something ran and nothing failed. An all-skipped
    // batch is not a pass.
    ok: failed === 0 && passed > 0,
    durationMs: Math.max(0, (state.finishedAt ?? now) - state.startedAt),
  };
}

export function createBatchRunner(deps: BatchDeps = realDeps) {
  let state: BatchState | null = null;
  /** flipped by stop(); the loop checks it between tests */
  let cancelled = false;

  const snapshot = (): BatchState | null => (state ? { ...state, results: [...state.results] } : null);

  const emitProgress = (): void => {
    if (!state) return;
    const payload = { ...snapshot(), summary: summarize(state, deps.now()) } as BatchState & {
      summary: BatchSummary;
    };
    deps.emit("batch:progress", payload);
    // Write-through: the same payload the UI just got is what lands on disk, so
    // a batch interrupted by a crash reloads exactly as far as it got.
    deps.persist(payload);
  };

  return {
    /** Start a batch. Returns the new batch's id, or the in-flight batch's id
     *  if one is already running (batches don't queue behind each other — the
     *  UI disables Run while one is active). */
    start(params: BatchRunParams): { batchId: string; alreadyRunning: boolean } {
      if (state?.running) {
        return { batchId: state.batchId, alreadyRunning: true };
      }
      const batchId = randomUUID();
      cancelled = false;
      const queue = buildQueue(params, deps.getDatasets);
      state = {
        batchId,
        running: true,
        startedAt: deps.now(),
        currentIndex: -1,
        stopped: false,
        results: queue.map((entry) => ({
          testId: entry.testId,
          testName: deps.getTestName(entry.testId) ?? entry.testId,
          status: "pending" as BatchTestStatus,
          ...(entry.datasetId ? { datasetId: entry.datasetId } : {}),
          ...(entry.datasetName ? { datasetName: entry.datasetName } : {}),
        })),
      };
      logger.info("batch", "Batch run started", {
        batchId,
        total: queue.length,
        tests: params.testIds.length,
      });
      emitProgress();

      void (async () => {
        const s = state;
        if (!s) return;
        for (let i = 0; i < s.results.length; i++) {
          const entry = s.results[i];
          if (cancelled) {
            entry.status = "skipped";
            entry.note = "Batch stopped";
            continue;
          }
          // A test deleted after the batch was queued is skipped, not fatal —
          // the rest of the batch is still worth running.
          if (deps.getTestName(entry.testId) === null) {
            entry.status = "skipped";
            entry.note = "Test no longer exists";
            emitProgress();
            continue;
          }
          s.currentIndex = i;
          entry.status = "running";
          entry.startedAt = deps.now();
          emitProgress();

          let exitCode = -1;
          try {
            const { runId, recordId, alreadyRunning } = deps.startRun({
              testId: entry.testId,
              headed: !params.runHeadless,
              captureArtifacts: params.captureArtifacts,
              runHeadless: params.runHeadless,
              browser: params.browser,
              batchId,
              // Read from the queue, not from `entry`: BatchState is persisted
              // to disk on every transition, and a dataset row's values have no
              // business being written into batch-history.json.
              vars: queue[i]?.vars,
              datasetId: entry.datasetId,
              datasetName: entry.datasetName,
            });
            // Recorded even if the run later fails, so a persisted batch can
            // link through to the run's log in Stats.
            if (recordId) entry.runRecordId = recordId;
            // `alreadyRunning` means the runner declined to start a new run
            // because this test was mid-run already. Awaiting it would attribute
            // a run the batch didn't start (different options, no batchId) to
            // this entry — so skip instead. The null-waitFor check below is the
            // backstop for a run that finished between start and waitFor.
            const pending = alreadyRunning ? null : deps.waitFor(runId);
            if (pending === null) {
              entry.status = "skipped";
              entry.note = "That test was already running";
              entry.finishedAt = deps.now();
              entry.durationMs = entry.finishedAt - (entry.startedAt ?? entry.finishedAt);
              emitProgress();
              continue;
            }
            exitCode = await pending;
          } catch (err) {
            // start() throws for a missing/unreplayable test — record it
            // against this entry and keep going.
            logger.warn("batch", "Test failed to start", {
              testId: entry.testId,
              err: String(err),
            });
            entry.status = "failed";
            entry.note = String(err);
            entry.finishedAt = deps.now();
            entry.durationMs = entry.finishedAt - (entry.startedAt ?? entry.finishedAt);
            emitProgress();
            continue;
          }

          entry.exitCode = exitCode;
          entry.status = exitCode === 0 ? "passed" : "failed";
          entry.finishedAt = deps.now();
          entry.durationMs = entry.finishedAt - (entry.startedAt ?? entry.finishedAt);
          emitProgress();
        }

        s.running = false;
        s.currentIndex = -1;
        s.finishedAt = deps.now();
        s.stopped = cancelled;
        const summary = summarize(s, s.finishedAt);
        logger.info("batch", "Batch run finished", { batchId, ...summary });
        const donePayload = { ...snapshot(), summary } as BatchState & { summary: BatchSummary };
        deps.emit("batch:done", donePayload);
        deps.persist(donePayload);
        // One alert for the suite rather than one per test (the per-run alert
        // is suppressed for batched runs).
        deps.alert({
          kind: "batch",
          summary,
          failedTests: s.results.filter((r) => r.status === "failed").map((r) => r.testName),
          stopped: s.stopped,
          browser: params.browser,
        });
      })();

      return { batchId, alreadyRunning: false };
    },

    /** Stop the batch: kill the test currently running and skip the rest.
     *  Already-finished results are kept. */
    stop(): void {
      if (!state?.running) return;
      cancelled = true;
      const current = state.results[state.currentIndex];
      if (current && current.status === "running") {
        deps.stopRun(current.testId);
      }
      logger.info("batch", "Batch run stopping", { batchId: state.batchId });
    },

    /** Current batch state (including a finished batch's results), or null if
     *  no batch has run this session. */
    getState(): (BatchState & { summary: BatchSummary }) | null {
      if (!state) return null;
      const snap = snapshot();
      if (!snap) return null;
      return {
        ...snap,
        summary: summarize(state, state.finishedAt ?? deps.now()),
      };
    },
  };
}

export const batchRunner = createBatchRunner();
