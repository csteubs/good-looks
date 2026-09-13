// Persistence for test run history. Run metadata (pass/fail, timing) lives in a
// single JSON index; the raw console output for each run is stored in its own
// .log file so large outputs stay out of the index and can be inspected,
// searched, or deleted independently.
//
// Two artifacts, deleted independently by design:
//   • "stats"  → the RunRecord[] index (run-history.json) — drives the charts/table
//   • "logs"   → the raw <id>.log files in the logs/ folder
// resetStats() clears the index but keeps the .log files on disk; deleteAll()
// removes both; deleteRange() removes records + their logs within a date range.
//
// A THIRD ARTIFACT, AND THE ONE THING HERE THAT IS NOT A CACHE OF THE OTHERS:
// run-history-pruned.json, the tally of executions the CAP has dropped. The
// index is capped at MAX_RECORDS, so before it existed "Total runs" on the
// Stats board stopped at 1000 and stayed there — the app had run a test 1240
// times and said 1000, with nothing on screen admitting the difference.
//
// It is a counter rather than a derivation because there is nothing left to
// derive it from: pruning deletes the records AND their logs, and the metrics
// DB cannot answer it either — that file is a derived shadow that gets dropped
// and replayed FROM THIS INDEX on any schema change, so a lifetime total read
// out of it would silently fall back to ≤1000 the next time SCHEMA_VERSION
// moves (see main/services/metrics-store.ts, rule 3). Counting at the moment of
// pruning is the only place the information still exists.
//
// It counts EXECUTIONS only — a baseline update is an event with an incidental
// `status`, exactly as every rate on the Stats screen already treats it — and
// it is zeroed by resetStats/deleteAll, which are the user saying "forget this
// history" rather than the cap saying "this got old".

import type { SiteHealthSummary } from "../../shared/site-health.mjs";
import { isRunDigest } from "../../shared/steps-digest.mjs";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import {
  DEFAULT_RUN_LOG_RETAINED_RUNS,
  recorderSettingsStore,
} from "./recorder-settings-store.js";
import { redactWithSnapshot } from "./secret-redaction.js";
import {
  RUN_HISTORY_CAP,
  PRUNED_DAYS_KEPT,
  dayStartOf,
  emptyPrunedTally,
  foldPrunedRun,
  readPrunedTally,
  type PrunedDay,
  type PrunedTally,
} from "../../shared/run-history-rules.mjs";
import {
  normalizeRunTrigger,
  type RunTrigger,
} from "../../shared/run-trigger.mjs";
import {
  normalizeRunProvenance,
  type RunProvenance,
} from "../../shared/run-provenance.mjs";
import { DELETED_TEST_NAME } from "../recorder/types.js";
import type {
  LogSearchResult,
  RunBrowser,
  RunRecord,
  RunTotals,
  TestSpeed,
} from "../recorder/types.js";

/** How many run records this index keeps. Defined in
 *  `shared/run-history-rules.mjs` because the standalone MCP server writes the
 *  same file and had drifted 50x below it — aliased here so the rest of this
 *  file reads as it always did. */
const MAX_RECORDS = RUN_HISTORY_CAP;
const SEARCH_RESULT_CAP = 200;
const SNIPPET_RADIUS = 80; // chars of context on each side of the first match

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function logsDir(): string {
  return path.join(dataDir(), "logs");
}

function indexFile(): string {
  return path.join(dataDir(), "run-history.json");
}

function prunedTallyFile(): string {
  return path.join(dataDir(), "run-history-pruned.json");
}

function ensureDirs(): void {
  fs.mkdirSync(logsDir(), { recursive: true });
}

function readAll(): RunRecord[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RunRecord[]) : [];
  } catch {
    return [];
  }
}

function writeAll(records: RunRecord[]): void {
  ensureDirs();
  fs.writeFileSync(indexFile(), JSON.stringify(records, null, 2), "utf-8");
}

function safeUnlink(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

function logByteSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Executions the cap has pruned out of the index, by outcome.
 *
 *  `days` is the same count broken down by the LOCAL calendar day the run
 *  started, and it exists because a lifetime total is not enough for the two
 *  figures on the Stats screen that are windowed by time: the weekly digest and
 *  the pass/fail chart. Pruned runs are always OLDER than every surviving
 *  record, so once a thousand runs fit inside a week those windows lose runs to
 *  the cap exactly as the total did — "1000 runs this week" on a week that had
 *  1019. A flat counter cannot repair that; only a per-day one can. */
/**
 * The tally, or zeroes.
 *
 * The VALIDATION lives in `shared/run-history-rules.mjs`, with the cap and the
 * day bucketing, because the standalone MCP server writes this same file and
 * had drifted to the pre-#158 policy — see that module's header. Reading the
 * file stays here; what is shared is what the bytes are allowed to mean.
 */
function readTally(): PrunedTally {
  try {
    return readPrunedTally(JSON.parse(fs.readFileSync(prunedTallyFile(), "utf-8")));
  } catch {
    // Absent (nothing has been pruned yet) or unreadable. Same answer.
    return emptyPrunedTally();
  }
}

/** Best-effort, and deliberately so. This is called from inside `append`, on the
 *  path that saves a finished run — an exception here would turn a bookkeeping
 *  problem into a lost run record. Under-counting the lifetime total by one is
 *  the cheaper failure by some distance. */
function writeTally(tally: PrunedTally): void {
  try {
    ensureDirs();
    fs.writeFileSync(prunedTallyFile(), JSON.stringify(tally, null, 2), "utf-8");
  } catch (err) {
    logger.warn("recorder", "Could not record pruned-run totals", { err: String(err) });
  }
}

/**
 * Delete the raw .log of every run past the log budget, keeping the RECORD.
 *
 * The record survives with `logFile` cleared, which is exactly the shape
 * `markTestDeleted` already produces: the run still counts, its outcome and
 * timing are still readable, and `readLog` answers "no longer available" rather
 * than pointing at a path that isn't there. `logBytes` is left alone on the
 * same reasoning as that function — it records what the run once cost.
 *
 * `all` is oldest-first, so this walks BACKWARDS and keeps the newest N. Runs
 * with no log (baseline updates, already-pruned records) do not consume budget:
 * counting them would let a week of baseline pins silently evict real logs.
 */
function pruneLogsToBudget(all: RunRecord[]): void {
  let budget: number;
  try {
    budget = recorderSettingsStore.get().runLogRetainedRuns;
  } catch {
    // A settings file that will not read must not stop a run being saved.
    budget = DEFAULT_RUN_LOG_RETAINED_RUNS;
  }
  let kept = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const rec = all[i];
    if (!rec.logFile) continue;
    if (kept < budget) {
      kept++;
      continue;
    }
    safeUnlink(rec.logFile);
    rec.logFile = "";
  }
}

/**
 * Drop the oldest records beyond the cap — and remember that they existed.
 *
 * `all` must be sorted OLDEST FIRST; `shift()` takes the oldest. The two callers
 * used to inline this loop twice, which is how the tally would come to be kept
 * on one path and not the other — and a total that counts only the runs pruned
 * by `append` is wrong in a way nothing on screen can show.
 */
function pruneToCap(all: RunRecord[]): void {
  if (all.length <= MAX_RECORDS) return;
  const tally = readTally();
  let dropped = 0;
  while (all.length > MAX_RECORDS) {
    const rec = all.shift();
    if (!rec) break;
    safeUnlink(rec.logFile);
    // `foldPrunedRun` answers whether the record counted — a baseline update is
    // an event, not a run — so the tally file is rewritten only when something
    // it describes actually changed.
    if (foldPrunedRun(tally, rec)) dropped++;
  }
  if (dropped > 0) writeTally(tally);
}

export const runHistoryStore = {
  /** All run records, newest first. */
  list(): RunRecord[] {
    return readAll().sort((a, b) => b.startedAt - a.startedAt);
  },

  /**
   * How many runs there have ever been — including the ones the cap pruned.
   *
   * `list().length` is not this number and never was: it counts what survived
   * the cap. Runs belonging to a DELETED test are still counted, on the same
   * reasoning the Stats view already applies to its cards — those runs really
   * happened, and rewriting the totals to pretend otherwise is what makes the
   * numbers stop being worth reading.
   */
  totals(): RunTotals {
    const pruned = readTally();
    let retained = 0;
    let passed = 0;
    let failed = 0;
    for (const rec of readAll()) {
      if (rec.kind === "baseline-update") continue;
      retained++;
      if (rec.status === "passed") passed++;
      else failed++;
    }
    return {
      runs: pruned.runs + retained,
      passed: pruned.passed + passed,
      failed: pruned.failed + failed,
      retained,
      pruned: pruned.runs,
      prunedDays: pruned.days,
    };
  },

  /**
   * Seed the pruned counter, ONCE, from evidence that outlived the records.
   *
   * The counter can only count prunes that happened while it existed, so on any
   * app that was already past the cap it starts life understating the history
   * by however many runs were pruned before it shipped — which is exactly the
   * "there are more than 1000 test runs" case it was built for. The metrics DB
   * is the only thing that still remembers those runs: it holds a row each and
   * nothing deletes them.
   *
   * @param lifetime Every run the metrics DB knows about, day buckets included.
   *   Counts, not records: this raises the FLOOR under the counter and cannot
   *   lower it, so a database that is smaller than the counter (one rebuilt from
   *   the capped index after a schema bump, say) changes nothing.
   *
   * Returns what it did, for the log — a silent one-time migration is one
   * nobody can tell ran.
   */
  adoptLifetimeFloor(lifetime: {
    runs: number;
    passed: number;
    failed: number;
    days: { dayStart: number; runs: number; passed: number; failed: number }[];
  }): { adopted: boolean; pruned: number } {
    const tally = readTally();
    if (tally.adopted) return { adopted: false, pruned: tally.runs };

    // What the DB knows MINUS what the index still holds is what was pruned.
    // Per day as well as overall, because the digest and the chart count
    // windows and a flat total cannot say when.
    const retainedByDay = new Map<number, { runs: number; passed: number; failed: number }>();
    let retained = 0;
    let retainedPassed = 0;
    for (const rec of readAll()) {
      if (rec.kind === "baseline-update") continue;
      retained++;
      if (rec.status === "passed") retainedPassed++;
      const key = dayStartOf(rec.startedAt);
      const bucket = retainedByDay.get(key) ?? { runs: 0, passed: 0, failed: 0 };
      bucket.runs++;
      if (rec.status === "passed") bucket.passed++;
      else bucket.failed++;
      retainedByDay.set(key, bucket);
    }

    const prunedRuns = Math.max(0, lifetime.runs - retained);
    if (prunedRuns <= tally.runs) {
      // Nothing to recover — but the attempt is still spent, so a database
      // that never had the history cannot make this run on every launch.
      writeTally({ ...tally, adopted: true });
      return { adopted: false, pruned: tally.runs };
    }

    const prunedPassed = Math.max(0, lifetime.passed - retainedPassed);
    const days: PrunedDay[] = [];
    for (const day of lifetime.days) {
      const held = retainedByDay.get(day.dayStart);
      const runs = Math.max(0, day.runs - (held?.runs ?? 0));
      if (runs === 0) continue;
      const passed = Math.min(runs, Math.max(0, day.passed - (held?.passed ?? 0)));
      days.push({ dayStart: day.dayStart, runs, passed, failed: runs - passed });
    }

    writeTally({
      runs: prunedRuns,
      // Forced to add up rather than each derived on its own: the two counts
      // are subtractions from different sources, and `readTally` rejects a file
      // whose parts disagree — which would throw away the recovery it just did.
      passed: Math.min(prunedRuns, prunedPassed),
      failed: prunedRuns - Math.min(prunedRuns, prunedPassed),
      days: days.slice(-PRUNED_DAYS_KEPT),
      adopted: true,
    });
    logger.info("recorder", "Recovered pruned-run history from the metrics database", {
      pruned: prunedRuns,
      days: days.length,
    });
    return { adopted: true, pruned: prunedRuns };
  },

  /** Runs whose test still exists — everything the UI may NAME. Every caller
   *  that renders or filters by test name wants this; the aggregate counters
   *  want `list()`. Keeping both spellings visible at the call site is the
   *  point: which one you meant should be readable from the line. */
  listLive(): RunRecord[] {
    return this.list().filter((r) => !r.testDeleted);
  },

  /**
   * Tombstone every run belonging to a deleted test, drop its denormalized
   * name, and delete its raw log.
   *
   * Marking rather than removing is what keeps the aggregate stats still across
   * a delete (see `RunRecord.testDeleted`). What actually GOES is everything
   * identifying: the log (page content, URLs, typed values — the one artifact
   * here that quotes the site) and `testName`, which is the only thing left in
   * this file a person would recognise. What stays is arithmetic.
   *
   * `logBytes` is deliberately left on the record so retention accounting still
   * reflects what this run once cost.
   */
  markTestDeleted(testId: string): { marked: number } {
    const all = readAll();
    let marked = 0;
    for (const rec of all) {
      if (rec.testId !== testId || rec.testDeleted) continue;
      rec.testDeleted = true;
      rec.testName = DELETED_TEST_NAME;
      safeUnlink(rec.logFile);
      rec.logFile = "";
      marked++;
    }
    if (marked > 0) writeAll(all);
    logger.info("recorder", "Tombstoned runs for a deleted test", { testId, marked });
    return { marked };
  },

  /** Record a completed run: write its raw output to a .log file and append the
   *  metadata to the index. Returns the persisted record. */
  append(
    run: {
      /** Pre-minted run id. Pass this when the id was needed at run START (e.g.
       *  to name the artifacts directory) so logs and artifacts share one id.
       *  Falls back to a fresh uuid. */
      id?: string;
      testId: string;
      testName: string;
      url: string;
      status: "passed" | "failed";
      exitCode: number;
      startedAt: number;
      finishedAt: number;
      captureArtifacts?: boolean;
      runHeadless?: boolean;
      /** browser engine the run used */
      runBrowser?: RunBrowser;
      /** playback speed the run used */
      speed?: TestSpeed;
      /** batch that drove this run, when part of one */
      batchId?: string;
      /** dataset row this run used, when it was one row of a sweep */
      datasetId?: string;
      datasetName?: string;
      /** steps run-time Auto-Heal got past by substituting a locator */
      healedSteps?: number;
      /** steps Auto-Heal tried to rescue and could not — the opposite evidence,
       *  and the more informative half: the element is gone, not renamed */
      healFailedSteps?: number;
      /** a failed run salvaged its Playwright trace into the artifact dir */
      hasTrace?: boolean;
      /** tabs the page opened and the run followed, off the tabs fixture's
       *  markers. Declared here because the runner spreads it in, and a field
       *  this type does not name is dropped without a compile error — the same
       *  hole the three fields below fell through. */
      tabsOpened?: number;
      /** highest attempt Playwright made, when the run retried — spread in via
       *  `retryFields` (shared/run-attempts.mjs), so a single-attempt run
       *  carries neither retry key */
      attempt?: number;
      /** the run failed and then passed on a retry */
      passedOnRetry?: boolean;
      /** the per-test Playwright timeout THIS run executed under. Stored per
       *  run because the TestRecord's value is the CURRENT one, and a timeout
       *  raised since would silently make every older run's step-vs-budget
       *  comparison wrong while still looking plausible. */
      testTimeoutMs?: number;
      /** accessibility-check cost, and steps with unaccepted violations */
      a11yMs?: number;
      a11yChecks?: number;
      a11yNewSteps?: number;
      /** Site Health summary, when the run measured (see RunRecord) */
      siteHealth?: SiteHealthSummary;
      /** AI visual checks, evaluated post-run by the configured model */
      aiChecksPassed?: number;
      aiChecksFailed?: number;
      aiChecksUnevaluated?: number;
      /** measured screenshot cost for capture runs (see capture-overhead.ts) */
      captureOverheadMs?: number;
      shotCount?: number;
      /** id of the run this one re-executed, when it's a re-run */
      replayOfRunId?: string;
      /** label of the step the run failed at, when a replay was written */
      failedStepLabel?: string;
      /** what the run EXECUTED, as `<scheme>:<hex>` — see shared/steps-digest.mjs.
       *  Declared here for the reason `tabsOpened` above is: the runner spreads
       *  it in, and a field this type does not name is dropped silently. */
      stepsDigest?: string;
      /** how the run ended, when it did not end on its own */
      endedBy?: "user" | "process-timeout";
      /** who started the run — narrowed here, not trusted */
      trigger?: RunTrigger;
      /** where the run came from — narrowed here, not trusted */
      provenance?: RunProvenance;
    },
    logText: string,
  ): RunRecord {
    ensureDirs();
    const id = run.id ?? randomUUID();
    const logFile = path.join(logsDir(), id + ".log");
    // Narrowed once, and the NARROWED value is what gets stored. See the note
    // at its place in the record below.
    const provenance = normalizeRunProvenance(run.provenance);
    // Redact on WRITE, not on read. A secret never reaches the generated spec,
    // but it does reach the browser — so it can come back in a Playwright error
    // message or an assertion diff. Redacting on read would leave the plaintext
    // sitting in a file on disk that Reveal in Finder happily opens.
    fs.writeFileSync(logFile, redactWithSnapshot(logText), "utf-8");

    const record: RunRecord = {
      id,
      testId: run.testId,
      testName: run.testName,
      url: run.url,
      status: run.status,
      exitCode: run.exitCode,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: Math.max(0, run.finishedAt - run.startedAt),
      logFile,
      logBytes: logByteSize(logFile),
      captureArtifacts: run.captureArtifacts ?? false,
      runHeadless: run.runHeadless ?? false,
      // Runs predating the browser picker all ran on chromium.
      runBrowser: run.runBrowser ?? "chromium",
      // Left undefined when unknown rather than defaulted, unlike runBrowser
      // above: every pre-picker run really did use chromium, but a run recorded
      // before this field could have been at any speed. Writing "fast" there
      // would be inventing evidence for the one comparison the field exists to
      // support.
      ...(run.speed !== undefined ? { speed: run.speed } : {}),
      // Left undefined for ordinary single runs rather than written as null.
      ...(run.batchId !== undefined ? { batchId: run.batchId } : {}),
      // Left undefined (not 0) for non-capture runs so the summarizer can tell
      // "no capture" apart from "capture that took no measurable time".
      ...(run.captureOverheadMs !== undefined ? { captureOverheadMs: run.captureOverheadMs } : {}),
      ...(run.shotCount !== undefined ? { shotCount: run.shotCount } : {}),
      ...(run.replayOfRunId ? { replayOfRunId: run.replayOfRunId } : {}),
      ...(run.healedSteps ? { healedSteps: run.healedSteps } : {}),
      ...(run.healFailedSteps ? { healFailedSteps: run.healFailedSteps } : {}),
      // These three were passed by the runner and silently dropped here: the
      // parameter type never declared them, and an object spread at the call
      // site defeats excess-property checking, so it compiled clean while the
      // Open Trace button gated on a field that was never written and
      // `flakeSignal` never saw a retried pass. Absent stays absent — writing
      // `attempt: 0` on every row would be indistinguishable from a row
      // predating the field (see `retryFields` in shared/run-attempts.mjs).
      ...(run.hasTrace === true ? { hasTrace: true } : {}),
      ...(Number.isInteger(run.tabsOpened) && (run.tabsOpened as number) > 0
        ? { tabsOpened: run.tabsOpened }
        : {}),
      ...(Number.isInteger(run.attempt) && (run.attempt as number) > 0
        ? { attempt: run.attempt }
        : {}),
      ...(run.passedOnRetry === true ? { passedOnRetry: true } : {}),
      // Written whenever it is known, including on a passing run: "this step
      // took 58s of its 60s budget" is a finding on a pass, not only on a fail.
      ...(run.testTimeoutMs ? { testTimeoutMs: run.testTimeoutMs } : {}),
      // Left undefined (not 0) for runs that didn't check, so "no a11y check"
      // is distinguishable from "checked and found nothing".
      ...(run.a11yMs !== undefined ? { a11yMs: run.a11yMs } : {}),
      ...(run.a11yChecks !== undefined ? { a11yChecks: run.a11yChecks } : {}),
      ...(run.a11yNewSteps ? { a11yNewSteps: run.a11yNewSteps } : {}),
      // Absent when the run did not measure. A summary with zero pages is
      // still written: "measured and read nothing" is a finding about the
      // probe, and the Output line says so.
      ...(run.siteHealth ? { siteHealth: run.siteHealth } : {}),
      ...(run.aiChecksPassed ? { aiChecksPassed: run.aiChecksPassed } : {}),
      ...(run.aiChecksFailed ? { aiChecksFailed: run.aiChecksFailed } : {}),
      ...(run.aiChecksUnevaluated ? { aiChecksUnevaluated: run.aiChecksUnevaluated } : {}),
      ...(run.datasetId ? { datasetId: run.datasetId } : {}),
      ...(run.datasetName ? { datasetName: run.datasetName } : {}),
      // Absent when unknown rather than empty. Only a run that wrote a replay
      // has a per-step outcome to read, so "" here would claim the run failed
      // at a step with no name — which reads as a bug in the label rather than
      // as the absence of one.
      ...(run.failedStepLabel ? { failedStepLabel: run.failedStepLabel } : {}),
      // What the run executed. GUARDED rather than copied, the same way
      // `trigger` below is: the value is a token two other processes also
      // write, and a malformed one stored here would be compared against a
      // good one forever. Absent stays absent — a digest of nothing would
      // claim every pre-field run executed the same thing.
      ...(isRunDigest(run.stepsDigest) ? { stepsDigest: run.stepsDigest } : {}),
      // Absent is the ordinary case — a run that ended by itself. Writing a
      // value there would claim every historical run had been examined.
      ...(run.endedBy ? { endedBy: run.endedBy } : {}),
      // NARROWED, not copied. This store's file is also written by the
      // standalone MCP server, and will be by the CLI — processes that ship on
      // their own schedules — so an unrecognised trigger is honestly unknown
      // rather than a string to carry into every surface that renders one.
      // Absent stays absent: a run predating the field could have been started
      // by any of the three, so defaulting to "manual" would invent evidence.
      ...(normalizeRunTrigger(run.trigger) ? { trigger: run.trigger } : {}),
      // NARROWED, and the narrowed value is what is STORED — unlike the trigger
      // above, which is a closed vocabulary that can only be accepted or
      // dropped whole. Provenance is free text from an environment this process
      // does not control: a pull request's source branch is named by whoever
      // opened it, and on a fork that is anyone. The gate drops a field that is
      // over-long, carries a control character, or is a URL with a scheme this
      // application will not follow, and it drops them INDEPENDENTLY so a
      // hostile branch name does not cost the run its revision.
      //
      // `run.provenance` is deliberately not spread through: writing the
      // caller's object would make this guard advisory.
      ...(provenance ? { provenance } : {}),
    };

    const all = readAll();
    all.push(record);
    // Prune oldest beyond the cap, removing their log files too — and counting
    // them into the lifetime tally on the way out.
    all.sort((a, b) => a.startedAt - b.startedAt);
    pruneToCap(all);
    pruneLogsToBudget(all);
    writeAll(all);
    logger.info("recorder", "Saved run record", {
      id,
      testId: run.testId,
      status: run.status,
    });
    return record;
  },

  /** Log a baseline-update event (when the user accepts screenshots as new
   *  baselines). These are shown in the Stats history table but excluded from
   *  the pass/fail charts. `stepCount` is the number of steps re-pinned
   *  (1 for per-step, N for per-run). */
  logBaselineUpdate(
    testId: string,
    testName: string,
    stepCount: number,
    scope: "step" | "run",
  ): RunRecord {
    ensureDirs();
    const id = randomUUID();
    const now = Date.now();
    const note =
      scope === "run"
        ? `Accepted ${stepCount} screenshot${stepCount === 1 ? "" : "s"} as new baselines`
        : `Accepted 1 screenshot as new baseline`;
    const record: RunRecord = {
      id,
      testId,
      testName,
      url: "",
      status: "passed",
      exitCode: 0,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      logFile: "",
      logBytes: 0,
      kind: "baseline-update",
      note,
    };
    const all = readAll();
    all.push(record);
    all.sort((a, b) => a.startedAt - b.startedAt);
    pruneToCap(all);
    pruneLogsToBudget(all);
    writeAll(all);
    logger.info("recorder", "Logged baseline update", { id, testId, scope, stepCount });
    return record;
  },

  /**
   * Label WHY a failed run failed, or clear the label.
   *
   * Returns the record (updated or not), or null when the run cannot carry a
   * reason at all — unknown id, a baseline-update event, or a run that passed.
   * Reasons are failure metadata by definition; labelling a pass would invent
   * a failure that did not happen.
   *
   * MANUAL WINS, in both directions of time. An automatic assignment refuses
   * to touch a record that already carries ANY reason: the auto path runs once
   * at run end, so an existing value is either a user's answer (which must
   * never be overwritten) or an earlier auto answer (which had the same
   * evidence). A user assignment overwrites anything, and `reasonId: null`
   * from a user clears the label — "uncategorized" is a state the picker
   * offers, not an error.
   *
   * The reason id's EXISTENCE is the caller's problem (the handler validates
   * against the vocabulary; the auto path maps only onto built-ins). This
   * store deliberately does not import the definitions — a run store that
   * refuses to read history because a definitions file went missing would be
   * backwards.
   */
  setFailureReason(
    runId: string,
    reasonId: string | null,
    by: "user" | "auto",
    signal?: string,
  ): RunRecord | null {
    const all = readAll();
    const rec = all.find((r) => r.id === runId);
    if (!rec || rec.kind === "baseline-update" || rec.status !== "failed") return null;
    if (by === "auto" && (rec.failureReasonId || rec.failureReasonBy)) return rec;
    if (by === "auto" && !reasonId) return rec; // auto never clears
    if (reasonId) {
      rec.failureReasonId = reasonId;
      rec.failureReasonBy = by;
      if (by === "auto" && signal) rec.failureReasonSignal = signal;
      else delete rec.failureReasonSignal;
    } else {
      delete rec.failureReasonId;
      delete rec.failureReasonBy;
      delete rec.failureReasonSignal;
    }
    writeAll(all);
    logger.info("recorder", "Set run failure reason", { runId, reasonId, by });
    return rec;
  },

  /** Read the raw console output for a run. */
  readLog(id: string): string {
    const rec = readAll().find((r) => r.id === id);
    if (!rec) throw new Error("Run not found: " + id);
    try {
      return fs.readFileSync(rec.logFile, "utf-8");
    } catch {
      return "(The raw log for this run is no longer available.)";
    }
  },

  /** Case-insensitive search across the raw run logs. Returns the matching runs
   *  (newest first) with a match count and an excerpt around the first hit. */
  searchLogs(query: string): LogSearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: LogSearchResult[] = [];
    // listLive: a deleted test's logs are unlinked, so these would be skipped
    // anyway — but only by accident. Searching by name is exactly the surface a
    // deleted test must vanish from, and relying on the unlink means the day a
    // log survives, the test's name comes back with page content attached.
    for (const rec of this.listLive()) {
      let text: string;
      try {
        text = fs.readFileSync(rec.logFile, "utf-8");
      } catch {
        continue; // log deleted / missing — skip
      }
      const hay = text.toLowerCase();
      const first = hay.indexOf(q);
      if (first < 0) continue;

      let matchCount = 0;
      let idx = first;
      while (idx >= 0) {
        matchCount++;
        idx = hay.indexOf(q, idx + q.length);
      }

      const start = Math.max(0, first - SNIPPET_RADIUS);
      const end = Math.min(text.length, first + q.length + SNIPPET_RADIUS);
      let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
      if (start > 0) snippet = "…" + snippet;
      if (end < text.length) snippet = snippet + "…";

      results.push({
        runId: rec.id,
        testName: rec.testName,
        status: rec.status,
        startedAt: rec.startedAt,
        matchCount,
        snippet,
      });
      if (results.length >= SEARCH_RESULT_CAP) break;
    }
    return results;
  },

  /** Clear the run history index (charts/table) but KEEP the raw .log files on
   *  disk. Returns how many records were removed.
   *
   *  Zeroes the pruned tally too: this is the user asking to forget the
   *  history, and a "Total runs" card that still counted 1240 runs after a
   *  reset that emptied every list on the screen would be the same complaint
   *  the tally was added to answer, pointing the other way. */
  resetStats(): { removed: number } {
    const removed = readAll().length;
    writeTally({ runs: 0, passed: 0, failed: 0, days: [], adopted: true });
    writeAll([]);
    logger.info("recorder", "Reset run stats (kept logs)", { removed });
    return { removed };
  },

  /** Delete the run history index AND every raw .log file. */
  deleteAll(): { removed: number } {
    const all = readAll();
    for (const rec of all) safeUnlink(rec.logFile);
    // Also sweep any orphaned .log files (e.g. left by a prior resetStats).
    try {
      for (const name of fs.readdirSync(logsDir())) {
        if (name.endsWith(".log")) safeUnlink(path.join(logsDir(), name));
      }
    } catch {
      /* logs dir may not exist yet */
    }
    writeTally({ runs: 0, passed: 0, failed: 0, days: [], adopted: true });
    writeAll([]);
    logger.info("recorder", "Deleted all run stats and logs", { removed: all.length });
    return { removed: all.length };
  },

  /** Delete records (and their raw logs) whose run started within [fromMs, toMs]
   *  inclusive.
   *
   *  Leaves the pruned tally alone, and it is not an oversight: everything the
   *  tally counts was pruned for being older than every record still in the
   *  index, so a range that reaches those runs has nothing left to delete.
   *  Subtracting anything here would double-count the removal. */
  deleteRange(fromMs: number, toMs: number): { removed: number } {
    const all = readAll();
    const keep: RunRecord[] = [];
    let removed = 0;
    for (const rec of all) {
      if (rec.startedAt >= fromMs && rec.startedAt <= toMs) {
        safeUnlink(rec.logFile);
        removed++;
      } else {
        keep.push(rec);
      }
    }
    writeAll(keep);
    logger.info("recorder", "Deleted run stats/logs in range", { removed, fromMs, toMs });
    return { removed };
  },

  /** Absolute path to the logs folder (for "Reveal in Finder"). */
  logsDirPath(): string {
    ensureDirs();
    return logsDir();
  },
};
