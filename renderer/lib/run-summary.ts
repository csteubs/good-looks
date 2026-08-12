// Which of the six run states a test is in, and the facts that state needs.
//
// REDESIGN §6.1 (the deferred half of B5). Today the detail view is shaped
// around failure: a verdict chip, a triage line and a log. That is the right
// shape for the run you arrived at because something broke, and the wrong shape
// for every other run — a passed run's panel is a green word over an eight-line
// window of Playwright's own chatter, which answers nothing anybody came to ask.
//
// So each state gets the question its reader actually has:
//
//   never    what happens when I press Run
//   running  how far in is it
//   passed   what held
//   healed   what did Auto-Heal change, and was it right
//   retry    it failed and now it passes — what was different
//   failed   why (unchanged: RunTriage already answers this)
//
// PURE, AND SEPARATE FROM THE COMPONENT, for the usual reason in this repo:
// jsdom cannot tell you whether a panel says the right thing about a run that
// took 4.2s when the median is 3.9s, but a function that takes records and
// returns facts can be asked that directly. Everything here is arithmetic over
// data the view already holds — `api.runs.list()` and `api.heals.list(id)` are
// both already queried by `test-detail-view.tsx` for other reasons.
//
// WHY "retry" MEANS WHAT IT MEANS HERE. The plan calls this state "attempt 1 vs
// attempt 2", which in a runner with `retries` configured would be two attempts
// inside one run. This app configures none — every run is one attempt — so the
// two attempts are two RUNS, and the question survives the translation intact:
// the previous run of this test failed, this one passed, what was different?
// The answer is drawn only from what the record actually stores. When the
// answer is NOTHING, that is the most useful reading the panel can give, and
// the one the user is least likely to reach on their own: same browser, same
// pacing, same budget, opposite outcome, so the test is flaky rather than fixed.

import type { HealEntry, RunRecord } from "./recorder-types";

export type RunState = "never" | "running" | "passed" | "healed" | "retry" | "failed";

/** One field that differed between a failed run and the pass that followed it.
 *  `before`/`after` are already rendered strings — the formatting rules live
 *  with the field's meaning (a missing `speed` is "unknown", never "fast"), and
 *  splitting them from the comparison invites the panel to invent a default. */
export interface RunDifference {
  label: string;
  before: string;
  after: string;
}

interface Base {
  state: RunState;
}

export interface NeverSummary extends Base {
  state: "never";
  /** How many steps the run will execute. */
  stepCount: number;
}

export interface RunningSummary extends Base {
  state: "running";
  /** Steps that have reported an outcome, and how many there are. */
  done: number;
  total: number;
  /** Steps that have already failed. A run does not stop at the first failure
   *  when the assertions are soft, so this can be non-zero mid-run. */
  failedSoFar: number;
  elapsedMs: number;
}

export interface PassedSummary extends Base {
  state: "passed";
  stepCount: number;
  durationMs: number;
  /** Median duration of this test's previous passed runs, and this run's
   *  distance from it as a signed percentage. Both null until there is a
   *  previous pass — one run is not a median, and rendering "0% slower" off a
   *  single sample is a measurement claim with no measurement behind it. */
  medianMs: number | null;
  deltaPct: number | null;
  captured: boolean;
  a11yChecks: number;
  a11yNewSteps: number;
}

export interface HealedSummary extends Base {
  state: "healed";
  /** Steps Auto-Heal got past, and steps it tried and could not. The second is
   *  absent on runs recorded before 2026-08-07 and is reported as null rather
   *  than 0 — "it never tried" and "it tried and failed nothing" are different
   *  claims and only one of them is evidence. */
  healedSteps: number;
  healFailedSteps: number | null;
  /** The journal rows this run wrote, newest first. */
  entries: HealEntry[];
  /** How many of them nobody has reviewed yet. The point of the panel: a
   *  mis-heal usually SUCCEEDS, so a healed pass is the run most worth
   *  distrusting and the one that looks most trustworthy. */
  pendingReview: number;
}

export interface RetrySummary extends Base {
  state: "retry";
  /** The failed run immediately before this one. */
  previous: RunRecord;
  differences: RunDifference[];
  durationMs: number;
  stepCount: number;
}

export interface FailedSummary extends Base {
  state: "failed";
  /** The run record, once written — `RunTriage` is keyed on it. Absent while a
   *  failing run is still being written to history. */
  recordId?: string;
}

export type RunSummary =
  | NeverSummary
  | RunningSummary
  | PassedSummary
  | HealedSummary
  | RetrySummary
  | FailedSummary;

/** The live run, as the detail view holds it. Structurally `RunInfo` minus the
 *  log lines, which no summary reads — taken as its own type so this module
 *  does not import the store and can be exercised from a plain object. */
export interface LiveRun {
  running: boolean;
  code: number | null;
  stepStatus: Record<number, string>;
  startedAt: number;
  recordId?: string;
}

export interface SummaryInput {
  testId: string;
  /** Every run this machine has recorded, unfiltered — the filtering rules
   *  (this test, real runs only, not tombstoned) are this module's, so a caller
   *  cannot get them subtly wrong on its own. */
  runs: readonly RunRecord[];
  heals: readonly HealEntry[];
  stepCount: number;
  live?: LiveRun | null;
  /** Epoch ms. Passed in rather than read, so "elapsed" is testable. */
  now: number;
}

/** This test's real runs, oldest first.
 *
 *  `baseline-update` records are excluded for the same reason Stats excludes
 *  them from its charts: accepting screenshots as new baselines is an audit
 *  event, not an execution, and counting one as "the previous run" would have
 *  the retry panel compare a pass against a bookkeeping row. */
export function runsForTest(runs: readonly RunRecord[], testId: string): RunRecord[] {
  return runs
    .filter((r) => r.testId === testId && (r.kind ?? "run") === "run")
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Median of a list of numbers, or null when there are none. Even-length lists
 *  take the mean of the middle pair. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const BROWSER_LABEL: Record<string, string> = {
  chromium: "Chromium",
  firefox: "Firefox",
  webkit: "WebKit",
};

const SPEED_LABEL: Record<string, string> = {
  fast: "Fast",
  medium: "Medium",
  slow: "Slow",
  crawl: "Crawl",
};

/** Every field of a run that could plausibly explain a different outcome, and
 *  how to read it. Table-driven rather than a chain of ifs so that adding a
 *  field to `RunRecord` is one row here, and so the ORDER is a decision made
 *  once: engine first, because a different engine is the difference most likely
 *  to be the whole answer, then pacing, then budget, then what the run was fed. */
const COMPARED_FIELDS: {
  label: string;
  read: (r: RunRecord) => string;
}[] = [
  {
    label: "Browser",
    // Absent means chromium — every run predating the picker ran on it, which
    // is a fact about this app's history rather than a default we are choosing.
    read: (r) => BROWSER_LABEL[r.runBrowser ?? "chromium"] ?? (r.runBrowser ?? "chromium"),
  },
  { label: "Headless", read: (r) => (r.runHeadless ? "Yes" : "No") },
  // Absent speed is UNKNOWN and never "fast" — see the field's comment in
  // recorder-types. Reporting a guess here would manufacture a difference, or
  // hide one, and both are worse than saying so.
  { label: "Pacing", read: (r) => (r.speed ? (SPEED_LABEL[r.speed] ?? r.speed) : "Unknown") },
  { label: "Capture", read: (r) => (r.captureArtifacts ? "On" : "Off") },
  { label: "Accessibility", read: (r) => ((r.a11yChecks ?? 0) > 0 ? "On" : "Off") },
  { label: "Dataset row", read: (r) => r.datasetName ?? "—" },
];

/** What differed between two runs. Empty means nothing this app records
 *  changed, which the retry panel reports as flake rather than as a fix. */
export function runDifferences(before: RunRecord, after: RunRecord): RunDifference[] {
  const out: RunDifference[] = [];
  for (const field of COMPARED_FIELDS) {
    const b = field.read(before);
    const a = field.read(after);
    if (b !== a) out.push({ label: field.label, before: b, after: a });
  }
  return out;
}

/** Facts about one finished record, given the history it sits in. Split out so
 *  the same reasoning serves a run that finished in this session (where the
 *  live info decides the state) and the last recorded run of a test opened
 *  cold — the second is why opening a test now says anything at all about it. */
function summariseRecord(
  record: RunRecord,
  earlier: readonly RunRecord[],
  heals: readonly HealEntry[],
  stepCount: number,
): RunSummary {
  if (record.status === "failed") return { state: "failed", recordId: record.id };

  const healed = record.healedSteps ?? 0;
  if (healed > 0) {
    const entries = heals
      .filter((h) => h.runId === record.id)
      .sort((a, b) => b.at - a.at);
    return {
      state: "healed",
      healedSteps: healed,
      healFailedSteps: record.healFailedSteps ?? null,
      entries,
      pendingReview: entries.filter((h) => h.status === "pending").length,
    };
  }

  const previous = earlier.length > 0 ? earlier[earlier.length - 1] : null;
  if (previous && previous.status === "failed") {
    return {
      state: "retry",
      previous,
      differences: runDifferences(previous, record),
      durationMs: record.durationMs,
      stepCount,
    };
  }

  const passedBefore = earlier.filter((r) => r.status === "passed").map((r) => r.durationMs);
  const med = median(passedBefore);
  return {
    state: "passed",
    stepCount,
    durationMs: record.durationMs,
    medianMs: med,
    deltaPct: med !== null && med > 0 ? ((record.durationMs - med) / med) * 100 : null,
    captured: record.captureArtifacts === true,
    a11yChecks: record.a11yChecks ?? 0,
    a11yNewSteps: record.a11yNewSteps ?? 0,
  };
}

/**
 * The state this test's run panel is in, and everything that state renders.
 *
 * PRECEDENCE, and each step of it is a decision:
 *
 *   1. A live run in flight is `running`, whatever the history says.
 *   2. A live run that finished takes the finished rules below, joined to its
 *      RunRecord when one has been written. Until it has — there is a window
 *      between the process exiting and history being flushed — the live exit
 *      code alone decides pass or fail, so the panel never sits blank on a run
 *      the user just watched happen.
 *   3. `healed` beats `retry`. A run that healed AND followed a failure has a
 *      named cause, and "Auto-Heal substituted this locator" is both a stronger
 *      claim and a more actionable one than "something was different".
 *   4. With no live run, the most recent RECORD is summarised. Opening a test
 *      cold used to say nothing about it at all.
 *   5. Nothing live and nothing recorded is `never`.
 */
export function summariseRun(input: SummaryInput): RunSummary {
  const { live, now, stepCount } = input;
  const history = runsForTest(input.runs, input.testId);

  if (live?.running) {
    const statuses = Object.values(live.stepStatus);
    return {
      state: "running",
      done: statuses.filter((s) => s === "passed" || s === "failed").length,
      total: stepCount,
      failedSoFar: statuses.filter((s) => s === "failed").length,
      elapsedMs: Math.max(0, now - live.startedAt),
    };
  }

  if (live) {
    // The record for THIS execution, and everything before it. Identified by
    // id rather than by "the newest record", because a batch can write another
    // test's run in between and newest-wins would summarise a stranger.
    const index = live.recordId ? history.findIndex((r) => r.id === live.recordId) : -1;
    if (index >= 0) {
      return summariseRecord(history[index], history.slice(0, index), input.heals, stepCount);
    }
    if (live.code !== null && live.code !== 0) return { state: "failed", recordId: live.recordId };
    // Passed, with no record yet: report the plain pass rather than reaching
    // for a median across runs this one is not yet part of.
    return {
      state: "passed",
      stepCount,
      durationMs: Math.max(0, now - live.startedAt),
      medianMs: null,
      deltaPct: null,
      captured: false,
      a11yChecks: 0,
      a11yNewSteps: 0,
    };
  }

  if (history.length === 0) return { state: "never", stepCount };
  return summariseRecord(
    history[history.length - 1],
    history.slice(0, history.length - 1),
    input.heals,
    stepCount,
  );
}
