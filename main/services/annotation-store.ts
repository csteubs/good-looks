// Persistence for user-authored notes on replay steps (Phase 4 of the
// visual-testing roadmap). Kept as its own flat JSON index — same pattern as
// test-store.ts's tests.json — rather than inside replay.json, since
// replay.json is a runner-owned model that's fully regenerated every run.

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { app, logger } from "@glaze/core/backend";

export interface Annotation {
  id: string;
  testId: string;
  runId: string;
  stepId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "annotations.json");
}

function readAll(): Annotation[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Annotation[]) : [];
  } catch {
    return [];
  }
}

function writeAll(records: Annotation[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(records, null, 2), "utf-8");
}

export const annotationStore = {
  /** All notes for one run, in no particular order (the UI keys by stepId). */
  list(testId: string, runId: string): Annotation[] {
    return readAll().filter((a) => a.testId === testId && a.runId === runId);
  },

  /** Create/update the single note for a step in a run. Blank text deletes
   *  the note instead of storing an empty one. Returns the stored record, or
   *  null when the note was deleted/never existed. */
  upsert(testId: string, runId: string, stepId: string, text: string): Annotation | null {
    const all = readAll();
    const idx = all.findIndex(
      (a) => a.testId === testId && a.runId === runId && a.stepId === stepId,
    );
    const trimmed = text.trim();

    if (!trimmed) {
      if (idx >= 0) {
        all.splice(idx, 1);
        writeAll(all);
      }
      return null;
    }

    const now = Date.now();
    if (idx >= 0) {
      all[idx] = { ...all[idx], text: trimmed, updatedAt: now };
      writeAll(all);
      return all[idx];
    }

    const rec: Annotation = {
      id: randomUUID(),
      testId,
      runId,
      stepId,
      text: trimmed,
      createdAt: now,
      updatedAt: now,
    };
    all.push(rec);
    writeAll(all);
    logger.info("annotations", "Saved step annotation", { testId, runId, stepId });
    return rec;
  },

  /** Drop all notes for a test (e.g. when the test is deleted). */
  deleteTest(testId: string): void {
    writeAll(readAll().filter((a) => a.testId !== testId));
  },
};
