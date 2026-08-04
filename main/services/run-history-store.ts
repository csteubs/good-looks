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

import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import type { LogSearchResult, RunRecord } from "../recorder/types.js";

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

export const runHistoryStore = {
  /** All run records, newest first. */
  list(): RunRecord[] {
    return readAll().sort((a, b) => b.startedAt - a.startedAt);
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
    },
    logText: string,
  ): RunRecord {
    ensureDirs();
    const id = run.id ?? randomUUID();
    const logFile = path.join(logsDir(), id + ".log");
    fs.writeFileSync(logFile, logText, "utf-8");

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
    };

    const all = readAll();
    all.push(record);
    // Prune oldest beyond the cap, removing their log files too.
    all.sort((a, b) => a.startedAt - b.startedAt);
    while (all.length > MAX_RECORDS) {
      const dropped = all.shift();
      if (dropped) safeUnlink(dropped.logFile);
    }
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
    while (all.length > MAX_RECORDS) {
      const dropped = all.shift();
      if (dropped) safeUnlink(dropped.logFile);
    }
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
    for (const rec of this.list()) {
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
   *  disk. Returns how many records were removed. */
  resetStats(): { removed: number } {
    const removed = readAll().length;
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
    writeAll([]);
    logger.info("recorder", "Deleted all run stats and logs", { removed: all.length });
    return { removed: all.length };
  },

  /** Delete records (and their raw logs) whose run started within [fromMs, toMs]
   *  inclusive. */
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
