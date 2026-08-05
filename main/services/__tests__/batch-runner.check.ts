// Standalone regression check for batch (suite) runs.
//
// The batch runner drives ordinary Playwright runs sequentially. The properties
// that matter and are easy to break:
//   - tests run STRICTLY one at a time (never overlapping) and in order;
//   - a failing test does not abort the batch;
//   - a test deleted after queueing, or one already running, is skipped rather
//     than crashing the batch or reporting a bogus failure;
//   - stop() kills the current run and skips the rest, keeping earlier results;
//   - the summary counts match the per-test results.
//
// createBatchRunner takes injected deps, so all of that is exercised here
// against a fake runner — no browsers, no child processes.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:batch-runner

import {
  buildQueue,
  createBatchRunner,
  summarize,
  type BatchDeps,
  type BatchState,
  type BatchTestStatus,
} from "../batch-runner.js";
import type { Dataset } from "../../recorder/types.js";
import type { BatchSummary } from "../../recorder/types.js";
// The MCP server is standalone .mjs by design (it must run without the app
// build), so it cannot import the app's summarizer — it carries its own copy.
// This check bundles both and pins them to the same verdicts.
import { summarizeResults } from "../../../mcp/select-tests.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** A fake Playwright runner: each test's run resolves only when the harness
 *  says so, which is what makes overlap detectable. */
function makeFake(opts: {
  names?: Record<string, string | null>;
  /** testIds that should report "not in flight" from waitFor */
  notInFlight?: string[];
  /** testIds the runner declines to start because they're mid-run already.
   *  Models the REAL runner: it returns `alreadyRunning` and leaves the
   *  previous run's promise in its in-flight map, so waitFor still resolves —
   *  which is exactly the trap the batch must not fall into. */
  alreadyRunning?: string[];
  /** dataset rows each test declares, for sweep expansion */
  datasets?: Record<string, Dataset[]>;
}) {
  const names = opts.names ?? {};
  const notInFlight = new Set(opts.notInFlight ?? []);
  const busy = new Set(opts.alreadyRunning ?? []);
  const pending = new Map<string, (code: number) => void>();
  const events: { channel: string; payload: unknown }[] = [];
  /** every testId startRun was called with, in order */
  const started: string[] = [];
  /** the full start params, so a sweep's dataset binding can be asserted */
  const startedWithDataset: {
    testId: string;
    datasetId?: string;
    vars?: Record<string, string>;
  }[] = [];
  /** how many runs are in flight at once, and the high-water mark */
  let live = 0;
  let maxLive = 0;
  const stopped: string[] = [];
  /** every write-through persist, in order — the last one is what a restart
   *  would load back. */
  const persisted: (BatchState & { summary: BatchSummary })[] = [];
  /** outgoing alerts requested by the runner */
  const alerts: unknown[] = [];
  let clock = 1000;

  const datasets = opts.datasets ?? {};

  const deps: BatchDeps = {
    getTestName: (id) => (id in names ? names[id] : `Test ${id}`),
    getDatasets: (id) => datasets[id] ?? [],
    startRun: ({ testId, datasetId, vars }) => {
      startedWithDataset.push({ testId, datasetId, vars });
      if (busy.has(testId)) {
        // No new run started — and, like the real runner, a stale promise for
        // the OTHER run is still resolvable via waitFor.
        return { runId: testId, alreadyRunning: true };
      }
      started.push(testId);
      live++;
      maxLive = Math.max(maxLive, live);
      return { runId: testId, recordId: `rec-${testId}` };
    },
    waitFor: (runId) => {
      if (busy.has(runId)) {
        // Deliberately NOT null: the trap is that this resolves.
        return Promise.resolve(0);
      }
      if (notInFlight.has(runId)) {
        live--;
        return null;
      }
      return new Promise<number>((resolve) => {
        pending.set(runId, (code) => {
          live--;
          resolve(code);
        });
      });
    },
    stopRun: (runId) => {
      stopped.push(runId);
      // A killed Playwright process exits non-zero.
      pending.get(runId)?.(1);
      pending.delete(runId);
    },
    emit: (channel, payload) => events.push({ channel, payload }),
    now: () => (clock += 10),
    alert: (a) => {
      alerts.push(a);
    },
    persist: (record) => {
      // Deep-ish copy: the runner mutates its result entries in place, so
      // storing the live objects would make every snapshot look identical.
      persisted.push({ ...record, results: record.results.map((r) => ({ ...r })) });
    },
  };

  return {
    deps,
    events,
    started,
    startedWithDataset,
    stopped,
    persisted,
    alerts,
    get maxLive() {
      return maxLive;
    },
    /** resolve the run for `testId` with an exit code */
    finish(testId: string, code = 0) {
      const r = pending.get(testId);
      if (!r) throw new Error(`No pending run for ${testId}`);
      pending.delete(testId);
      r(code);
    },
    isPending: (testId: string) => pending.has(testId),
    doneEvent: () => {
      const done = events.filter((e) => e.channel === "batch:done");
      return done[done.length - 1]?.payload as
        | (BatchState & { summary: ReturnType<typeof summarize> })
        | undefined;
    },
  };
}

/** Let queued microtasks drain so the batch loop advances. */
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  // ── Sequencing: one at a time, in order, failures don't abort ──────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b", "c"] });
    await tick();

    assert(fake.started.length === 1 && fake.started[0] === "a", "starts only the first test");
    assert(fake.isPending("a"), "first test is in flight");

    fake.finish("a", 0);
    await tick();
    assert(fake.started.length === 2 && fake.started[1] === "b", "advances to the second test");

    // A failing test must not stop the batch.
    fake.finish("b", 1);
    await tick();
    assert(fake.started.length === 3 && fake.started[2] === "c", "a failing test does not abort");

    fake.finish("c", 0);
    await tick();

    assert(fake.maxLive === 1, `never runs two tests at once (peak was ${fake.maxLive})`);

    const done = fake.doneEvent();
    assert(done !== undefined, "emits batch:done");
    assert(done?.running === false, "batch:done reports running=false");
    assert(
      done?.results.map((r) => r.status).join(",") === "passed,failed,passed",
      `per-test statuses are passed,failed,passed (got ${done?.results.map((r) => r.status).join(",")})`,
    );
    assert(done?.summary.passed === 2 && done?.summary.failed === 1, "summary counts match");
    assert(done?.summary.ok === false, "a batch with a failure is not ok");
    assert(done?.summary.total === 3, "summary total counts every queued test");
    assert(
      (done?.results[0].durationMs ?? -1) >= 0,
      "each finished test records a duration",
    );
  }

  // ── All passing ───────────────────────────────────────────────────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"] });
    await tick();
    fake.finish("a", 0);
    await tick();
    fake.finish("b", 0);
    await tick();
    const done = fake.doneEvent();
    assert(done?.summary.ok === true, "an all-passing batch is ok");
    assert(done?.stopped === false, "an uninterrupted batch is not marked stopped");
  }

  // ── Deleted test is skipped, batch continues ──────────────────────
  {
    const fake = makeFake({ names: { gone: null } });
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "gone", "b"] });
    await tick();
    fake.finish("a", 0);
    await tick();
    // "gone" should be skipped without ever starting a run.
    assert(!fake.started.includes("gone"), "a deleted test never starts a run");
    assert(fake.started.includes("b"), "the batch continues past a deleted test");
    fake.finish("b", 0);
    await tick();
    const done = fake.doneEvent();
    assert(done?.summary.skipped === 1, "a deleted test counts as skipped");
    assert(
      done?.results.find((r) => r.testId === "gone")?.note === "Test no longer exists",
      "a deleted test records why it was skipped",
    );
    assert(done?.summary.ok === true, "skips alone don't make a batch fail");
  }

  // ── A test already running is skipped, not attributed ─────────────
  // Regression: the runner leaves the in-progress run's promise in its
  // in-flight map, so a batch that fell back to waitFor would await a run it
  // never started — one with different browser/headless options and no
  // batchId — and report that run's exit code as this entry's result.
  {
    const fake = makeFake({ alreadyRunning: ["busy"] });
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["busy", "a"] });
    await tick();
    fake.finish("a", 0);
    await tick();
    const done = fake.doneEvent();
    const busy = done?.results.find((r) => r.testId === "busy");
    assert(busy?.status === "skipped", `an already-running test is skipped (got ${busy?.status})`);
    assert(
      busy?.exitCode === undefined,
      "an already-running test does NOT adopt the other run's exit code",
    );
    assert(
      busy?.runRecordId === undefined,
      "an already-running test is not linked to a run it didn't start",
    );
    assert(done?.summary.failed === 0, "an already-running test is NOT reported as a failure");
    assert(done?.summary.skipped === 1, "it counts as skipped in the summary");
  }

  // The null-waitFor backstop (run finished between start and waitFor).
  {
    const fake = makeFake({ notInFlight: ["gone"] });
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["gone", "a"] });
    await tick();
    fake.finish("a", 0);
    await tick();
    const done = fake.doneEvent();
    assert(
      done?.results.find((r) => r.testId === "gone")?.status === "skipped",
      "a run that vanished before waitFor is skipped, not failed",
    );
  }

  // ── stop(): kills the current run, skips the rest, keeps results ───
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b", "c"] });
    await tick();
    fake.finish("a", 0);
    await tick();
    // "b" is now running.
    batch.stop();
    await tick();
    await tick();

    assert(fake.stopped.includes("b"), "stop() kills the test that was running");
    assert(!fake.started.includes("c"), "stop() prevents later tests from starting");

    const done = fake.doneEvent();
    assert(done?.stopped === true, "a stopped batch is marked stopped");
    assert(done?.running === false, "a stopped batch is no longer running");
    assert(
      done?.results.find((r) => r.testId === "a")?.status === "passed",
      "results from before the stop are kept",
    );
    assert(
      done?.results.find((r) => r.testId === "c")?.status === "skipped",
      "tests after the stop are skipped",
    );
  }

  // ── One batch at a time ───────────────────────────────────────────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    const first = batch.start({ testIds: ["a", "b"] });
    await tick();
    const second = batch.start({ testIds: ["c"] });
    assert(second.alreadyRunning === true, "a second batch reports alreadyRunning");
    assert(second.batchId === first.batchId, "the in-flight batch's id is returned");
    assert(!fake.started.includes("c"), "a second batch does not start its tests");
    fake.finish("a", 0);
    await tick();
    fake.finish("b", 0);
    await tick();
    // Once finished, a new batch may start.
    const third = batch.start({ testIds: ["c"] });
    assert(third.alreadyRunning === false, "a new batch starts once the previous finished");
    await tick();
    fake.finish("c", 0);
    await tick();
  }

  // ── getState reflects progress, and survives batch completion ──────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    assert(createBatchRunner(makeFake({}).deps).getState() === null, "no batch yet → null state");
    batch.start({ testIds: ["a"] });
    await tick();
    assert(batch.getState()?.running === true, "getState reports a running batch");
    fake.finish("a", 0);
    await tick();
    const s = batch.getState();
    assert(s?.running === false, "getState reports the finished batch");
    assert(s?.summary.passed === 1, "a finished batch's results remain readable");
  }

  // ── Write-through persistence ─────────────────────────────────────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"] });
    await tick();

    // The point of write-through: a crash here must not lose the batch.
    assert(fake.persisted.length > 0, "persists before the batch finishes");
    const early = fake.persisted[fake.persisted.length - 1];
    assert(early.running === true, "a mid-batch snapshot is marked running");
    assert(
      early.results.find((r) => r.testId === "a")?.status === "running",
      "a mid-batch snapshot records the in-flight test",
    );

    fake.finish("a", 0);
    await tick();
    const afterFirst = fake.persisted[fake.persisted.length - 1];
    assert(
      afterFirst.results.find((r) => r.testId === "a")?.status === "passed",
      "a finished test is persisted as soon as it finishes",
    );
    assert(
      afterFirst.results.find((r) => r.testId === "b")?.status === "running",
      "the next test's start is persisted too",
    );

    fake.finish("b", 1);
    await tick();
    const final = fake.persisted[fake.persisted.length - 1];
    assert(final.running === false, "the final snapshot is not running");
    assert(final.summary.failed === 1, "the final snapshot carries the summary");
    assert(
      final.batchId === batch.getState()?.batchId,
      "persisted snapshots keep the batch id (so save() upserts one record)",
    );
    // Every snapshot is the same batch — the store upserts by id rather than
    // accumulating one record per transition.
    assert(
      new Set(fake.persisted.map((r) => r.batchId)).size === 1,
      "all snapshots of one batch share one id",
    );
  }

  // ── Alerting fires once per batch, not once per test ──────────────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"] });
    await tick();
    fake.finish("a", 1);
    await tick();
    assert(fake.alerts.length === 0, "no alert is sent mid-batch");
    fake.finish("b", 0);
    await tick();
    assert(fake.alerts.length === 1, `exactly one alert per batch (got ${fake.alerts.length})`);
    const a = fake.alerts[0] as { kind: string; failedTests: string[]; stopped: boolean };
    assert(a.kind === "batch", "the alert is a batch alert");
    assert(a.failedTests.join(",") === "Test a", "the alert names the failed tests");
    assert(a.stopped === false, "an uninterrupted batch is not reported as stopped");
  }

  // ── Runs are linked back to their RunRecord ───────────────────────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a"] });
    await tick();
    fake.finish("a", 0);
    await tick();
    const done = fake.doneEvent();
    assert(
      done?.results[0].runRecordId === "rec-a",
      "a run's RunRecord id is recorded on the batch result",
    );
  }

  // ── summarize() edge case: all skipped is not a pass ───────────────
  {
    const state: BatchState = {
      batchId: "x",
      running: false,
      startedAt: 0,
      finishedAt: 500,
      currentIndex: -1,
      stopped: false,
      results: [
        { testId: "a", testName: "A", status: "skipped" },
        { testId: "b", testName: "B", status: "skipped" },
      ],
    };
    const sum = summarize(state, 500);
    assert(sum.ok === false, "an all-skipped batch is not ok");
    assert(sum.durationMs === 500, "duration uses finishedAt when present");
    assert(
      summarize({ ...state, finishedAt: undefined }, 900).durationMs === 900,
      "duration falls back to now while still running",
    );
  }

  // ── App ↔ MCP summary parity ──────────────────────────────────────
  // Two implementations of one rule. Without this, changing the app's rule
  // would break check:batch-runner (so it gets updated) while check:mcp-select
  // keeps passing on the old rule — and the app and MCP would then disagree
  // about whether the same batch passed.
  {
    const cases: { label: string; statuses: string[] }[] = [
      { label: "all passed", statuses: ["passed", "passed"] },
      { label: "one failed", statuses: ["passed", "failed"] },
      { label: "all failed", statuses: ["failed"] },
      { label: "all skipped", statuses: ["skipped", "skipped"] },
      { label: "passed + skipped", statuses: ["passed", "skipped"] },
      { label: "failed + skipped", statuses: ["failed", "skipped"] },
      { label: "empty", statuses: [] },
    ];
    for (const c of cases) {
      const results = c.statuses.map((status, i) => ({
        testId: `t${i}`,
        testName: `T${i}`,
        status: status as BatchTestStatus,
      }));
      const mine = summarize(
        {
          batchId: "x",
          running: false,
          startedAt: 0,
          finishedAt: 500,
          currentIndex: -1,
          stopped: false,
          results,
        },
        500,
      );
      const theirs = summarizeResults(results, 500);
      assert(
        mine.ok === theirs.ok &&
          mine.total === theirs.total &&
          mine.passed === theirs.passed &&
          mine.failed === theirs.failed &&
          mine.skipped === theirs.skipped &&
          mine.durationMs === theirs.durationMs,
        `app and MCP summaries agree — ${c.label} (app.ok=${mine.ok}, mcp.ok=${theirs.ok})`,
      );
    }
  }

  // ---- dataset sweeps -----------------------------------------------------
  //
  // A sweep is the one case where the SAME test id is queued more than once.
  // Every property below is one a naive implementation gets wrong: deduping the
  // queue by test id, dropping unparameterized tests, or losing which row a
  // result belongs to.
  {
    const rows: Record<string, Dataset[]> = {
      a: [
        { id: "d1", name: "GBP", values: { currency: "GBP" } },
        { id: "d2", name: "USD", values: { currency: "USD" } },
      ],
      b: [],
    };
    const getDatasets = (id: string): Dataset[] => rows[id] ?? [];

    const plain = buildQueue({ testIds: ["a", "b"] }, getDatasets);
    assert(
      plain.length === 2 && plain.every((e) => e.datasetId === undefined),
      "no dataset options → the queue is exactly the selection",
    );

    const swept = buildQueue({ testIds: ["a", "b"], allDatasets: true }, getDatasets);
    assert(
      swept.length === 3,
      `allDatasets queues one entry per row, plus unparameterized tests once (got ${swept.length})`,
    );
    assert(
      swept[0].testId === "a" && swept[0].datasetId === "d1" &&
        swept[1].testId === "a" && swept[1].datasetId === "d2",
      "sweep keeps rows in declared order",
    );
    assert(
      swept[2].testId === "b" && swept[2].datasetId === undefined,
      "a test with no rows still runs once, with its own defaults",
    );
    assert(
      swept[0].vars?.currency === "GBP" && swept[1].vars?.currency === "USD",
      "each queued entry carries its own row's values",
    );

    const subset = buildQueue({ testIds: ["a"], datasetIds: ["d2"] }, getDatasets);
    assert(
      subset.length === 1 && subset[0].datasetId === "d2",
      "an explicit datasetIds subset runs only those rows",
    );

    const unmatched = buildQueue({ testIds: ["a"], datasetIds: ["nope"] }, getDatasets);
    assert(
      unmatched.length === 1 && unmatched[0].datasetId === undefined,
      "a selection matching no rows falls back to one plain run, not zero",
    );
  }

  {
    const fake = makeFake({
      datasets: {
        a: [
          { id: "d1", name: "GBP", values: { currency: "GBP" } },
          { id: "d2", name: "USD", values: { currency: "USD" } },
        ],
      },
    });
    const runner = createBatchRunner(fake.deps);
    runner.start({ testIds: ["a"], allDatasets: true });
    await tick();
    // The real runner clears its in-flight entry before the awaited promise
    // resolves, which is what lets the same test start again for the next row.
    fake.finish("a", 0);
    await tick();
    fake.finish("a", 1);
    await tick();

    assert(
      fake.startedWithDataset.length === 2,
      `a two-row sweep starts two runs of the same test (got ${fake.startedWithDataset.length})`,
    );
    assert(
      fake.startedWithDataset[0]?.vars?.currency === "GBP" &&
        fake.startedWithDataset[1]?.vars?.currency === "USD",
      "each run of the sweep is given its own row's values",
    );
    const last = fake.persisted[fake.persisted.length - 1];
    assert(
      last.results.length === 2 &&
        last.results[0].datasetName === "GBP" &&
        last.results[1].datasetName === "USD",
      "each result records which row it was, so a failing row is identifiable",
    );
    assert(
      last.results[0].status === "passed" && last.results[1].status === "failed",
      "rows report their own outcomes independently",
    );
    // The values themselves must not be written to disk — batch state is
    // persisted on every transition, and a row may hold real data.
    assert(
      !JSON.stringify(last).includes("GBP=") && !("vars" in last.results[0]),
      "persisted batch state carries the row's NAME, never its values",
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll batch-runner checks passed");
}

void main();
