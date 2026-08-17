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

import { redactWithSnapshot } from "./secret-redaction.js";
import { DELETED_TEST_NAME } from "../recorder/types.js";
import type {
  LogSearchResult,
  RunBrowser,
  RunRecord,
  RunTotals,
  TestSpeed,
} from "../recorder/types.js";

const MAX_RECORDS = 1000; // cap the index; oldest runs (+ their logs) are pruned
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

/** Executions the cap has pruned out of the index, by outcome. */
interface PrunedTally {
  runs: number;
  passed: number;
  failed: number;
}

/** A count read back off disk: a non-negative whole number, or nothing. */
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
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
  const zero = { runs: 0, passed: 0, failed: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(prunedTallyFile(), "utf-8")) as Partial<PrunedTally>;
    const runs = count(parsed.runs);
    const passed = count(parsed.passed);
    const failed = count(parsed.failed);
    if (runs === null || passed === null || failed === null) return zero;
    if (passed + failed !== runs) return zero;
    return { runs, passed, failed };
  } catch {
    // Absent (nothing has been pruned yet) or unreadable. Same answer.
    return zero;
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
    };
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
      ...(run.datasetId ? { datasetId: run.datasetId } : {}),
      ...(run.datasetName ? { datasetName: run.datasetName } : {}),
    };

    const all = readAll();
    all.push(record);
    // Prune oldest beyond the cap, removing their log files too — and counting
    // them into the lifetime tally on the way out.
    all.sort((a, b) => a.startedAt - b.startedAt);
    pruneToCap(all);
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
    writeAll(all);
    logger.info("recorder", "Logged baseline update", { id, testId, scope, stepCount });
    return record;
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
    writeTally({ runs: 0, passed: 0, failed: 0 });
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
    writeTally({ runs: 0, passed: 0, failed: 0 });
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
