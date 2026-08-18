// What the AI Debug feature has actually done, kept for counting.
//
// THE SECOND STORE, AND WHY THERE ARE TWO. `ai-debug-store.ts` holds the
// ANSWERS: the model's text, which quotes the script and excerpts of run
// output. That store keeps twenty and hard-deletes with its test, and both
// rules are right for content — the material is sensitive, and with the test
// gone nothing can reach it. `docs/DECISIONS.md` justified the hard delete
// partly on the grounds that a session "contributes to no aggregate anybody
// looks at". The Stats board's AI Debug category is what changed that, so this
// file exists to carry the aggregate WITHOUT carrying the content.
//
// A record here is facts about one attempt and nothing else: ids, timings,
// status, model, provider, sizes. No answer, no reasoning, no error text, no
// script. That is the property the whole design rests on — it is why these rows
// can outlive the twenty-session cap, and why a deleted test can TOMBSTONE its
// rows (as run history does) rather than erase them. Deleting the numbers with
// the test would mean a total that silently walks backwards, which is the one
// thing an aggregate must never do.
//
// THE CAP IS BY COUNT AND THE FILE IS REWRITTEN WHOLE, like every other index
// in this directory. Records are ~300 bytes, so the cap is high enough that a
// heavy user reaches it after thousands of sessions rather than dozens — but it
// exists, because an unbounded file that is rewritten on every session start
// eventually makes starting a session slow.
//
// EVERY METHOD SWALLOWS ITS OWN FAILURE. Recording history must never take down
// the diagnosis it is recording: a failed write here costs a row in a chart, and
// a throw would cost the user the answer they were waiting for.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import {
  AI_DEBUG_HISTORY_VERSION,
  normalizeAiDebugHistoryRecord,
  type AiDebugHistoryFile,
  type AiDebugHistoryRecord,
  type AiDebugSession,
} from "../recorder/types.js";

/** Newest N attempts. Two thousand slim records is well under a megabyte, and
 *  the file is only rewritten when an attempt starts or ends — twice a session,
 *  not once per streamed token. */
const MAX_RECORDS = 2000;

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "ai-debug-history.json");
}

/** A corrupt or unrecognized file reads as EMPTY. Same rule as the session
 *  store: losing history is a chart with less in it, while throwing on read
 *  would take down the Stats board and the panel that writes to it. */
function readAll(): AiDebugHistoryRecord[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const file = parsed as Partial<AiDebugHistoryFile>;
    if (file.version !== AI_DEBUG_HISTORY_VERSION) return [];
    if (!Array.isArray(file.records)) return [];
    // Normalized ON THE WAY OUT as well as in. This file sits in userData
    // beside everything else the user can hand-edit, and a row that arrives
    // with a string where a duration belongs would otherwise reach the
    // arithmetic that renders the board.
    const out: AiDebugHistoryRecord[] = [];
    for (const row of file.records) {
      const rec = normalizeAiDebugHistoryRecord(row);
      if (rec) out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(records: AiDebugHistoryRecord[]): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const file: AiDebugHistoryFile = { version: AI_DEBUG_HISTORY_VERSION, records };
    // tmp + rename, so a crash mid-write cannot leave a truncated file that
    // then reads as empty and takes the whole history with it.
    const tmp = `${indexFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
    fs.renameSync(tmp, indexFile());
  } catch (err) {
    logger.warn("ai-debug", "Failed to write AI debug history", { err: String(err) });
  }
}

function newestFirst(records: AiDebugHistoryRecord[]): AiDebugHistoryRecord[] {
  return [...records].sort((a, b) => b.startedAt - a.startedAt);
}

export const aiDebugHistoryStore = {
  /** Every retained attempt, newest first. */
  list(): AiDebugHistoryRecord[] {
    return newestFirst(readAll());
  },

  /**
   * Insert or replace one attempt by id.
   *
   * Called TWICE per attempt — once when it is sent, once when it settles —
   * rather than on every streamed chunk. The open row is what makes an attempt
   * that never settles (crash, kill) visible at all; without it a session the
   * app died during would leave no trace, and "time spent in AI debug" would
   * quietly exclude the worst waits.
   */
  record(input: unknown): AiDebugHistoryRecord | null {
    const rec = normalizeAiDebugHistoryRecord(input);
    if (!rec) return null;
    const rest = readAll().filter((r) => r.id !== rec.id);
    writeAll(newestFirst([...rest, rec]).slice(0, MAX_RECORDS));
    return rec;
  },

  /**
   * Rewrite attempts left mid-flight by a previous process.
   *
   * The backend's in-flight request map dies with the process, so a row
   * persisted as `streaming` describes a request that no longer exists — and
   * one with no `endedAt` would otherwise be counted as either live or
   * zero-length by everything downstream. Stamped with the LAST TIME ANYTHING
   * WAS KNOWN, not with now: the app may have been closed for a week, and
   * charging that week to a session's duration would make the "time spent"
   * figure absurd. Idempotent.
   */
  reconcileInterrupted(): { reconciled: number } {
    const all = readAll();
    let reconciled = 0;
    const fixed = all.map((r) => {
      if (r.status !== "streaming") return r;
      reconciled++;
      return {
        ...r,
        status: "interrupted" as const,
        // A first token is the last moment we can prove the request was alive.
        // With none, the attempt is recorded as having taken no measurable time
        // rather than as having taken until whenever the app next started.
        endedAt: r.firstTokenMs !== null ? r.startedAt + r.firstTokenMs : r.startedAt,
      };
    });
    if (reconciled > 0) writeAll(fixed);
    return { reconciled };
  },

  /**
   * Seed the history from the sessions already on disk.
   *
   * One-time, and it runs only while the history is EMPTY: the sessions that
   * survive in the other store are real attempts that really happened, and a
   * board that opened at zero for an existing user would be a wrong answer
   * dressed as a new feature. Re-running it later would double-count, which is
   * why the emptiness check is the condition rather than a flag file.
   *
   * What it cannot recover is stamped honestly rather than guessed: `provider`
   * is null (unknown, and never reported as local or hosted), `promptChars` is
   * 0, and `firstTokenMs` is null.
   */
  backfillFrom(sessions: AiDebugSession[]): { added: number } {
    if (readAll().length > 0) return { added: 0 };
    const seeded: AiDebugHistoryRecord[] = [];
    for (const s of sessions) {
      const rec = normalizeAiDebugHistoryRecord({
        id: `${s.key}@${s.startedAt}`,
        key: s.key,
        kind: s.kind,
        testId: s.testId,
        testName: s.testName,
        trigger: "manual",
        provider: null,
        model: s.model ?? null,
        // A session restored as streaming is one the app died during; the
        // session store's own reconciliation says the same thing.
        status: s.status === "streaming" ? "interrupted" : s.status,
        errorKind: s.errorKind ?? null,
        startedAt: s.startedAt,
        endedAt: s.updatedAt,
        firstTokenMs: null,
        promptChars: 0,
        answerChars: (s.content ?? "").length,
        runKey: s.runKey ?? null,
      });
      if (rec) seeded.push(rec);
    }
    if (seeded.length === 0) return { added: 0 };
    writeAll(newestFirst(seeded).slice(0, MAX_RECORDS));
    return { added: seeded.length };
  },

  /**
   * Mark a deleted test's rows, keeping them.
   *
   * THE OPPOSITE OF `aiDebugStore.deleteTest`, deliberately. That store holds
   * the model's answer quoting a test that no longer exists, so it deletes;
   * this one holds "a diagnosis happened, it took 40 seconds, it was applied",
   * which stays true afterwards. Erasing it would make every lifetime total on
   * the Stats board walk backwards when a test is deleted — the same reason run
   * records are tombstoned rather than removed.
   */
  markTestDeleted(testId: string): { marked: number } {
    const all = readAll();
    let marked = 0;
    const next = all.map((r) => {
      if (r.testId !== testId || r.testDeleted) return r;
      marked++;
      return { ...r, testDeleted: true };
    });
    if (marked > 0) writeAll(next);
    return { marked };
  },

  clear(): { removed: number } {
    const all = readAll();
    if (all.length > 0) writeAll([]);
    return { removed: all.length };
  },
};
