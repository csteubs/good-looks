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

import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import {
  DEFAULT_RUN_LOG_RETAINED_RUNS,
  recorderSettingsStore,
} from "./recorder-settings-store.js";
import { redactWithSnapshot } from "./secret-redaction.js";
import { DELETED_TEST_NAME } from "../recorder/types.js";
import type {
  LogSearchResult,
  RunBrowser,
  RunRecord,
  RunTotals,
  TestSpeed,
} from "../recorder/types.js";

/**
 * How many run RECORDS the index keeps.
 *
 * It was 1000, and that number was really a LOG budget wearing a record
 * budget's clothes: pruning deleted the record and its .log together, so the
 * cheap thing (a ~700-byte record) was made as scarce as the expensive one (its
 * console output, tens of KB). Everything counted off this list inherited the
 * ceiling — the Stats board read 1000 total runs, 1000 runs ago, and would have
 * read 1000 forever.
 *
 * The two are separate dials now. This one is bounded by what the file costs to
 * REWRITE, because `writeAll` rewrites it whole on every save (measured on this
 * machine, representative records): 1k ≈ 0.7 MB and 7 ms, 10k ≈ 7 MB and 55 ms,
 * 50k ≈ 35 MB and 360 ms, 100k ≈ 69 MB and 700 ms. At 50k that is a third of a
 * second of bookkeeping per run — chosen deliberately for depth of history, and
 * the reason `ingest` no longer re-reads the file to find the run it was just
 * handed.
 *
 * The log budget is `runLogRetainedRuns`, a user setting.
 */
const MAX_RECORDS = 50_000;
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
interface PrunedTally {
  runs: number;
  passed: number;
  failed: number;
  days: PrunedDay[];
  /** Whether the one-time seed from the metrics DB has run.
   *
   *  It has to be recorded, because the seed would otherwise repeat on every
   *  launch — and it must not: `resetStats` and `deleteAll` zero this tally, and
   *  a seed that ran again on the next launch would resurrect the history the
   *  user just asked the app to forget, out of a database that is not the store
   *  of record for it. Seed once, then the counter is authoritative. */
  adopted: boolean;
}

interface PrunedDay {
  /** local midnight of the day the runs started, epoch ms */
  dayStart: number;
  runs: number;
  passed: number;
  failed: number;
}

/** How many days of breakdown to keep. The digest reads fourteen (this week and
 *  the one before) and the chart seven; sixty is room for a view that wants a
 *  month without the file growing without limit. Older days are already in the
 *  flat totals, which is what the cards and the pass rate read. */
const PRUNED_DAYS_KEPT = 60;

/** Local midnight for a timestamp — the same bucketing `buildDailyBuckets` does
 *  in the renderer, kept as a NUMBER rather than a formatted key so the two
 *  cannot disagree about zero padding or separator. Both run on one machine in
 *  one timezone, which is what makes a local day the right bucket. */
function dayStartOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A count read back off disk: a non-negative whole number, or nothing. */
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** A TIMESTAMP read back off disk. Signed, unlike `count` — epoch ms before
 *  1970 are negative, and validating a day bucket with the counter's rule threw
 *  the whole breakdown away for a clock the app does not control. No real run
 *  starts in 1969; a machine whose clock says so is exactly the case where
 *  keeping the other days beats discarding them. */
function whole(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/**
 * The per-day breakdown, or nothing at all.
 *
 * Same all-or-none rule as the totals, one level down: a bucket that survived
 * validation while its neighbour did not would make the digest state a week
 * that never happened. Dropping the breakdown degrades the two windowed figures
 * to what they showed before it existed — an undercount that is at least a
 * count — while the lifetime totals beside them stay exact.
 */
function readDays(raw: unknown, total: number): PrunedDay[] {
  if (!Array.isArray(raw)) return [];
  const out: PrunedDay[] = [];
  let sum = 0;
  for (const entry of raw as Partial<PrunedDay>[]) {
    const dayStart = whole(entry?.dayStart);
    const runs = count(entry?.runs);
    const passed = count(entry?.passed);
    const failed = count(entry?.failed);
    if (dayStart === null || runs === null || passed === null || failed === null) return [];
    if (passed + failed !== runs) return [];
    out.push({ dayStart, runs, passed, failed });
    sum += runs;
  }
  // The days are a SUBSET of the total by construction (only the most recent
  // are kept). More days than runs is a file describing something that cannot
  // have happened.
  if (sum > total) return [];
  return out.sort((a, b) => a.dayStart - b.dayStart);
}

/**
 * The tally, or zeroes.
 *
 * ALL THREE FIELDS OR NONE, and the check that pinned this is the reason. The
 * first version sanitised each field on its own, so a file with a plausible
 * `failed` and a nonsense `runs` produced a total SMALLER than the outcome
 * counts sitting beside it on the same row — three numbers on one screen that
 * cannot all be true. A corrupt counter should understate the history, which is
 * self-correcting from the next prune onwards; it should never make the screen
 * incoherent. The same reasoning rejects a file whose parts don't add up.
 */
function readTally(): PrunedTally {
  const zero = { runs: 0, passed: 0, failed: 0, days: [], adopted: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(prunedTallyFile(), "utf-8")) as Partial<PrunedTally>;
    const runs = count(parsed.runs);
    const passed = count(parsed.passed);
    const failed = count(parsed.failed);
    if (runs === null || passed === null || failed === null) return zero;
    if (passed + failed !== runs) return zero;
    return {
      runs,
      passed,
      failed,
      days: readDays(parsed.days, runs),
      // Absent means "not yet" — an upgrade from before the seed existed.
      adopted: parsed.adopted === true,
    };
  } catch {
    // Absent (nothing has been pruned yet) or unreadable. Same answer.
    return zero;
  }
}

/** Add one pruned run to its day's bucket, keeping the most recent
 *  PRUNED_DAYS_KEPT days. Buckets stay sorted oldest-first. */
function tallyDay(days: PrunedDay[], startedAt: number, passed: boolean): PrunedDay[] {
  const dayStart = dayStartOf(startedAt);
  const bucket = days.find((d) => d.dayStart === dayStart);
  if (bucket) {
    bucket.runs++;
    if (passed) bucket.passed++;
    else bucket.failed++;
    return days;
  }
  const next = [...days, { dayStart, runs: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1 }];
  next.sort((a, b) => a.dayStart - b.dayStart);
  return next.slice(-PRUNED_DAYS_KEPT);
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
    if (rec.kind === "baseline-update") continue; // an event, not a run
    tally.runs++;
    if (rec.status === "passed") tally.passed++;
    else tally.failed++;
    tally.days = tallyDay(tally.days, rec.startedAt, rec.status === "passed");
    dropped++;
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
      /** the per-test Playwright timeout THIS run executed under. Stored per
       *  run because the TestRecord's value is the CURRENT one, and a timeout
       *  raised since would silently make every older run's step-vs-budget
       *  comparison wrong while still looking plausible. */
      testTimeoutMs?: number;
      /** accessibility-check cost, and steps with unaccepted violations */
      a11yMs?: number;
      a11yChecks?: number;
      a11yNewSteps?: number;
      /** AI visual checks, evaluated post-run by the configured model */
      aiChecksPassed?: number;
      aiChecksFailed?: number;
      aiChecksUnevaluated?: number;
      /** measured screenshot cost for capture runs (see capture-overhead.ts) */
      captureOverheadMs?: number;
      shotCount?: number;
      /** id of the run this one re-executed, when it's a re-run */
      replayOfRunId?: string;
    },
    logText: string,
  ): RunRecord {
    ensureDirs();
    const id = run.id ?? randomUUID();
    const logFile = path.join(logsDir(), id + ".log");
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
      // Written whenever it is known, including on a passing run: "this step
      // took 58s of its 60s budget" is a finding on a pass, not only on a fail.
      ...(run.testTimeoutMs ? { testTimeoutMs: run.testTimeoutMs } : {}),
      // Left undefined (not 0) for runs that didn't check, so "no a11y check"
      // is distinguishable from "checked and found nothing".
      ...(run.a11yMs !== undefined ? { a11yMs: run.a11yMs } : {}),
      ...(run.a11yChecks !== undefined ? { a11yChecks: run.a11yChecks } : {}),
      ...(run.a11yNewSteps ? { a11yNewSteps: run.a11yNewSteps } : {}),
      ...(run.aiChecksPassed ? { aiChecksPassed: run.aiChecksPassed } : {}),
      ...(run.aiChecksFailed ? { aiChecksFailed: run.aiChecksFailed } : {}),
      ...(run.aiChecksUnevaluated ? { aiChecksUnevaluated: run.aiChecksUnevaluated } : {}),
      ...(run.datasetId ? { datasetId: run.datasetId } : {}),
      ...(run.datasetName ? { datasetName: run.datasetName } : {}),
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
