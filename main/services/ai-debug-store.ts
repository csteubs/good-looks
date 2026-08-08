// Persistence for AI debug sessions ("Debug with AI" jobs).
//
// A minimized job is meant to be come back to — and "later" includes after a
// restart. What survives is the OUTPUT, not the job: llm-service's in-flight
// request map dies with the process, so a session persisted as "streaming"
// describes a request that no longer exists anywhere. reconcileInterrupted()
// rewrites those at startup, mirroring batch-history-store: the phantom
// in-progress batch bug already shipped once, and a permanently-orange AI icon
// would be the same bug wearing a different colour.
//
// SENSITIVITY: a session's `content` is the model's answer, which quotes the
// test script and excerpts of run output. Run output routinely contains page
// content, URLs with session tokens, and values typed while recording. That is
// not a NEW class of exposure — raw run logs already sit unencrypted in
// userData/recorder/logs — so this file lives in the same directory, under the
// same cap, and is covered by the same "Manage data" cleanup. The prompt
// `messages` (which embed the script and output verbatim, in full) are
// deliberately never persisted; they're reconstructible from live data.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import {
  AI_DEBUG_SESSIONS_VERSION,
  type AiDebugSession,
  type AiDebugSessionsFile,
} from "../recorder/types.js";

/** Keep the newest N sessions. Small records, but the file is rewritten as jobs
 *  progress, so unbounded growth would eventually make those writes noticeable. */
const MAX_RECORDS = 20;

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "ai-debug-sessions.json");
}

/** A corrupt or unrecognized file reads as EMPTY rather than throwing or
 *  half-parsing. Losing a diagnosis is recoverable (re-send it); a store that
 *  throws on read takes down every view that touches it. */
function readAll(): AiDebugSession[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const file = parsed as Partial<AiDebugSessionsFile>;
    if (file.version !== AI_DEBUG_SESSIONS_VERSION) return [];
    return Array.isArray(file.sessions) ? (file.sessions as AiDebugSession[]) : [];
  } catch {
    return [];
  }
}

function writeAll(sessions: AiDebugSession[]): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const file: AiDebugSessionsFile = {
      version: AI_DEBUG_SESSIONS_VERSION,
      sessions,
    };
    // tmp + rename so a crash mid-write can't leave a truncated file that then
    // reads as empty and silently loses every retained session.
    const tmp = `${indexFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
    fs.renameSync(tmp, indexFile());
  } catch (err) {
    // A failed write must never take down the job it was recording — the live
    // session is still in memory and still streaming.
    logger.warn("ai-debug", "Failed to write AI debug sessions", { err: String(err) });
  }
}

function sortNewestFirst(sessions: AiDebugSession[]): AiDebugSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export const aiDebugStore = {
  /** All retained sessions, newest activity first. */
  list(): AiDebugSession[] {
    return sortNewestFirst(readAll());
  },

  get(key: string): AiDebugSession | null {
    return readAll().find((s) => s.key === key) ?? null;
  },

  /** Insert or replace by key, then prune to the newest MAX_RECORDS. Called
   *  repeatedly for the same session as it streams (throttled by the caller). */
  save(session: AiDebugSession): AiDebugSession {
    const rest = readAll().filter((s) => s.key !== session.key);
    writeAll(sortNewestFirst([...rest, session]).slice(0, MAX_RECORDS));
    return session;
  },

  /** A session persisted as "streaming" means the app exited while the model
   *  was still answering. Nothing is streaming now, so restore it as
   *  `interrupted` — readable, clearly not live, and re-sendable. Idempotent. */
  reconcileInterrupted(): { reconciled: number } {
    const all = readAll();
    let reconciled = 0;
    const fixed = all.map((s) => {
      if (s.status !== "streaming") return s;
      reconciled++;
      return {
        ...s,
        status: "interrupted" as const,
        requestId: null,
        error: s.error ?? "Interrupted — the app closed while the model was answering",
      };
    });
    if (reconciled > 0) writeAll(fixed);
    return { reconciled };
  },

  remove(key: string): { removed: number } {
    const all = readAll();
    const kept = all.filter((s) => s.key !== key);
    if (kept.length !== all.length) writeAll(kept);
    return { removed: all.length - kept.length };
  },

  /**
   * Drop every session belonging to a deleted test.
   *
   * A real delete, not the tombstone run records get: a session's content is
   * the model quoting the test's script and its run output (see the header
   * above), it contributes to no aggregate anybody looks at, and with the test
   * gone there is no longer any route in the UI to reach or remove it.
   *
   * Filtered by `testId`, not by parsing the `run:<id>` / `step:<id>:<n>` key —
   * the key format is a renderer convention and would silently stop matching if
   * it ever gained a third form.
   */
  deleteTest(testId: string): { removed: number } {
    const all = readAll();
    const kept = all.filter((s) => s.testId !== testId);
    if (kept.length !== all.length) writeAll(kept);
    return { removed: all.length - kept.length };
  },

  clear(): { removed: number } {
    const all = readAll();
    writeAll([]);
    return { removed: all.length };
  },
};
