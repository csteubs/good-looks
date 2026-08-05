// Persistence for batch (suite) runs.
//
// A batch's per-test results lived only in memory, so closing the app lost the
// summary — the individual runs survived in run-history.json, but nothing
// recorded that they belonged to one batch. This store is that record.
//
// Deliberately a separate index from run-history.json: a BatchRecord is a
// grouping over runs, and the two are pruned on different rules (a batch is
// small metadata; run logs are large and age out faster). The join back to
// individual runs is `RunRecord.batchId`.
//
// Writes are WRITE-THROUGH — the runner saves after every per-test transition,
// not just at the end — so a crash or force-quit mid-batch still leaves the
// results collected so far. The file is small (metadata only, capped), so a
// full rewrite per transition is cheap.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import type { BatchRecord } from "../recorder/types.js";

/** Cap the index. Batches are small (a few hundred bytes each), but this is a
 *  local app and the file is rewritten on every transition — unbounded growth
 *  would eventually make those writes noticeable. */
const MAX_RECORDS = 50;

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "batch-history.json");
}

function readAll(): BatchRecord[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BatchRecord[]) : [];
  } catch {
    return [];
  }
}

function writeAll(records: BatchRecord[]): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(indexFile(), JSON.stringify(records, null, 2), "utf-8");
  } catch (err) {
    // A failed history write must never take down the batch that's running —
    // the runs themselves are already persisted by run-history-store.
    logger.warn("batch", "Failed to write batch history", { err: String(err) });
  }
}

export const batchHistoryStore = {
  /** All batches, newest first. */
  list(): BatchRecord[] {
    return readAll().sort((a, b) => b.startedAt - a.startedAt);
  },

  get(batchId: string): BatchRecord | null {
    return readAll().find((b) => b.batchId === batchId) ?? null;
  },

  /** Insert or replace a batch by id, then prune to the newest MAX_RECORDS.
   *  Called repeatedly for the same batch as it progresses. */
  save(record: BatchRecord): BatchRecord {
    const all = readAll().filter((b) => b.batchId !== record.batchId);
    all.push(record);
    all.sort((a, b) => b.startedAt - a.startedAt);
    writeAll(all.slice(0, MAX_RECORDS));
    return record;
  },

  /** A record persisted with `running: true` means the app exited (crash, quit,
   *  force-quit) while that batch was in flight — nothing is running now, so the
   *  flag is stale. Rewrite those as stopped so the UI doesn't show a phantom
   *  in-progress batch forever. Called once at startup. */
  reconcileInterrupted(): { reconciled: number } {
    const all = readAll();
    let reconciled = 0;
    const fixed = all.map((b) => {
      if (!b.running) return b;
      reconciled++;
      return {
        ...b,
        running: false,
        stopped: true,
        finishedAt: b.finishedAt ?? b.startedAt,
        results: b.results.map((r) =>
          r.status === "running" || r.status === "pending"
            ? { ...r, status: "skipped" as const, note: "Interrupted — the app closed mid-batch" }
            : r,
        ),
      };
    });
    if (reconciled > 0) writeAll(fixed);
    return { reconciled };
  },

  remove(batchId: string): { removed: number } {
    const all = readAll();
    const kept = all.filter((b) => b.batchId !== batchId);
    if (kept.length !== all.length) writeAll(kept);
    return { removed: all.length - kept.length };
  },

  clear(): { removed: number } {
    const all = readAll();
    writeAll([]);
    return { removed: all.length };
  },
};
