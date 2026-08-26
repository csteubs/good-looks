// Appending a run to the app's run history, from the standalone server.
//
// ── Why this is not inside server.mjs ──────────────────────────────────────
// Same reason `run-plan.mjs` is not: importing `server.mjs` starts an MCP
// server on stdio, so anything defined there can only be tested by reading its
// source. That is precisely how the bug below survived — every check that
// touches this area reads source or imports pure modules, and none of them can
// append a run and look at what happened to the file.
//
// ── The bug ────────────────────────────────────────────────────────────────
// This function and `runHistoryStore.append` write the same
// `recorder/run-history.json`, and they had drifted. PR #158 raised the app's
// cap from 1000 to 50000 and built the pruned tally underneath it — across 37
// files, none of them under `mcp/`. So this side kept the pre-#158 policy: cap
// 1000, no tally.
//
// One MCP run against a store the app had grown past a thousand records
// therefore truncated it to a thousand, deleted the dropped runs' log files,
// and — because the tally was never written — removed those runs from the
// lifetime totals permanently. Nothing throws; the Stats board simply reports a
// smaller history than the machine actually has, which is the exact bug #158
// existed to end.
//
// Both the cap and the fold now come from `shared/run-history-rules.mjs`, so
// the two writers cannot drift again by editing one of them.

import fs from "node:fs";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "./data-dir.mjs";
import { RUN_HISTORY_CAP, foldPrunedRun, readPrunedTally } from "../shared/run-history-rules.mjs";

export const RUN_HISTORY_FILE = "recorder/run-history.json";

/** Where the app keeps the record of what the cap has discarded. Both processes
 *  must maintain it, or whichever prunes without it silently shrinks the
 *  lifetime totals on the Stats board. */
export const PRUNED_TALLY_FILE = "recorder/run-history-pruned.json";

/**
 * Every run record on disk, oldest-first ordering NOT guaranteed.
 *
 * @param {string} dataDir
 */
export function listRuns(dataDir) {
  return readJsonFile(dataDir, RUN_HISTORY_FILE, []);
}

/**
 * Append a run, and prune EXACTLY AS THE APP DOES.
 *
 * `dataDir` is a parameter rather than a module-level constant so this can be
 * driven against a fixture tree — the whole point of the file existing.
 *
 * The tally write is best-effort for the same reason it is on the app's side:
 * a bookkeeping failure must not lose the run record that has just been made.
 * Under-counting the lifetime total is the cheaper failure by some distance.
 *
 * @param {string} dataDir
 * @param {{logFile: string, startedAt: number, status: string, kind?: string}} record
 * @param {string} logText
 */
export function saveRunRecord(dataDir, record, logText) {
  saveRunRecords(dataDir, [{ record, logText }]);
}

/**
 * Append MANY runs in one pass — `ingest`'s writer (R12).
 *
 * Not an optimisation for its own sake, and not a second prune implementation:
 * `saveRunRecord` above is now one call into this, so the cap, the tally and the
 * ordering still have exactly one spelling on this side of the boundary.
 *
 * What the batch buys is that the store is read, sorted and written ONCE. The
 * per-record loop it replaces is O(n) full rewrites of a file whose cap is
 * fifty thousand records — ingesting a week of CI would have re-serialised
 * tens of megabytes per run, which is slow enough to read as a hang on the one
 * command whose whole job is to move a lot of rows at once.
 *
 * Every log is written BEFORE the index, in both paths. The order matters after
 * a crash: an index naming a log that is not there degrades to "the raw log for
 * this run is no longer available", while a log with no index entry is an
 * orphaned file nothing looks at. The first is a worse thing to leave behind.
 *
 * @param {string} dataDir
 * @param {{record: {logFile: string, startedAt: number, status: string, kind?: string}, logText: string}[]} entries
 */
export function saveRunRecords(dataDir, entries) {
  if (entries.length === 0) return;

  for (const { record, logText } of entries) {
    fs.mkdirSync(path.dirname(record.logFile), { recursive: true });
    fs.writeFileSync(record.logFile, logText, "utf-8");
  }

  const runs = listRuns(dataDir);
  for (const { record } of entries) runs.push(record);
  runs.sort((a, b) => a.startedAt - b.startedAt);

  if (runs.length > RUN_HISTORY_CAP) {
    const tally = readPrunedTally(readJsonFile(dataDir, PRUNED_TALLY_FILE, null));
    let dropped = 0;
    while (runs.length > RUN_HISTORY_CAP) {
      const gone = runs.shift();
      if (!gone) break;
      try {
        fs.rmSync(gone.logFile, { force: true });
      } catch {
        // A log that is already gone is not a reason to fail the run.
      }
      // Answers whether the record COUNTED — a baseline update is an event, not
      // a run — so the tally file is rewritten only when something it describes
      // actually changed.
      if (foldPrunedRun(tally, gone)) dropped++;
    }
    if (dropped > 0) {
      try {
        writeJsonFile(dataDir, PRUNED_TALLY_FILE, tally);
      } catch {
        // Best-effort, as above.
      }
    }
  }

  writeJsonFile(dataDir, RUN_HISTORY_FILE, runs);
}
