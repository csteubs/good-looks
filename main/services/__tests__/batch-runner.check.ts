// Standalone regression check for batch (suite) runs.
//
// The batch runner drives ordinary Playwright runs — one at a time by default,
// several at once when asked. The properties that matter and are easy to break:
//   - with no concurrency asked for, tests run STRICTLY one at a time, in order;
//   - with concurrency, exactly that many run at once — and never more;
//   - entries for the SAME test stay serialized however wide the batch is,
//     because the runner keys a live run by testId;
//   - a failing test does not abort the batch, and does not stall the pool;
//   - a test deleted after queueing, or one already running, is skipped rather
//     than crashing the batch or reporting a bogus failure;
//   - stop() kills EVERY running test and skips the rest, keeping earlier
//     results;
//   - the summary counts match the per-test results.
//
// createBatchRunner takes injected deps, so all of that is exercised here
// against a fake runner — no browsers, no child processes.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:batch-runner

import {
  buildLanes,
  buildQueue,
  createBatchRunner,
  summarize,
  type BatchDeps,
  type BatchState,
  type BatchTestStatus,
} from "../batch-runner.js";
import {
  buildBatchNotice,
  shouldNotifyRun,
  type BatchOutcomeNotice,
} from "../run-notifier.js";
import { clampBatchConcurrency, MAX_BATCH_CONCURRENCY } from "../../recorder/types.js";
import type { Dataset } from "../../recorder/types.js";
import type { BatchSummary } from "../../recorder/types.js";
// The MCP server runs the same kind of suite from its own standalone .mjs (it
// must run without the app build), so it carries its own pool. This check
// bundles both and pins them to the same sequencing.
import { clampParallel, runPool } from "../../../mcp/run-pool.mjs";
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
  /** testIds whose run the runner refuses to begin at all, by throwing. The
   *  REAL runner does this for a missing or unreplayable test, and the batch
   *  records it as a failure against that entry — a distinct path from a test
   *  that runs and goes red, and one a failure policy has to reach too. */
  throwOnStart?: string[];
}) {
  const names = opts.names ?? {};
  const notInFlight = new Set(opts.notInFlight ?? []);
  const busy = new Set(opts.alreadyRunning ?? []);
  const throwOnStart = new Set(opts.throwOnStart ?? []);
  const pending = new Map<string, (code: number) => void>();
  const events: { channel: string; payload: unknown }[] = [];
  /** every testId startRun was called with, in order */
  const started: string[] = [];
  /** the full start params, so a sweep's dataset binding and a fan-out's
   *  per-engine binding can both be asserted */
  const startedWithDataset: {
    testId: string;
    datasetId?: string;
    vars?: Record<string, string>;
    browser?: string;
    runHeadless?: boolean;
    headed?: boolean;
  }[] = [];
  /** how many runs are in flight at once, and the high-water mark */
  let live = 0;
  let maxLive = 0;
  /** the same, per testId — the runner keys a live run by testId, so two runs
   *  of ONE test overlapping is the specific thing lanes exist to prevent */
  const liveByTest = new Map<string, number>();
  const maxLiveByTest = new Map<string, number>();
  const enter = (testId: string): void => {
    live++;
    maxLive = Math.max(maxLive, live);
    const n = (liveByTest.get(testId) ?? 0) + 1;
    liveByTest.set(testId, n);
    maxLiveByTest.set(testId, Math.max(maxLiveByTest.get(testId) ?? 0, n));
  };
  const leave = (testId: string): void => {
    live--;
    liveByTest.set(testId, (liveByTest.get(testId) ?? 1) - 1);
  };
  const stopped: string[] = [];
  /** every write-through persist, in order — the last one is what a restart
   *  would load back. */
  const persisted: (BatchState & { summary: BatchSummary })[] = [];
  /** outgoing alerts requested by the runner */
  const alerts: unknown[] = [];
  /** desktop notifications requested by the runner */
  const notices: BatchOutcomeNotice[] = [];
  let clock = 1000;

  const datasets = opts.datasets ?? {};

  const deps: BatchDeps = {
    getTestName: (id) => (id in names ? names[id] : `Test ${id}`),
    getDatasets: (id) => datasets[id] ?? [],
    startRun: ({ testId, datasetId, vars, browser, runHeadless, headed }) => {
      startedWithDataset.push({ testId, datasetId, vars, browser, runHeadless, headed });
      if (throwOnStart.has(testId)) throw new Error(`cannot start ${testId}`);
      if (busy.has(testId)) {
        // No new run started — and, like the real runner, a stale promise for
        // the OTHER run is still resolvable via waitFor.
        return { runId: testId, alreadyRunning: true };
      }
      started.push(testId);
      enter(testId);
      return { runId: testId, recordId: `rec-${testId}` };
    },
    waitFor: (runId) => {
      if (busy.has(runId)) {
        // Deliberately NOT null: the trap is that this resolves.
        return Promise.resolve(0);
      }
      if (notInFlight.has(runId)) {
        leave(runId);
        return null;
      }
      return new Promise<number>((resolve) => {
        pending.set(runId, (code) => {
          leave(runId);
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
    notify: (n) => {
      notices.push(n);
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
    notices,
    get maxLive() {
      return maxLive;
    },
    /** high-water mark of concurrent runs for one test — must stay 1 */
    maxLiveFor: (testId: string) => maxLiveByTest.get(testId) ?? 0,
    /** resolve the run for `testId` with an exit code */
    finish(testId: string, code = 0) {
      const r = pending.get(testId);
      if (!r) throw new Error(`No pending run for ${testId}`);
      pending.delete(testId);
      r(code);
    },
    /** every testId currently awaiting a result, in the order they started */
    pendingIds: () => [...pending.keys()],
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

  // ── onFailure: "stopRoutine" ends the job, and says who ────────────
  //
  // docs/ROUTINES.md: "continue" is the default so migrating the old Batch
  // changes nothing, and "stopRoutine" is what makes a setup step mean
  // anything — seed the data, and if that fails, do not go on to test against
  // data that is not there. What it DOES is deliberately the same thing stop()
  // does: anything gentler would be a second meaning of "stop", and with lanes
  // running concurrently there is no "rest of the queue" to merely not start.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["a", "b", "c"],
      perTest: [
        { testId: "a", browsers: ["chromium"], headless: true, onFailure: "stopRoutine" },
        { testId: "b", browsers: ["chromium"], headless: true, onFailure: "continue" },
        { testId: "c", browsers: ["chromium"], headless: true, onFailure: "continue" },
      ],
    });
    await tick();
    fake.finish("a", 1);
    await tick();
    await tick();

    assert(!fake.started.includes("b"), "a stopRoutine failure prevents later tests from starting");
    const done = fake.doneEvent();
    // ASSERTED SEPARATELY, because everything below reads through it. Without
    // this, a policy that never fires leaves "b" running forever, no batch:done
    // is emitted, and every assertion in the block reports as a distinct
    // failure — five wrong diagnoses for one bug.
    assert(done !== undefined, "the batch finished at all");
    assert(done?.stopped === true, "a routine stopped by a failure is marked stopped");
    assert(
      done?.stoppedBy === "failure",
      "…and says a FAILURE stopped it, not a person — the notification is often all the user sees",
    );
    assert(
      done?.stoppedByTest === "Test a",
      "…naming the test, so the note is actionable rather than just early",
    );
    assert(
      done?.results.find((r) => r.testId === "a")?.status === "failed",
      "the step that stopped the routine keeps its own failure",
    );
    assert(
      done?.results.find((r) => r.testId === "c")?.note === 'Stopped — "Test a" failed',
      "the entries that never ran say WHO stopped them, not \"Batch stopped\"",
    );
  }

  // A failing step whose policy is `continue` must change nothing. This is the
  // default, so getting it wrong turns every existing checklist into one that
  // aborts on its first red test.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["a", "b"],
      perTest: [
        { testId: "a", browsers: ["chromium"], headless: true, onFailure: "continue" },
        { testId: "b", browsers: ["chromium"], headless: true, onFailure: "continue" },
      ],
    });
    await tick();
    fake.finish("a", 1);
    await tick();
    fake.finish("b", 0);
    await tick();

    const done = fake.doneEvent();
    assert(done?.stopped === false, "a `continue` failure does not stop the batch");
    assert(done?.stoppedBy === undefined, "…and records no cause, because there was none");
    assert(
      done?.results.find((r) => r.testId === "b")?.status === "passed",
      "…and the rest of the batch still runs",
    );
  }

  // A batch with no policies at all — every caller that predates Routines, and
  // the MCP's run_batch. Nothing may change for them.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"] });
    await tick();
    fake.finish("a", 1);
    await tick();
    fake.finish("b", 0);
    await tick();
    const done = fake.doneEvent();
    assert(
      done?.stopped === false && done?.results.every((r) => r.status !== "skipped"),
      "a batch with no per-test policies is unaffected by any of this",
    );
  }

  // A step that could not START is a step that did not do its job, so the
  // policy has to hold there too. This is a DIFFERENT branch from a test that
  // runs and goes red — the runner throws out of startRun and records the
  // failure without ever awaiting a run — and the first version of this check
  // did not reach it: the assertion below survived deleting the call, because
  // the case it actually exercised was the multi-engine one that follows.
  {
    const fake = makeFake({ throwOnStart: ["a"] });
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["a", "b"],
      perTest: [
        { testId: "a", browsers: ["chromium"], headless: true, onFailure: "stopRoutine" },
        { testId: "b", browsers: ["chromium"], headless: true, onFailure: "continue" },
      ],
    });
    await tick();
    await tick();
    const done = fake.doneEvent();
    assert(done !== undefined, "the batch finished at all (failure-to-start)");
    assert(
      done?.results.find((r) => r.testId === "a")?.status === "failed",
      "a test that cannot start is recorded as a failure (the branch this covers)",
    );
    assert(
      done?.stoppedBy === "failure" && done?.stoppedByTest === "Test a",
      "…and its policy stops the routine, exactly as a red assertion would",
    );
    assert(!fake.started.includes("b"), "…so nothing after it starts");
  }

  // One engine of a multi-engine step failing is enough: the policy belongs to
  // the STEP, and its engines are several chances for it to come true.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["a", "b"],
      perTest: [
        { testId: "a", browsers: ["chromium", "firefox"], headless: true, onFailure: "stopRoutine" },
        { testId: "b", browsers: ["chromium"], headless: true, onFailure: "continue" },
      ],
    });
    await tick();
    // The step's FIRST engine fails, and its second never runs.
    fake.finish("a", 1);
    await tick();
    await tick();
    const done = fake.doneEvent();
    assert(done !== undefined, "the batch finished at all (multi-engine step)");
    assert(
      done?.stoppedBy === "failure",
      "one engine of a multi-engine step failing is enough to trigger its policy",
    );
    assert(!fake.started.includes("b"), "…and the following step does not start");
  }

  // Two lanes failing in the same tick: the FIRST one owns the stop. Otherwise
  // the note, the alert and the notification all name a test that stopped
  // nothing — which is worse than not naming one, because it sends someone to
  // read the wrong log.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["a", "b", "c"],
      concurrency: 2,
      perTest: [
        { testId: "a", browsers: ["chromium"], headless: true, onFailure: "stopRoutine" },
        { testId: "b", browsers: ["chromium"], headless: true, onFailure: "stopRoutine" },
        { testId: "c", browsers: ["chromium"], headless: true, onFailure: "continue" },
      ],
    });
    await tick();
    fake.finish("a", 1);
    await tick();
    await tick();
    const done = fake.doneEvent();
    assert(done !== undefined, "the batch finished at all (two lanes failing)");
    assert(
      done?.stoppedByTest === "Test a",
      "the first failure owns the stop; a later one does not rewrite it",
    );
  }

  // The user pressing Stop keeps its own attribution — `stoppedBy` must not be
  // absent (which would be indistinguishable from a pre-Routines record) nor
  // "failure".
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"] });
    await tick();
    batch.stop();
    await tick();
    await tick();
    const done = fake.doneEvent();
    assert(done?.stoppedBy === "user", "a batch the user stopped says the USER stopped it");
    assert(
      done?.results.find((r) => r.testId === "b")?.note === "Batch stopped",
      "…and its skipped entries keep the wording that has always been right for it",
    );
  }

  // ── onFailure: "skipGroup" ─────────────────────────────────────────
  //
  // Narrower than a stop, and that is the point of having both: seed-then-test
  // is a group, and the seed failing should take the tests that depend on it
  // and nothing else.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["seed", "a", "b", "after"],
      perTest: [
        { testId: "seed", browsers: ["chromium"], headless: true, onFailure: "skipGroup", groupId: "g1" },
        { testId: "a", browsers: ["chromium"], headless: true, onFailure: "continue", groupId: "g1" },
        { testId: "b", browsers: ["chromium"], headless: true, onFailure: "continue", groupId: "g1" },
        { testId: "after", browsers: ["chromium"], headless: true, onFailure: "continue" },
      ],
    });
    await tick();
    fake.finish("seed", 1);
    await tick();
    await tick();
    // The ungrouped step still runs — that is the whole difference from a stop.
    assert(fake.started.includes("after"), "a skipGroup failure does not stop the rest of the job");
    fake.finish("after", 0);
    await tick();

    const done = fake.doneEvent();
    assert(done !== undefined, "the batch finished at all (skipGroup)");
    assert(done?.stopped === false, "a skipGroup failure does not mark the batch stopped");
    assert(
      done?.results.find((r) => r.testId === "a")?.status === "skipped" &&
        done?.results.find((r) => r.testId === "b")?.status === "skipped",
      "the rest of the group is skipped",
    );
    assert(
      done?.results.find((r) => r.testId === "a")?.note ===
        'Skipped — "Test seed" failed in this group',
      "…and says which step in the group took them out",
    );
    assert(
      done?.results.find((r) => r.testId === "after")?.status === "passed",
      "a step outside the group is untouched",
    );
  }

  // A `skipGroup` step that is NOT in a group has no rest-of-group to skip, so
  // it continues. The degradation lives here rather than in `failurePolicy`
  // because a step's policy is a property of the step and whether it sits in a
  // group is not.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["a", "b"],
      perTest: [
        { testId: "a", browsers: ["chromium"], headless: true, onFailure: "skipGroup" },
        { testId: "b", browsers: ["chromium"], headless: true, onFailure: "continue" },
      ],
    });
    await tick();
    fake.finish("a", 1);
    await tick();
    fake.finish("b", 0);
    await tick();
    const done = fake.doneEvent();
    assert(
      done?.results.find((r) => r.testId === "b")?.status === "passed",
      "skipGroup on an ungrouped step degrades to continuing",
    );
  }

  // A member that already FINISHED keeps its result. This is what `!== "pending"`
  // is really protecting: skipping is about work not yet done, and overwriting
  // a green result with "skipped" would lose a run that actually happened —
  // silently, since the row still reads as a normal skip.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["first", "seed", "later"],
      perTest: [
        { testId: "first", browsers: ["chromium"], headless: true, onFailure: "continue", groupId: "g1" },
        { testId: "seed", browsers: ["chromium"], headless: true, onFailure: "skipGroup", groupId: "g1" },
        { testId: "later", browsers: ["chromium"], headless: true, onFailure: "continue", groupId: "g1" },
      ],
    });
    await tick();
    fake.finish("first", 0);
    await tick();
    fake.finish("seed", 1);
    await tick();
    await tick();
    const done = fake.doneEvent();
    assert(done !== undefined, "the batch finished at all (finished-member group)");
    assert(
      done?.results.find((r) => r.testId === "first")?.status === "passed",
      "a group member that already passed keeps its result when a later one skips the group",
    );
    assert(
      done?.results.find((r) => r.testId === "later")?.status === "skipped",
      "…and the one that had not run is skipped",
    );
  }

  // Only PENDING entries are skipped. One already running belongs to a lane
  // that started before the failure, and killing it would make `skipGroup` the
  // same thing as `stopRoutine` for anyone running more than one lane.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["seed", "a", "b"],
      concurrency: 2,
      perTest: [
        { testId: "seed", browsers: ["chromium"], headless: true, onFailure: "skipGroup", groupId: "g1" },
        { testId: "a", browsers: ["chromium"], headless: true, onFailure: "continue", groupId: "g1" },
        { testId: "b", browsers: ["chromium"], headless: true, onFailure: "continue", groupId: "g1" },
      ],
    });
    await tick();
    // "seed" and "a" are both in flight; "b" has not started.
    assert(fake.isPending("a"), "the second lane really is in flight before the failure");
    fake.finish("seed", 1);
    await tick();
    assert(
      fake.isPending("a"),
      "a group member already RUNNING is not killed — that would make skipGroup a stop",
    );
    fake.finish("a", 0);
    await tick();
    await tick();
    const done = fake.doneEvent();
    assert(
      done?.results.find((r) => r.testId === "a")?.status === "passed",
      "…and it keeps its own result",
    );
    assert(
      done?.results.find((r) => r.testId === "b")?.status === "skipped",
      "…while the one that had not started is skipped",
    );
  }

  // The notification and the alert are where "who stopped it" actually pays
  // off: a scheduled routine's notification is often the ONLY thing seen of it,
  // and "Batch stopped" for a run nobody touched reads as somebody having
  // intervened.
  {
    const byUser = buildBatchNotice({
      total: 3,
      passed: 1,
      failed: 0,
      skipped: 2,
      stopped: true,
    });
    assert(byUser.title === "Batch stopped", "a user-stopped batch keeps its own wording");

    const byPolicy = buildBatchNotice({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      stopped: true,
      stoppedBy: "failure",
      stoppedByTest: "Seed data",
    });
    assert(
      byPolicy.title !== "Batch stopped",
      "a policy-stopped routine does not claim the user stopped it",
    );
    assert(
      byPolicy.body.includes("Seed data"),
      "…and names the step that stopped it, so the notification is actionable",
    );
    // The counts still have to be there — naming the cause must not cost the
    // information the notification existed for.
    assert(
      byPolicy.body.includes("1 passed") && byPolicy.body.includes("1 not run"),
      "…without losing the counts",
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
    // And the entries are BARE — `{testId}` and nothing else. This used to be
    // guaranteed by an early return that the per-engine fan-out replaced with a
    // loop; the MCP calls this function with no options at all, so an entry
    // carrying `browser: undefined` would spread into the BatchTestResult that
    // gets written to batch-history.json.
    //
    // Object.keys, NOT JSON.stringify: stringify DROPS undefined-valued keys,
    // so it reports `{testId:"a", browser:undefined}` as `{"testId":"a"}` and
    // this assertion would pass against exactly the regression it names.
    const keys = plain.map((e) => Object.keys(e).sort().join(","));
    assert(
      keys.every((k) => k === "testId"),
      `a no-options queue carries no extra keys (got ${keys.join(" | ")})`,
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

  // ---- parallel batches ---------------------------------------------------
  //
  // `concurrency` is the only thing that lets several runs overlap. Every
  // property below is one a plausible implementation gets wrong: running more
  // than asked, running the same test twice at once, stalling the pool on a
  // failure, or stopping only the head of the pack.

  // ── Exactly N at once, and the next starts only as one frees up ────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b", "c", "d", "e"], concurrency: 3 });
    await tick();

    assert(
      fake.started.length === 3,
      `concurrency 3 starts exactly three runs up front (got ${fake.started.length})`,
    );
    assert(
      fake.started.join(",") === "a,b,c",
      `the first three are started in queue order (got ${fake.started.join(",")})`,
    );
    assert(!fake.isPending("d"), "the fourth test waits for a slot");

    fake.finish("b", 0);
    await tick();
    assert(
      fake.started.length === 4 && fake.started[3] === "d",
      "a finished run frees a slot for the next test",
    );
    assert(fake.maxLive === 3, `never exceeds the requested concurrency (peak ${fake.maxLive})`);

    fake.finish("a", 0);
    fake.finish("c", 1);
    await tick();
    fake.finish("d", 0);
    fake.finish("e", 0);
    await tick();

    const done = fake.doneEvent();
    assert(done?.summary.total === 5, "every test in a parallel batch is accounted for");
    assert(
      done?.summary.passed === 4 && done?.summary.failed === 1,
      `parallel results are attributed correctly (${done?.summary.passed}p/${done?.summary.failed}f)`,
    );
    assert(fake.maxLive === 3, `peak concurrency held at 3 for the whole batch (${fake.maxLive})`);
  }

  // ── A sweep still runs ONE test's rows one at a time ───────────────
  //
  // THE load-bearing case. The runner keys a live run by testId, so two rows of
  // the same test in flight together means start() declines the second with
  // `alreadyRunning` and the row is reported skipped — i.e. a "run every row"
  // sweep silently runs one row. Lanes are what prevent it, and nothing else in
  // this suite would notice if they were removed.
  {
    const fake = makeFake({
      datasets: {
        a: [
          { id: "d1", name: "GBP", values: { currency: "GBP" } },
          { id: "d2", name: "USD", values: { currency: "USD" } },
          { id: "d3", name: "EUR", values: { currency: "EUR" } },
        ],
      },
    });
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"], allDatasets: true, concurrency: 8 });
    await tick();

    assert(
      fake.maxLiveFor("a") === 1,
      `a swept test never has two rows in flight at once (peak ${fake.maxLiveFor("a")})`,
    );
    assert(
      fake.started.filter((id) => id === "a").length === 1,
      "only the first row of a swept test has started",
    );
    assert(fake.isPending("b"), "an unrelated test runs in parallel with the sweep");
    assert(
      fake.maxLive === 2,
      `concurrency is capped at the number of DISTINCT tests (peak ${fake.maxLive})`,
    );

    fake.finish("a", 0);
    await tick();
    fake.finish("a", 0);
    await tick();
    fake.finish("a", 1);
    await tick();
    fake.finish("b", 0);
    await tick();

    const done = fake.doneEvent();
    const rows = done?.results.filter((r) => r.testId === "a") ?? [];
    assert(rows.length === 3, `every row is still queued (got ${rows.length})`);
    assert(
      rows.every((r) => r.status !== "skipped"),
      "no row is skipped as 'That test was already running'",
    );
    assert(
      rows.map((r) => r.datasetName).join(",") === "GBP,USD,EUR",
      `rows keep their declared order (got ${rows.map((r) => r.datasetName).join(",")})`,
    );
    assert(
      rows.map((r) => r.status).join(",") === "passed,passed,failed",
      `each row reports its own outcome (got ${rows.map((r) => r.status).join(",")})`,
    );
    assert(fake.maxLiveFor("a") === 1, "a swept test stayed serialized for the whole batch");
  }

  // ── Batch completion notification ──────────────────────────────────
  // The whole point: the Batch view's toast only fires while that view is
  // mounted, so starting a suite and navigating away meant never being told it
  // finished. A CLEAN batch must notify too — "all 12 passed" is the message
  // the user walked away waiting for, and the per-run notifier's
  // return-null-on-success rule is exactly wrong here.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"] });
    await tick();
    fake.finish("a", 0);
    await tick();
    fake.finish("b", 0);
    await tick();

    assert(fake.notices.length === 1, `exactly one notification per batch (${fake.notices.length})`);
    assert(fake.notices[0].failed === 0 && fake.notices[0].passed === 2, "a clean batch notifies");
    assert(fake.notices[0].stopped === false, "a completed batch is not reported as stopped");
    assert(
      buildBatchNotice(fake.notices[0]).title === "Batch passed",
      `a clean batch says so (got "${buildBatchNotice(fake.notices[0]).title}")`,
    );
  }

  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"] });
    await tick();
    fake.finish("a", 1);
    await tick();
    fake.finish("b", 0);
    await tick();

    assert(fake.notices.length === 1, "a failing batch still notifies exactly once");
    assert(
      buildBatchNotice(fake.notices[0]).title === "Batch finished — 1 failed",
      `a failing batch names the count (got "${buildBatchNotice(fake.notices[0]).title}")`,
    );
  }

  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"] });
    await tick();
    batch.stop();
    await tick();

    assert(fake.notices.length === 1, "a stopped batch notifies rather than going silent");
    assert(fake.notices[0].stopped === true, "the notice knows it was stopped");
    assert(
      buildBatchNotice(fake.notices[0]).title === "Batch stopped",
      `a stopped batch says stopped, not failed (got "${buildBatchNotice(fake.notices[0]).title}")`,
    );
  }

  // A run INSIDE a batch stays silent, however the per-run setting is set.
  // Before this, a batch with eight failures fired eight macOS notifications
  // and none for the batch — the opposite of what a batch notification is for.
  {
    assert(
      shouldNotifyRun({ batchId: "b1", enabled: true }) === false,
      "a run inside a batch does not post its own notification",
    );
    assert(
      shouldNotifyRun({ batchId: undefined, enabled: true }) === true,
      "a standalone run still notifies when the setting is on",
    );
    assert(
      shouldNotifyRun({ batchId: undefined, enabled: false }) === false,
      "the per-run setting still switches standalone runs off",
    );
  }

  // The notice text itself, without a runner.
  {
    assert(
      buildBatchNotice({ total: 1, passed: 1, failed: 0, skipped: 0, stopped: false }).body ===
        "All 1 run passed.",
      "singular run reads correctly",
    );
    assert(
      buildBatchNotice({ total: 5, passed: 3, failed: 0, skipped: 2, stopped: false }).body ===
        "All 3 runs passed. 2 skipped.",
      "skipped runs are named, so 'all passed' can't hide them",
    );
  }

  // ── Multi-engine fan-out ───────────────────────────────────────────
  // One test on N engines is N queue entries. The lane invariant is what makes
  // that safe, and it only holds because a test's entries are CONTIGUOUS in the
  // queue — interleave them across tests and buildLanes reorders everything.
  {
    const queue = buildQueue(
      {
        testIds: ["a", "b"],
        perTest: [
          { testId: "a", browsers: ["chromium", "firefox", "webkit"], headless: true },
          { testId: "b", browsers: ["webkit"], headless: false },
        ],
      },
      () => [],
    );
    assert(queue.length === 4, `3 engines + 1 engine is 4 entries (got ${queue.length})`);
    assert(
      queue.map((e) => `${e.testId}:${e.browser}`).join(",") ===
        "a:chromium,a:firefox,a:webkit,b:webkit",
      `a test's engines stay contiguous and in order (got ${queue
        .map((e) => `${e.testId}:${e.browser}`)
        .join(",")})`,
    );
    assert(
      queue.every((e) => (e.testId === "a" ? e.headless === true : e.headless === false)),
      "each entry carries its own row's headedness",
    );
    // Flattening lanes must reproduce queue order, or running at concurrency 1
    // stops being byte-identical to the old sequential loop.
    const flat = buildLanes(queue).flat();
    assert(
      flat.join(",") === queue.map((_, i) => i).join(","),
      `flattened lanes reproduce queue order exactly (got ${flat.join(",")})`,
    );
  }

  // A test with no perTest entry is the MCP path and every batch recorded
  // before per-row options existed. It contributes ONE entry carrying no engine
  // of its own — which is what lets runEntry fall back to the batch-wide
  // `browser`. The queue has no opinion about that fallback (the shared module
  // never sees `params.browser`); the runner applies it, and the fan-out block
  // above asserts that end of it.
  {
    const queue = buildQueue(
      {
        testIds: ["a", "b"],
        perTest: [{ testId: "a", browsers: ["webkit"], headless: false }],
      },
      () => [],
    );
    assert(queue.length === 2, `an unlisted test contributes exactly one entry (${queue.length})`);
    assert(queue[1].browser === undefined, "an unlisted test carries no engine of its own");
    assert(queue[1].headless === undefined, "and no headedness of its own");
  }

  // Engines multiply dataset rows rather than replacing them.
  {
    const queue = buildQueue(
      {
        testIds: ["a"],
        allDatasets: true,
        perTest: [{ testId: "a", browsers: ["chromium", "webkit"], headless: false }],
      },
      () => [
        { id: "d1", name: "GBP", values: { currency: "GBP" } },
        { id: "d2", name: "USD", values: { currency: "USD" } },
      ],
    );
    assert(queue.length === 4, `2 engines x 2 rows is 4 entries (got ${queue.length})`);
    assert(
      queue.map((e) => `${e.browser}/${e.datasetName}`).join(",") ===
        "chromium/GBP,chromium/USD,webkit/GBP,webkit/USD",
      `engine-major within the test (got ${queue.map((e) => `${e.browser}/${e.datasetName}`).join(",")})`,
    );
  }

  // THE load-bearing assertion. Three engines of one test must never be in
  // flight together however wide the batch is asked to run: runId === testId, so
  // the runner would decline the second and third with `alreadyRunning` and the
  // batch would report two of the three engines as skipped.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["a", "b"],
      concurrency: 8,
      perTest: [
        { testId: "a", browsers: ["chromium", "firefox", "webkit"], headless: true },
        { testId: "b", browsers: ["chromium"], headless: false },
      ],
    });
    await tick();

    assert(
      fake.maxLiveFor("a") === 1,
      `a fanned-out test never has two engines in flight at once (peak ${fake.maxLiveFor("a")})`,
    );
    assert(fake.isPending("b"), "a different test still runs in parallel with the fan-out");

    fake.finish("a", 0);
    await tick();
    fake.finish("a", 0);
    await tick();
    fake.finish("a", 1);
    await tick();
    fake.finish("b", 0);
    await tick();

    assert(fake.maxLiveFor("a") === 1, "stayed serialized for the whole batch");

    const startsForA = fake.startedWithDataset.filter((s) => s.testId === "a");
    assert(
      startsForA.map((s) => s.browser).join(",") === "chromium,firefox,webkit",
      `each engine was actually requested (got ${startsForA.map((s) => s.browser).join(",")})`,
    );
    // headed and runHeadless are two spellings of one choice; letting them
    // disagree opens a window for a run the user asked to be headless.
    assert(
      startsForA.every((s) => s.runHeadless === true && s.headed === false),
      "a headless row starts headless, with headed derived from the same value",
    );
    const startsForB = fake.startedWithDataset.filter((s) => s.testId === "b");
    assert(
      startsForB.every((s) => s.runHeadless === false && s.headed === true),
      "a headed row in the same batch still starts headed",
    );

    const done = fake.doneEvent();
    const rows = done?.results.filter((r) => r.testId === "a") ?? [];
    assert(rows.length === 3, `every engine has its own result row (got ${rows.length})`);
    assert(
      rows.map((r) => r.browser).join(",") === "chromium,firefox,webkit",
      `results name their engine, so three rows are distinguishable (got ${rows
        .map((r) => r.browser)
        .join(",")})`,
    );
    assert(
      rows.map((r) => r.status).join(",") === "passed,passed,failed",
      `each engine reports its own outcome (got ${rows.map((r) => r.status).join(",")})`,
    );
  }

  // Stopping mid-fan-out kills by testId, which is still the run id.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({
      testIds: ["a"],
      perTest: [{ testId: "a", browsers: ["chromium", "firefox", "webkit"], headless: false }],
    });
    await tick();
    batch.stop();
    await tick();
    assert(fake.stopped.includes("a"), "stop killed the in-flight engine by test id");
    const done = fake.doneEvent();
    assert(done?.stopped === true, "the batch reports itself stopped");
    assert(
      (done?.results ?? []).filter((r) => r.status === "skipped").length === 2,
      "the engines that never started are skipped, not left pending",
    );
  }

  // The concurrency ceiling stays DISTINCT TESTS, not the fan-out count.
  // Raising it to the queue length would leave workers idling on empty lanes
  // and make the headed warning promise more windows than ever open.
  {
    const queue = buildQueue(
      {
        testIds: ["a", "b"],
        perTest: [
          { testId: "a", browsers: ["chromium", "firefox", "webkit"], headless: false },
          { testId: "b", browsers: ["chromium", "webkit"], headless: false },
        ],
      },
      () => [],
    );
    assert(
      buildLanes(queue).length === clampBatchConcurrency(99, new Set(["a", "b"]).size),
      "lane count equals the handler's clamp over distinct tests",
    );
  }

  // ── Asking for more than there are tests is not an error ───────────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b"], concurrency: MAX_BATCH_CONCURRENCY });
    await tick();
    assert(fake.maxLive === 2, `clamped to the number of tests (peak ${fake.maxLive})`);
    fake.finish("a", 0);
    fake.finish("b", 0);
    await tick();
    assert(fake.doneEvent()?.summary.passed === 2, "both tests still ran");
  }

  // ── concurrency 1 (and absent) is byte-for-byte the old behaviour ──
  //
  // The sequential path must not become "the parallel path with the dial turned
  // down": lanes are flattened in first-appearance order, and buildQueue emits a
  // test's rows contiguously, so one worker reproduces queue order exactly.
  {
    const rows: Record<string, Dataset[]> = {
      a: [
        { id: "d1", name: "GBP", values: {} },
        { id: "d2", name: "USD", values: {} },
      ],
    };
    // The repeated "a" is the case that breaks this if the selection isn't
    // deduped: its entries would straddle b's, and grouping them into one lane
    // would reorder the queue — a silent behaviour change at concurrency 1.
    const queue = buildQueue({ testIds: ["a", "b", "a"], allDatasets: true }, (id) => rows[id] ?? []);
    assert(
      queue.map((e) => `${e.testId}${e.datasetName ?? ""}`).join(",") === "aGBP,aUSD,b",
      `a repeated id in the selection is deduped (got ${queue.map((e) => e.testId).join(",")})`,
    );
    const flattened = buildLanes(queue).flat();
    assert(
      flattened.join(",") === queue.map((_, i) => i).join(","),
      `one worker walks the queue in queue order (got ${flattened.join(",")})`,
    );

    for (const concurrency of [undefined, 1]) {
      const fake = makeFake({});
      const batch = createBatchRunner(fake.deps);
      batch.start({ testIds: ["a", "b", "c"], concurrency });
      await tick();
      assert(
        fake.started.length === 1,
        `concurrency ${String(concurrency)} starts only the first test`,
      );
      fake.finish("a", 0);
      await tick();
      fake.finish("b", 0);
      await tick();
      fake.finish("c", 0);
      await tick();
      assert(
        fake.maxLive === 1,
        `concurrency ${String(concurrency)} never overlaps (peak ${fake.maxLive})`,
      );
      assert(
        fake.started.join(",") === "a,b,c",
        `concurrency ${String(concurrency)} keeps queue order`,
      );
    }
  }

  // ── A failure in one lane doesn't stall the others ─────────────────
  {
    const fake = makeFake({ names: { gone: null } });
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["gone", "a", "b", "c"], concurrency: 2 });
    await tick();

    // "gone" is skipped without ever starting, so its worker must move straight
    // on rather than holding a slot.
    assert(!fake.started.includes("gone"), "a deleted test never starts a run");
    assert(
      fake.started.length === 2 && fake.started.join(",") === "a,b",
      `the pool refills past a skipped test (started ${fake.started.join(",")})`,
    );

    fake.finish("a", 1);
    await tick();
    assert(fake.started.includes("c"), "a FAILING test frees its slot like any other");
    fake.finish("b", 0);
    fake.finish("c", 0);
    await tick();

    const done = fake.doneEvent();
    assert(done?.summary.skipped === 1, "the deleted test counts as skipped");
    assert(done?.summary.failed === 1 && done?.summary.passed === 2, "the rest are attributed");
    assert(done?.running === false, "the batch finishes rather than hanging on the empty lane");
  }

  // ── stop() kills EVERY running test, not just the first ────────────
  //
  // Regression: stop() used to kill `results[currentIndex]`. With several in
  // flight that leaves the other browsers open while the UI reports the batch
  // as stopped — windows the user then has to close by hand.
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b", "c", "d"], concurrency: 3 });
    await tick();
    fake.finish("a", 0);
    await tick();
    // a passed; b, c, d are now the live set.
    assert(fake.pendingIds().length === 3, "three runs are in flight before the stop");

    batch.stop();
    await tick();
    await tick();

    assert(
      ["b", "c", "d"].every((id) => fake.stopped.includes(id)),
      `stop() kills every running test (killed ${fake.stopped.join(",")})`,
    );
    const done = fake.doneEvent();
    assert(done?.stopped === true, "a stopped parallel batch is marked stopped");
    assert(done?.running === false, "a stopped parallel batch is no longer running");
    assert(
      done?.results.find((r) => r.testId === "a")?.status === "passed",
      "results from before the stop are kept",
    );
  }

  // ── currentIndex stays meaningful for readers that persist it ──────
  {
    const fake = makeFake({});
    const batch = createBatchRunner(fake.deps);
    batch.start({ testIds: ["a", "b", "c"], concurrency: 3 });
    await tick();
    assert(
      batch.getState()?.currentIndex === 0,
      `currentIndex is the LOWEST running entry (got ${batch.getState()?.currentIndex})`,
    );
    fake.finish("a", 0);
    await tick();
    assert(
      batch.getState()?.currentIndex === 1,
      `currentIndex advances as the head finishes (got ${batch.getState()?.currentIndex})`,
    );
    fake.finish("b", 0);
    fake.finish("c", 0);
    await tick();
    assert(batch.getState()?.currentIndex === -1, "currentIndex is -1 once nothing is running");
  }

  // ── Clamping agrees wherever it is applied ─────────────────────────
  {
    assert(clampBatchConcurrency(4, 10) === 4, "an in-range request is honoured");
    assert(clampBatchConcurrency(99, 10) === 10, "clamped down to the lane count");
    assert(
      clampBatchConcurrency(99, 999) === MAX_BATCH_CONCURRENCY,
      "clamped down to the hard ceiling",
    );
    assert(clampBatchConcurrency(0, 10) === 1, "zero means one at a time");
    assert(clampBatchConcurrency(-5, 10) === 1, "a negative means one at a time");
    assert(clampBatchConcurrency(2.9, 10) === 2, "a fraction floors rather than rounding up");
    assert(clampBatchConcurrency(undefined, 10) === 1, "absent means one at a time");
    // A hostile IPC payload: the handler's `params` is untyped at runtime.
    assert(clampBatchConcurrency("8" as unknown, 10) === 1, "a numeric STRING is not a number");
    assert(clampBatchConcurrency(Number.NaN, 10) === 1, "NaN means one at a time");
    assert(clampBatchConcurrency(Infinity, 10) === 1, "Infinity means one at a time");
    assert(clampBatchConcurrency(4, 0) === 1, "an empty queue can't run four at once");
  }

  // ── App ↔ MCP pool parity ─────────────────────────────────────────
  //
  // Same reasoning as the summary parity below: two implementations of one
  // rule. A suite must not behave differently depending on whether a person or
  // an agent started it.
  {
    assert(clampParallel(4, 10) === 4, "MCP: an in-range request is honoured");
    assert(clampParallel(99, 10) === 10, "MCP: clamped down to the item count");
    assert(
      clampParallel(99, 999) === MAX_BATCH_CONCURRENCY,
      "MCP and app share one hard ceiling",
    );
    for (const [requested, items] of [
      [4, 10],
      [99, 10],
      [99, 999],
      [0, 10],
      [-5, 10],
      [2.9, 10],
      [Number.NaN, 10],
      [4, 0],
    ] as [number, number][]) {
      assert(
        clampParallel(requested, items) === clampBatchConcurrency(requested, items),
        `app and MCP clamp agree — ${requested} over ${items} items`,
      );
    }

    // Ordering + limit, on the pool itself.
    const order: number[] = [];
    let poolLive = 0;
    let poolPeak = 0;
    const release: (() => void)[] = [];
    const items = [0, 1, 2, 3, 4];
    const finished = runPool(items, 2, async (item: number) => {
      order.push(item);
      poolLive++;
      poolPeak = Math.max(poolPeak, poolLive);
      await new Promise<void>((r) => release.push(r));
      poolLive--;
    });
    await tick();
    assert(order.join(",") === "0,1", `MCP pool claims items in order (got ${order.join(",")})`);
    assert(poolPeak === 2, `MCP pool honours its limit (peak ${poolPeak})`);
    while (release.length > 0) {
      release.shift()?.();
      await tick();
    }
    await finished;
    assert(order.join(",") === "0,1,2,3,4", "MCP pool eventually runs every item");
    assert(poolPeak === 2, `MCP pool never exceeded its limit (peak ${poolPeak})`);

    // A throwing worker must not take the batch down with it.
    const seen: number[] = [];
    await runPool([0, 1, 2], 2, async (item: number) => {
      if (item === 0) throw new Error("boom");
      seen.push(item);
    });
    assert(seen.join(",") === "1,2", `MCP pool survives a throwing item (got ${seen.join(",")})`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll batch-runner checks passed");
}

void main();
