// Batch (suite) runs — execute a set of tests and report an aggregate result.
//
// Tests run ONE AT A TIME by default. `concurrency` raises that, and the whole
// design of this file is about what makes raising it safe:
//
// `playwrightRunner.start` keys a run by testId — runId === testId — and so
// does every per-run map it owns, plus the runner:output / runner:step /
// runner:done stream the renderer's run store is keyed by. Two DIFFERENT tests
// in flight are therefore already unambiguous. The SAME test twice is not:
// start() declines with `alreadyRunning`, and the entry would be skipped.
//
// Two things queue the same test more than once — a dataset sweep (one entry
// per row) and a multi-engine row in the Batch view (one entry per browser) —
// so the queue is partitioned into LANES keyed by testId. Lanes run
// concurrently up to the limit; entries within a lane stay sequential. That
// keeps runId === testId true without touching the runner, and it means the
// real ceiling is the number of DISTINCT tests queued, not the queue length.
//
// The cost is that one test on three engines runs them one after another rather
// than three-up. Lifting that would mean re-keying every per-run map in
// playwright-runner AND the runner:* event key the renderer's run store
// consumes — a large change for parallelism inside a single test, which is not
// the case anyone hit. See docs/DECISIONS.md.
//
// Because buildQueue emits a test's rows contiguously, lane order at limit 1 is
// exactly queue order — the sequential path is the same code, not a parallel
// path pretending. check:batch-runner pins that.
//
// Only one batch runs at a time. Each test's own RunRecord is still written by
// the runner, so a batch shows up in Stats as ordinary runs — the batch is a
// driver, not a new kind of history.
//
// The runner is injected (see BatchDeps) so the queue's sequencing, skipping,
// and cancellation can be exercised by check:batch-runner without spawning
// browsers.

import { randomUUID } from "crypto";

import { logger } from "@shell/backend";

import { sendToMain } from "./app-window.js";
import { playwrightRunner } from "./playwright-runner.js";
import { testStore } from "./test-store.js";
import { batchHistoryStore } from "./batch-history-store.js";
import { sendAlert, type BatchAlert } from "./alert-service.js";
import {
  notifyBatchOutcome,
  notifyRoutineMessage,
  type BatchOutcomeNotice,
} from "./run-notifier.js";
import { recorderSettingsStore } from "./recorder-settings-store.js";
import { buildQueue } from "../../shared/batch-queue.mjs";
import type { BatchEntry, PerTestRunOption } from "../../shared/batch-queue.mjs";
import type { RunTrigger } from "../../shared/run-trigger.mjs";
import { clampBatchConcurrency } from "../recorder/types.js";
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
  /** How many tests to run at once. Absent or 1 = strictly one at a time (the
   *  default, and the behaviour every batch had before this option existed).
   *  Clamped down to the number of distinct tests queued, and to
   *  MAX_BATCH_CONCURRENCY — asking for more than either is not an error, it
   *  just runs what it can. */
  concurrency?: number;
  /** Per-test engines and headedness from the Batch view's rows. A test named
   *  here runs once per engine listed; a test NOT named here (the MCP path, or
   *  any caller that never had rows) falls back to the batch-wide `browser` and
   *  `runHeadless` above, so those two must keep working unchanged. */
  perTest?: PerTestRunOption[];
  /** Where the run must JOIN and pause. `routineRunPlan` cuts a Routine's steps
   *  at each `wait` and labels every `perTest` entry with its segment; this is
   *  the list of pauses between them.
   *
   *  Absent for every caller that has no `wait` steps — `batch:run`, the MCP's
   *  `run_batch`, and every Routine that predates them — and an absent list is
   *  one segment, which is exactly the execution those callers already had. */
  barriers?: BatchBarrier[];
  /** The Routine this batch is a run OF, when there is one. Recorded on the
   *  state and so on the persisted record; the runner does nothing else with
   *  it. Absent for `batch:run` and for the MCP, which are not Routines. */
  routineId?: string;
  /** The Routine's NAME, for a `notify` step's message to name the job it came
   *  from. Carried rather than looked up because the runner has no routine
   *  store — and because the name at the moment the run STARTED is the honest
   *  one to report, even if the job is renamed mid-run. */
  routineName?: string;
  /** WHO asked for this batch, stamped onto every RunRecord it produces.
   *  Absent means `manual`, which is what `batch:run` and `routines:run` are.
   *  The scheduler passes `schedule`, and that is the whole point: a Routine
   *  has both a manual path and a timed one, so `routineId` alone cannot say
   *  whether a person was there. */
  trigger?: RunTrigger;
}

// Expanding a selection into the queue actually executed lives in
// shared/batch-queue.mjs, so the MCP's run_batch sweeps datasets with the same
// semantics rather than a second implementation of them. The per-engine fan-out
// lives there too, for the same reason and with the same constraint: a test's
// entries must stay contiguous or buildLanes below reorders the queue.
// Re-exported because this module is where the app and check:batch-runner
// already import them from.
export type { BatchEntry, PerTestRunOption } from "../../shared/batch-queue.mjs";
export { buildQueue } from "../../shared/batch-queue.mjs";

/** A join in the run: everything in `afterSegment` finishes, the run pauses for
 *  `ms`, then the next segment starts. */
export interface BatchBarrier {
  afterSegment: number;
  /** How long to pause. 0 for a barrier that only notifies. */
  ms: number;
  /** A message to send at this join, from a `notify` step. Plain text the user
   *  wrote — never interpolated from run data. */
  notify?: { channel: "desktop" | "webhook"; message: string };
  /** A two-way choice. BOTH sides are already in the queue; the runner marks
   *  whichever segment the condition did not choose as skipped. */
  branch?: {
    id: string;
    on: "anyFailed" | "allPassed";
    thenSegment: number;
    elseSegment: number;
  };
}

/**
 * Partition a queue into lanes of entry indices, one lane per distinct testId.
 *
 * This is what makes concurrency safe. Everything in the runner is keyed by
 * testId (runId === testId), so two entries for the SAME test must never be in
 * flight together — start() would decline the second with `alreadyRunning` and
 * the row would be reported as skipped, which for a dataset sweep means
 * silently not running half the rows you asked for.
 *
 * Lane order is first-appearance order, and a test's rows are contiguous in the
 * queue, so flattening the lanes reproduces the queue exactly — which is why
 * running with one worker is indistinguishable from the old sequential loop.
 */
export function buildLanes(queue: BatchEntry[]): number[][] {
  const byTest = new Map<string, number[]>();
  for (let i = 0; i < queue.length; i++) {
    const lane = byTest.get(queue[i].testId);
    if (lane) lane.push(i);
    else byTest.set(queue[i].testId, [i]);
  }
  return [...byTest.values()];
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
    trigger?: RunTrigger;
  }) => { runId: string; recordId?: string; alreadyRunning?: boolean };
  /** Resolves with the run's exit code, or null if the run isn't in flight. */
  waitFor: (runId: string) => Promise<number> | null;
  stopRun: (runId: string) => void;
  /** Hold for `ms`, returning early when `cancelled()` becomes true.
   *
   *  INJECTED so `check:batch-runner` can drive a barrier without the check
   *  actually sleeping — a real timer would make the one test that proves the
   *  join happens the slowest thing in the suite, which is how a test gets
   *  deleted. The real one polls rather than racing a single timeout, so a stop
   *  during a wait ends it promptly instead of after the full duration. */
  wait: (ms: number, cancelled: () => boolean) => Promise<void>;
  emit: (channel: string, payload: unknown) => void;
  now: () => number;
  /** Write-through persistence, called on every transition so a crash
   *  mid-batch still leaves the results collected so far. */
  persist: (record: BatchState & { summary: BatchSummary }) => void;
  /** Fire-and-forget outgoing alert when the batch finishes. */
  alert: (alert: BatchAlert) => void;
  /** A Routine's `notify` step reached its point in the run.
   *
   *  SEPARATE FROM `alert` because the two have different rules: `alert` is
   *  conditional on a failure and goes only to the webhook, while a notify is
   *  the thing the user asked for and can go to the desktop instead. Routing
   *  lives on the far side of this seam so the runner never learns which
   *  channels exist. */
  notifyStep: (notify: {
    channel: "desktop" | "webhook";
    message: string;
    routineName: string;
  }) => void;
  /** Local desktop notification for the finished suite. Separate from `alert`
   *  (an outgoing webhook) because they have different defaults, different
   *  audiences, and — unlike the webhook — this one fires on success too. */
  notify: (notice: BatchOutcomeNotice) => void;
}

const realDeps: BatchDeps = {
  getTestName: (testId) => testStore.get(testId)?.name ?? null,
  getDatasets: (testId) => testStore.get(testId)?.datasets ?? [],
  startRun: (params) => playwrightRunner.start(params),
  waitFor: (runId) => playwrightRunner.waitFor(runId),
  stopRun: (runId) => playwrightRunner.stop(runId),
  // Routed here rather than in the runner: `desktop` is local and always
  // available, `webhook` goes through `alert-service` — the app's ONLY egress,
  // inert until the user configures a URL, and redacting on the way out. Both
  // are best-effort, because a notification that fails must not affect the run
  // it was describing.
  notifyStep: ({ channel, message, routineName }) => {
    if (channel === "desktop") {
      notifyRoutineMessage(routineName, message);
      return;
    }
    sendAlert({ kind: "routineNotify", message, routineName });
  },
  // Polled in slices rather than one `setTimeout(ms)`, so Stop ends a wait
  // within a tick instead of after however long was left — for the one-hour
  // ceiling that difference is "Stop is broken".
  wait: async (ms, cancelled) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (cancelled()) return;
      await new Promise((r) => setTimeout(r, Math.min(200, until - Date.now())));
    }
  },
  emit: (channel, payload) => sendToMain(channel, payload),
  now: () => Date.now(),
  persist: (record) => {
    batchHistoryStore.save(record);
  },
  alert: (alert) => {
    void sendAlert(alert);
  },
  notify: (notice) => {
    if (!recorderSettingsStore.get().notifyOnBatchDone) return;
    notifyBatchOutcome(notice);
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
    // Derived, not assigned by the loop: with several entries in flight there
    // is no single "current" one. The LOWEST running index is the closest
    // honest answer, and it degrades to exactly the old meaning when only one
    // runs — which matters because currentIndex is persisted, and batch records
    // written before this option existed are still read back. -1 when idle, the
    // same sentinel as before (findIndex's miss value).
    state.currentIndex = state.results.findIndex((r) => r.status === "running");
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
        ...(params.routineId ? { routineId: params.routineId } : {}),
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
          // Same reasoning as datasetId: without it, three results for one test
          // are indistinguishable in the view and in batch-history.json.
          ...(entry.browser ? { browser: entry.browser } : {}),
        })),
      };
      const lanes = buildLanes(queue);
      // Never more workers than there are lanes: asking for 8 when only 3
      // distinct tests are queued would leave five workers spinning on an empty
      // lane list, and — more importantly — would make the number the user was
      // warned about ("8 windows") differ from the number that opens.
      const limit = clampBatchConcurrency(params.concurrency, lanes.length);
      logger.info("batch", "Batch run started", {
        batchId,
        total: queue.length,
        tests: params.testIds.length,
        lanes: lanes.length,
        concurrency: limit,
      });
      emitProgress();

      void (async () => {
        const s = state;
        if (!s) return;

        /**
         * A step said "stop the routine if I fail", and it failed.
         *
         * THE SAME THING `stop()` DOES, deliberately — kill everything in
         * flight, skip everything not started, keep what finished. Anything
         * gentler would be a second meaning of "stop" and would leave the user
         * watching browsers finish work the job already said not to do. With
         * lanes running concurrently there is no "the rest of the queue" to
         * simply not start: entries are already open.
         *
         * FIRST FAILURE WINS. Two lanes can fail in the same tick, and the
         * second one arriving would otherwise rewrite whose failure stopped the
         * job — the note, the alert and the notification would all name a test
         * that stopped nothing. `cancelled` is the guard, so a user pressing
         * Stop a moment earlier also keeps its own attribution.
         *
         * The policy is read from the QUEUE, not from `entry`: BatchState is
         * persisted on every transition and a per-step policy is not something
         * batch-history.json needs to carry.
         */
        /**
         * Decide a `branch`, and skip the side it did not choose.
         *
         * EVALUATED AGAINST THE RUN SO FAR, not against the immediately
         * preceding segment. "If anything has failed, run the teardown" is the
         * thing people mean, and scoping it to the last segment would make the
         * answer depend on where the user happened to put a pause.
         *
         * A SKIP counts as neither. A test that never ran did not fail — saying
         * otherwise would send a Routine down its failure path because an
         * unrelated test was deleted.
         *
         * The untaken side is marked rather than removed, and the note says the
         * branch is why. Rows for a path that was never taken sitting at
         * "queued" is the same defect a stop past a barrier had: `summarize`
         * counts a pending row as nothing at all, so the record stops adding up.
         */
        const takeBranch = (branch: NonNullable<BatchBarrier["branch"]>): void => {
          const anyFailed = s.results.some((r) => r.status === "failed");
          const taken = branch.on === "anyFailed" ? anyFailed : !anyFailed;
          const dead = taken ? branch.elseSegment : branch.thenSegment;
          const why = branch.on === "anyFailed" ? "something failed" : "everything passed";
          for (let j = 0; j < s.results.length; j++) {
            if ((queue[j]?.segment ?? 0) !== dead) continue;
            if (s.results[j].status !== "pending") continue;
            s.results[j].status = "skipped";
            s.results[j].note = taken
              ? `Skipped — the routine branched because ${why}`
              : `Skipped — the routine branched because ${why} did not happen`;
          }
        };

        /**
         * Hold the run for `ms`, and SAY SO.
         *
         * `waitingUntil` is what stops a pause from looking like a hang: with
         * nothing running and nothing left to report, a batch mid-barrier is
         * indistinguishable on screen from one that has stopped answering. The
         * field is cleared in a `finally` so a stop mid-wait does not leave the
         * batch claiming to be waiting forever.
         *
         * INTERRUPTIBLE. `stop()` has to end a wait, or Stop would appear not
         * to work for however long the pause had left — which for the ceiling
         * (an hour) is indistinguishable from a frozen app.
         */
        const pause = async (ms: number): Promise<void> => {
          s.waitingUntil = deps.now() + ms;
          emitProgress();
          try {
            await deps.wait(ms, () => cancelled);
          } finally {
            s.waitingUntil = undefined;
            emitProgress();
          }
        };

        /**
         * A step said "skip the rest of my group if I fail", and it failed.
         *
         * NARROWER THAN A STOP, and that is the whole point of having both:
         * seed-then-test is a group, and the failure of the seed should take
         * the tests that depend on it and nothing else. Only PENDING entries
         * are skipped — one already running belongs to a lane that started
         * before the failure, and killing it would make `skipGroup` the same
         * thing as `stopRoutine` for anyone running more than one lane.
         *
         * An entry with NO group continues. `skipGroup` on an ungrouped step
         * has no rest-of-group to skip, so it degrades to the harmless answer
         * at the point of failure rather than in `failurePolicy` — a step's
         * policy is a property of the step, and whether it sits in a group is
         * not.
         */
        const skipRestOfGroup = (i: number, testName: string): void => {
          const groupId = queue[i]?.groupId;
          if (!groupId) return;
          for (let j = 0; j < s.results.length; j++) {
            if (j === i || queue[j]?.groupId !== groupId) continue;
            if (s.results[j].status !== "pending") continue;
            s.results[j].status = "skipped";
            s.results[j].note = `Skipped — "${testName}" failed in this group`;
          }
        };

        const stopIfPolicySays = (i: number, testName: string): void => {
          if (queue[i]?.onFailure === "skipGroup") {
            skipRestOfGroup(i, testName);
            return;
          }
          if (cancelled) return;
          if (queue[i]?.onFailure !== "stopRoutine") return;
          cancelled = true;
          s.stoppedBy = "failure";
          s.stoppedByTest = testName;
          logger.info("batch", "Batch stopped by failure policy", {
            batchId,
            testId: s.results[i]?.testId,
          });
          for (const result of s.results) {
            if (result.status === "running") deps.stopRun(result.testId);
          }
        };

        /** Run one queued entry to completion. This is the old sequential
         *  loop's body, unchanged — the only difference is that several copies
         *  of it may now be in flight, each on a different test. */
        const runEntry = async (i: number): Promise<void> => {
          const entry = s.results[i];
          // ALREADY SETTLED, so leave it alone. `skipRestOfGroup` marks pending
          // entries skipped without cancelling the batch, and the worker walks
          // on to them regardless — without this the mark is cosmetic: the row
          // reads "skipped" for a moment and then runs anyway, which is a
          // group policy that does nothing and reports that it did.
          if (entry.status === "skipped") return;
          if (cancelled) {
            entry.status = "skipped";
            // Says WHO stopped it. "Batch stopped" beside a run nobody touched
            // sends someone looking for the person who pressed the button.
            entry.note =
              s.stoppedBy === "failure"
                ? `Stopped — "${s.stoppedByTest ?? "a test"}" failed`
                : "Batch stopped";
            return;
          }
          // A test deleted after the batch was queued is skipped, not fatal —
          // the rest of the batch is still worth running.
          if (deps.getTestName(entry.testId) === null) {
            entry.status = "skipped";
            entry.note = "Test no longer exists";
            emitProgress();
            return;
          }
          entry.status = "running";
          entry.startedAt = deps.now();
          emitProgress();

          let exitCode = -1;
          try {
            // Per-entry when the Batch view sent rows, batch-wide otherwise.
            // `headed` and `runHeadless` are derived from the SAME value — they
            // are two spellings of one choice, and letting them disagree opens a
            // window for a run the user asked to be headless.
            const entryHeadless = queue[i]?.headless ?? params.runHeadless;
            const { runId, recordId, alreadyRunning } = deps.startRun({
              testId: entry.testId,
              headed: !entryHeadless,
              captureArtifacts: params.captureArtifacts,
              runHeadless: entryHeadless,
              browser: queue[i]?.browser ?? params.browser,
              batchId,
              // Read from the queue, not from `entry`: BatchState is persisted
              // to disk on every transition, and a dataset row's values have no
              // business being written into batch-history.json.
              vars: queue[i]?.vars,
              datasetId: entry.datasetId,
              datasetName: entry.datasetName,
              // Passed through per run rather than stamped on the batch record
              // alone: run history is queried per RUN, and a batch record is
              // capped and pruned separately, so a run that outlives its batch
              // would otherwise lose the answer.
              trigger: params.trigger,
            });
            // Recorded even if the run later fails, so a persisted batch can
            // link through to the run's log in Stats.
            if (recordId) entry.runRecordId = recordId;
            // `alreadyRunning` means the runner declined to start a new run
            // because this test was mid-run already. Awaiting it would attribute
            // a run the batch didn't start (different options, no batchId) to
            // this entry — so skip instead. The null-waitFor check below is the
            // backstop for a run that finished between start and waitFor.
            //
            // Lanes mean the batch can no longer collide with ITSELF here, but
            // this is still live: the user can start a test by hand from the
            // test view while a batch is running.
            const pending = alreadyRunning ? null : deps.waitFor(runId);
            if (pending === null) {
              entry.status = "skipped";
              entry.note = "That test was already running";
              entry.finishedAt = deps.now();
              entry.durationMs = entry.finishedAt - (entry.startedAt ?? entry.finishedAt);
              emitProgress();
              return;
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
            // A step that could not START is a step that did not do its job, so
            // "stop if this fails" applies at least as strongly here as it does
            // to a red assertion. Missing this branch would make the policy
            // hold for a failing test and quietly not for a broken one.
            stopIfPolicySays(i, entry.testName);
            emitProgress();
            return;
          }

          entry.exitCode = exitCode;
          entry.status = exitCode === 0 ? "passed" : "failed";
          entry.finishedAt = deps.now();
          entry.durationMs = entry.finishedAt - (entry.startedAt ?? entry.finishedAt);
          if (entry.status === "failed") stopIfPolicySays(i, entry.testName);
          emitProgress();
        };

        // Bounded pool: each worker claims the next lane and drains it. The
        // claim is a bare `nextLane++` with no await between the read and the
        // write, so on a single-threaded event loop two workers cannot take the
        // same lane.
        //
        // SEGMENT BY SEGMENT, and this is the whole of what a `wait` step costs
        // the runner. A Routine with no barriers is ONE segment, so this loop
        // runs once and the body below is byte-for-byte the pool that was here
        // before — `batch:run`, the MCP and every pre-`wait` Routine take
        // exactly the path they always took.
        //
        // The join is the point. A barrier means "everything before this has
        // finished", so the pool must DRAIN before the pause starts; running a
        // wait concurrently with the steps around it would be a no-op wearing a
        // label. `Promise.all` over the workers is already that drain.
        const segmentOf = (i: number): number => queue[i]?.segment ?? 0;
        const segments = [...new Set(lanes.map((lane) => segmentOf(lane[0])))].sort(
          (a, b) => a - b,
        );
        for (const seg of segments) {
          // NO EARLY BREAK ON `cancelled`, deliberately. `runEntry` already
          // refuses to start a cancelled entry and marks it skipped, so
          // breaking here would skip that marking entirely — a stopped batch
          // would persist the segments past the barrier sitting at "queued"
          // forever, and `summarize` counts a pending row as neither passed,
          // failed nor skipped, so the record's own total stops adding up.
          // The BARRIER is guarded separately below; that is the part a stop
          // must actually skip.
          // A lane belongs to ONE segment: lanes are keyed by testId and the
          // store collapses duplicate testIds across the whole Routine, so a
          // test cannot straddle a barrier. Reading the segment off the lane's
          // first entry is therefore reading it off all of them.
          const segLanes = lanes.filter((lane) => segmentOf(lane[0]) === seg);
          let nextLane = 0;
          const worker = async (): Promise<void> => {
            for (;;) {
              const laneIndex = nextLane++;
              if (laneIndex >= segLanes.length) return;
              for (const entryIndex of segLanes[laneIndex]) {
                await runEntry(entryIndex);
              }
            }
          };
          await Promise.all(Array.from({ length: limit }, () => worker()));

          const barrier = (params.barriers ?? []).find((b) => b.afterSegment === seg);
          if (!barrier || cancelled) continue;
          // The message goes out BEFORE the pause, when a barrier carries both.
          // "Seeding done" announcing a thing and then arriving a minute late
          // is worse than no message at all.
          if (barrier.branch) takeBranch(barrier.branch);
          if (barrier.notify) {
            deps.notifyStep({ ...barrier.notify, routineName: params.routineName ?? "Routine" });
          }
          if (barrier.ms > 0) await pause(barrier.ms);
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
          ...(s.stoppedBy ? { stoppedBy: s.stoppedBy } : {}),
          ...(s.stoppedByTest ? { stoppedByTest: s.stoppedByTest } : {}),
          browser: params.browser,
        });
        // And one desktop notification, for the same reason — plus the reason
        // the whole feature exists: the Batch view's toast only fires while
        // that view is mounted, so starting a suite and navigating away used to
        // mean never being told it finished.
        deps.notify({
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          skipped: summary.skipped,
          stopped: s.stopped,
          ...(s.stoppedBy ? { stoppedBy: s.stoppedBy } : {}),
          ...(s.stoppedByTest ? { stoppedByTest: s.stoppedByTest } : {}),
        });
      })();

      return { batchId, alreadyRunning: false };
    },

    /** Stop the batch: kill every test currently running and skip the rest.
     *  Already-finished results are kept.
     *
     *  EVERY running entry, not just `currentIndex` — a parallel batch has
     *  several in flight, and killing only the head of the pack would leave the
     *  rest of the browsers open with the UI reporting the batch as stopped. */
    stop(): void {
      if (!state?.running) return;
      // Already stopping — by a failure policy, or by a second click. Leaving
      // `stoppedBy` alone keeps the first cause, which is the true one.
      if (cancelled) return;
      cancelled = true;
      state.stoppedBy = "user";
      for (const result of state.results) {
        if (result.status === "running") deps.stopRun(result.testId);
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
