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

import { createBatchRunner, summarize, type BatchDeps, type BatchState } from "../batch-runner.js";

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
}) {
  const names = opts.names ?? {};
  const notInFlight = new Set(opts.notInFlight ?? []);
  const pending = new Map<string, (code: number) => void>();
  const events: { channel: string; payload: unknown }[] = [];
  /** every testId startRun was called with, in order */
  const started: string[] = [];
  /** how many runs are in flight at once, and the high-water mark */
  let live = 0;
  let maxLive = 0;
  const stopped: string[] = [];
  let clock = 1000;

  const deps: BatchDeps = {
    getTestName: (id) => (id in names ? names[id] : `Test ${id}`),
    startRun: ({ testId }) => {
      started.push(testId);
      live++;
      maxLive = Math.max(maxLive, live);
      return { runId: testId };
    },
    waitFor: (runId) => {
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
  };

  return {
    deps,
    events,
    started,
    stopped,
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

  // ── A test already running is skipped, not counted as failed ──────
  {
    const fake = makeFake({ notInFlight: ["busy"] });
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["busy", "a"] });
    await tick();
    fake.finish("a", 0);
    await tick();
    const done = fake.doneEvent();
    const busy = done?.results.find((r) => r.testId === "busy");
    assert(busy?.status === "skipped", `an already-running test is skipped (got ${busy?.status})`);
    assert(done?.summary.failed === 0, "an already-running test is NOT reported as a failure");
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

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll batch-runner checks passed");
}

void main();
