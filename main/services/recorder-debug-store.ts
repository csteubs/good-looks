// Persists per-test replay debug logs to a JSON file under userData, so the
// trainer's step debug panel survives closing and reopening the window.
//
// Logs are keyed by testId; each test holds a list of DebugEntry (one per
// replay attempt per step). We cap the number of entries per test to keep
// the file bounded.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import type { DebugEntry } from "../recorder/types.js";

const MAX_ENTRIES_PER_TEST = 200;

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function file(): string {
  return path.join(dataDir(), "debug-logs.json");
}

type Store = Record<string, DebugEntry[]>;

function read(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(store, null, 2), "utf-8");
}

export const recorderDebugStore = {
  /** All debug entries for a test (oldest first). */
  get(testId: string): DebugEntry[] {
    return read()[testId] ?? [];
  },

  /** Append a debug entry for a test, capping total entries per test. */
  append(testId: string, entry: DebugEntry): DebugEntry[] {
    const store = read();
    const list = store[testId] ?? [];
    // Drop any prior entry for the same step so the panel shows the latest
    // attempt rather than accumulating stale ones.
    const filtered = list.filter((e) => e.stepId !== entry.stepId);
    filtered.push(entry);
    const capped = filtered.slice(-MAX_ENTRIES_PER_TEST);
    store[testId] = capped;
    write(store);
    logger.info("recorder", "Appended debug entry", {
      testId,
      stepId: entry.stepId,
      ok: entry.ok,
      lines: entry.logs.length,
    });
    return capped;
  },

  /** Remove a single step's entry for a test. */
  remove(testId: string, stepId: string): DebugEntry[] {
    const store = read();
    const list = (store[testId] ?? []).filter((e) => e.stepId !== stepId);
    if (list.length === 0) {
      delete store[testId];
    } else {
      store[testId] = list;
    }
    write(store);
    return list;
  },

  /** Clear all debug entries for a test. */
  clear(testId: string): void {
    const store = read();
    if (store[testId]) {
      delete store[testId];
      write(store);
    }
  },
};
