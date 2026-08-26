// The job ticker — what the app is doing, in the top strip. REDESIGN §6.8.
//
// ONE SHAPE, FIVE READINGS. The strip has room for a few words, and the ticker
// has to answer "is anything happening?" from any screen without the user going
// to look. So it is not a progress UI: it is a sentence, and the work here is
// deciding WHICH sentence, because a readout that says the wrong true thing is
// worse than one that says nothing.
//
// PURE, over what `recorder-store` already holds. That store owns the live run
// map and (as of §6.8) the live batch, and it is the one provider mounted for
// the whole session — which is why the ticker's data source is that store and
// not a new provider or a poll. The store's own `runs:changed` comment makes
// the argument: a subscription that lives on a route component is one that is
// not listening on every other route.

/** One execution, as `recorder-store` knows it. Structural, so this module does
 *  not drag the store's types across and can be tested with two fields. */
export interface TickerRun {
  running: boolean;
  /** Exit code once finished, null while running. */
  code: number | null;
  /** When this execution started. */
  startedAt: number;
  /** When it ENDED, which is the clock the failure hold runs on.
   *
   *  Not `startedAt`, and the difference is the whole correctness of the
   *  reading: a run that takes longer than the hold window would be expired
   *  before it had finished, so the one notice this feature exists to give —
   *  a long run that failed while you were elsewhere — is the exact one it
   *  would never give. Undefined while running. */
  finishedAt?: number;
}

/** The live batch, as `recorder-store` knows it. */
export interface TickerBatch {
  running: boolean;
  finishedAt?: number;
  summary: { total: number; passed: number; failed: number; skipped: number };
  stopped: boolean;
}

export type TickerReading =
  /** Exactly one test running. Named, because with one job the name IS the
   *  information — "1 running" makes the user go and look at what. */
  | { kind: "one"; label: string; testId: string; tone: "run" }
  /** Several at once. Counted, because five names do not fit and a truncated
   *  list is a lie about which five. */
  | { kind: "several"; label: string; count: number; tone: "run" }
  /** A batch, which reports progress the individual runs cannot. */
  | { kind: "batch"; label: string; done: number; total: number; tone: "run" }
  /** Something finished badly, held briefly. */
  | { kind: "failed"; label: string; testId: string | null; tone: "fail" };

export interface TickerInput {
  /** The store's run map. THE KEY IS THE TEST ID — the store documents this
   *  (`recordId` is the per-execution id and only arrives at the end), and it
   *  is why nothing here carries a `testId` field of its own. A second copy of
   *  an identifier is a second thing that can disagree. */
  runs: Record<string, TickerRun>;
  /** Resolves a test id to its name. Returns null for a test that has been
   *  deleted mid-run, which is rare and must not render "undefined". */
  nameOf: (testId: string) => string | null;
  batch: TickerBatch | null;
  now: number;
}

/**
 * How long a failure stays in the strip after the run ends.
 *
 * IT IS A NOTICE, NOT A STATUS, so it expires. A permanent red readout in the
 * chrome is a thing people stop seeing in a day and then never see again — and
 * the run's own screen is where a failure lives; this is only here to catch
 * somebody who walked away. Twelve seconds is long enough to look up at.
 */
export const FAILURE_HOLD_MS = 12_000;

// EVERY LABEL LEADS WITH ITS STATE, AND THAT IS A TRUNCATION RULE RATHER THAN a
// style one. The strip gives the ticker a couple of hundred pixels and a test
// name will exceed it, so something is going to be cut — and the first version
// of this put the verb last ("Login — wrong password shows an error failed"),
// where the word FAILED was the first thing lost. What was left was a red dot
// beside what looked like a test name, which reads as "here is a test", not
// "this one broke". Leading with the state means the part that gets cut is the
// part the user can recover by clicking through.

/**
 * What the strip says, or null for nothing at all.
 *
 * IDLE IS HIDDEN, and that is the reading that took the most deciding. An "idle"
 * chip is a permanent word in the chrome that is true and useless — it costs the
 * same attention every time the user looks at the strip and pays it back only in
 * the rare moment it changes. Rendering nothing makes the ticker's PRESENCE the
 * signal, which is what makes a glance work.
 */
export function summariseJobs(input: TickerInput): TickerReading | null {
  const { runs, batch, nameOf, now } = input;
  const all = Object.entries(runs);
  const running = all.filter(([, r]) => r.running);

  // A BATCH OUTRANKS ITS OWN RUNS. It executes tests, so its members show up in
  // the run map too — reporting "3 running" during a batch of eight would be a
  // true statement about a smaller thing than the one the user started.
  if (batch?.running) {
    const { total, passed, failed, skipped } = batch.summary;
    const done = passed + failed + skipped;
    return {
      kind: "batch",
      label: `Routine ${done}/${total}`,
      done,
      total,
      tone: "run",
    };
  }

  if (running.length === 1) {
    const [testId] = running[0];
    const name = nameOf(testId);
    return {
      kind: "one",
      // No name is not "undefined": a test deleted mid-run still has a run.
      label: name ? `Running ${name}` : "Running",
      testId,
      tone: "run",
    };
  }

  if (running.length > 1) {
    return {
      kind: "several",
      label: `${running.length} running`,
      count: running.length,
      tone: "run",
    };
  }

  // Nothing is running. Was something just lost?
  //
  // A BATCH'S FAILURE IS THE BATCH'S, NOT ITS LAST TEST'S. A batch that finishes
  // with three failures out of eight is one finding; reporting the last member
  // to fail would name one test and hide the other two.
  if (batch && !batch.running && !batch.stopped && batch.summary.failed > 0) {
    if (batch.finishedAt !== undefined && now - batch.finishedAt < FAILURE_HOLD_MS) {
      const { failed, total } = batch.summary;
      return {
        kind: "failed",
        label: `Routine failed: ${failed} of ${total}`,
        testId: null,
        tone: "fail",
      };
    }
  }

  // The most recent finished run, and only if it is the most recent — an older
  // failure surfacing because a later PASS scrolled past its hold window would
  // report the app as broken while it is fine.
  const finished = all
    .filter(([, r]) => !r.running && r.code !== null && r.finishedAt !== undefined)
    // Ordered by when they ENDED. Two runs started a minute apart can finish in
    // the other order, and "most recent" here means the last thing the user saw
    // happen.
    .sort((a, b) => (b[1].finishedAt ?? 0) - (a[1].finishedAt ?? 0))[0];
  if (finished && finished[1].code !== 0 && now - (finished[1].finishedAt ?? 0) < FAILURE_HOLD_MS) {
    const [testId] = finished;
    const name = nameOf(testId);
    return {
      kind: "failed",
      label: name ? `Failed: ${name}` : "A run failed",
      testId,
      tone: "fail",
    };
  }

  return null;
}
