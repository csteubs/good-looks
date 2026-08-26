// The job ticker's reading. REDESIGN §6.8.
//
// The label is the feature, so these assert the sentence rather than the shape
// around it — the same rule §6.6's provenance, drift and region lines follow.
//
// Three things here would be quietly wrong and none would throw. A batch
// reporting its member runs instead of itself understates what is happening. A
// failure hold measured from the run's START expires before a long run has even
// finished, which kills the one notice this exists to give. And an idle reading
// that renders anything at all puts a permanent word in the chrome, which is how
// a glanceable strip stops being glanceable.

import { describe, expect, it } from "vitest";

import {
  FAILURE_HOLD_MS,
  type TickerBatch,
  type TickerRun,
  summariseJobs,
} from "./job-ticker";

const NOW = 1_700_000_000_000;

function run(over: Partial<TickerRun> = {}): TickerRun {
  return { running: true, code: null, startedAt: NOW - 1_000, ...over };
}

function batch(over: Partial<TickerBatch> = {}): TickerBatch {
  return {
    running: true,
    stopped: false,
    summary: { total: 8, passed: 2, failed: 0, skipped: 0 },
    ...over,
  };
}

/** Names every test after its id, unless told otherwise. */
const names = (map: Record<string, string> = {}) => (id: string) => map[id] ?? id;

function read(
  runs: Record<string, TickerRun>,
  opts: { batch?: TickerBatch | null; now?: number; names?: Record<string, string> } = {},
) {
  return summariseJobs({
    runs,
    batch: opts.batch ?? null,
    nameOf: names(opts.names),
    now: opts.now ?? NOW,
  });
}

describe("idle", () => {
  it("renders nothing at all", () => {
    // An "idle" chip is a permanent word in the chrome that is true and
    // useless. The ticker's PRESENCE is the signal.
    expect(read({})).toBeNull();
  });

  it("renders nothing after a run that PASSED", () => {
    // Good news does not belong in the chrome either — the run's own screen
    // says so, and a green word up here would be there most of the time.
    expect(
      read({ t1: run({ running: false, code: 0, finishedAt: NOW - 100 }) }),
    ).toBeNull();
  });
});

describe("running", () => {
  it("names the test when there is exactly one", () => {
    // With one job the name IS the information; "1 running" makes the user go
    // and look at what.
    expect(read({ t1: run() }, { names: { t1: "Checkout" } })).toMatchObject({
      kind: "one",
      label: "Running Checkout",
      testId: "t1",
    });
  });

  it("does not render 'undefined' for a test deleted mid-run", () => {
    expect(read({ gone: run({}) }, { names: {} })?.label).toBe("Running gone");
    expect(
      summariseJobs({ runs: { gone: run() }, nameOf: () => null, batch: null, now: NOW }),
    ).toMatchObject({ label: "Running" });
  });

  it("counts rather than listing when several are going", () => {
    // Five names do not fit, and a truncated list is a lie about which five.
    const runs = { a: run({}), b: run({}), c: run({}) };
    expect(read(runs)).toMatchObject({ kind: "several", label: "3 running", count: 3 });
  });
});

describe("a batch", () => {
  it("outranks its own member runs", () => {
    // A batch executes tests, so its members are in the run map too. Reporting
    // "3 running" during a batch of eight is a true statement about a smaller
    // thing than the one the user started.
    const runs = { a: run({}), b: run({}), c: run({}) };
    expect(read(runs, { batch: batch() })).toMatchObject({
      kind: "batch",
      label: "Routine 2/8",
    });
  });

  it("counts skipped and failed as done, not just passed", () => {
    // Progress is how far through it is. A batch stuck at "2/8" while six have
    // failed reads as hung.
    expect(
      read({}, { batch: batch({ summary: { total: 8, passed: 2, failed: 3, skipped: 1 } }) }),
    ).toMatchObject({ label: "Routine 6/8" });
  });

  it("reports its OWN failure, not its last test's", () => {
    // Three failures out of eight is one finding; naming the last member to
    // fail would name one test and hide the other two.
    const reading = read(
      { a: run({ running: false, code: 1, finishedAt: NOW - 500 }) },
      {
        batch: batch({
          running: false,
          finishedAt: NOW - 500,
          summary: { total: 8, passed: 5, failed: 3, skipped: 0 },
        }),
        names: { a: "Checkout" },
      },
    );
    expect(reading).toMatchObject({ kind: "failed", label: "Routine failed: 3 of 8", testId: null });
  });

  it("says nothing about a batch the user stopped", () => {
    // They stopped it; they know. A red notice for an outcome somebody chose
    // reads as the app disagreeing with them.
    expect(
      read(
        {},
        {
          batch: batch({
            running: false,
            stopped: true,
            finishedAt: NOW - 500,
            summary: { total: 8, passed: 2, failed: 1, skipped: 5 },
          }),
        },
      ),
    ).toBeNull();
  });
});

describe("a failure, held briefly", () => {
  it("leads with the state, because that is what truncation would eat", () => {
    // The strip gives this a couple of hundred pixels and test names exceed it.
    // With the verb last, "…shows an error failed" loses FAILED first, and what
    // is left is a red dot beside what looks like a name.
    const reading = read(
      { t1: run({ running: false, code: 1, finishedAt: NOW - 500 }) },
      { names: { t1: "Login — wrong password shows an error" } },
    );
    expect(reading?.label.startsWith("Failed")).toBe(true);
  });

  it("names the test that failed", () => {
    expect(
      read({ t1: run({ running: false, code: 1, finishedAt: NOW - 500 }) }, { names: { t1: "Login" } }),
    ).toMatchObject({ kind: "failed", label: "Failed: Login", tone: "fail" });
  });

  it("is measured from when the run ENDED, not when it started", () => {
    // THE ONE THAT MATTERS. A run longer than the hold window would be expired
    // before it finished — so the exact notice this exists to give, a long run
    // that failed while the user was elsewhere, is the one it would never give.
    const longRun = run({
      running: false,
      code: 1,
      startedAt: NOW - FAILURE_HOLD_MS * 3,
      finishedAt: NOW - 500,
    });
    expect(read({ t1: longRun })).toMatchObject({ kind: "failed" });
  });

  it("expires", () => {
    // It is a notice, not a status. A permanent red readout in the chrome is a
    // thing people stop seeing in a day and then never see again.
    expect(
      read({ t1: run({ running: false, code: 1, finishedAt: NOW - FAILURE_HOLD_MS - 1 }) }),
    ).toBeNull();
  });

  it("does not resurrect an older failure behind a newer pass", () => {
    // Otherwise a fixed test reports the app as broken the moment the passing
    // run's own reading goes quiet.
    const runs = {
      old: run({ running: false, code: 1, finishedAt: NOW - 5_000 }),
      fresh: run({ running: false, code: 0, finishedAt: NOW - 500 }),
    };
    expect(read(runs)).toBeNull();
  });

  it("orders by finish time, not start time", () => {
    // Two runs started a minute apart can finish in the other order, and "most
    // recent" here means the last thing the user saw happen.
    const runs = {
      slow: run({ running: false, code: 1, startedAt: NOW - 60_000, finishedAt: NOW - 200 }),
      quick: run({ running: false, code: 0, startedAt: NOW - 5_000, finishedAt: NOW - 4_000 }),
    };
    expect(read(runs, { names: { slow: "Slow" } })).toMatchObject({ label: "Failed: Slow" });
  });

  it("is outranked by anything actually running", () => {
    // What the app is doing now beats what it did a moment ago.
    const runs = {
      dead: run({ running: false, code: 1, finishedAt: NOW - 500 }),
      live: run({}),
    };
    expect(read(runs, { names: { live: "Checkout" } })).toMatchObject({ kind: "one" });
  });
});
