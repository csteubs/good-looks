// Pinned per-test visual baselines (Phase 3 of the visual-testing roadmap).
//
// Baselines are keyed by Step.id — NOT by URL. A test is a deterministic script
// and Step.id is stable across trainer edits, so keying on it survives step
// reorder/insert/delete (URL keying is ambiguous: many steps share one URL).
// Only screenshot-producing steps (page actions) get a baseline.
//
// Layout (binaries stay OUT of tests.json, like Phase 1 artifacts):
//   <userData>/recorder/artifacts/<testId>/baseline/<stepId>.png
//   <userData>/recorder/artifacts/<testId>/baseline/baseline.json  (metadata)
//
// A baseline is PINNED: the first captured run seeds it; all later runs compare
// against it, never the previous run. The user re-pins explicitly via
// "Accept as new baseline" (per-run or per-step).

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import type { NormalizedRect } from "./artifact-store.js";

/** Per-step baseline metadata (the PNG lives alongside as <stepId>.png). */
export interface BaselineEntry {
  stepId: string;
  /** the runId this baseline screenshot was captured/accepted from. */
  runId: string;
  /** epoch ms the baseline was pinned. */
  at: number;
  /** human-friendly label at pin time (for a future baselines manager UI). */
  label: string;
  /** the element's normalized rect in THIS baseline screenshot, when the run
   *  that pinned it recorded one. Component-level diffing crops the baseline
   *  by this and the new shot by its own — comparing like with like. */
  rect?: NormalizedRect;
}

interface BaselineManifest {
  testId: string;
  updatedAt: number;
  /** keyed by stepId. */
  steps: Record<string, BaselineEntry>;
}

/** Filenames are derived from Step.id (a randomUUID), but sanitize defensively
 *  so a non-UUID id scheme can never escape the baseline directory. */
function safeStepFile(stepId: string): string {
  return stepId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".png";
}

function baselineDir(testId: string): string {
  return path.join(app.getPath("userData"), "recorder", "artifacts", testId, "baseline");
}

function manifestPath(testId: string): string {
  return path.join(baselineDir(testId), "baseline.json");
}

function readManifest(testId: string): BaselineManifest {
  try {
    const raw = fs.readFileSync(manifestPath(testId), "utf-8");
    const parsed = JSON.parse(raw) as BaselineManifest;
    if (parsed && typeof parsed === "object" && parsed.steps) return parsed;
  } catch {
    /* fall through to empty */
  }
  return { testId, updatedAt: 0, steps: {} };
}

function writeManifest(testId: string, m: BaselineManifest): void {
  const dir = baselineDir(testId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(testId), JSON.stringify(m, null, 2), "utf-8");
}

export const baselineStore = {
  /** True when a step has a pinned baseline PNG. */
  has(testId: string, stepId: string): boolean {
    return fs.existsSync(path.join(baselineDir(testId), safeStepFile(stepId)));
  },

  /** Raw PNG bytes of a step's baseline, or null. */
  readShot(testId: string, stepId: string): Buffer | null {
    try {
      return fs.readFileSync(path.join(baselineDir(testId), safeStepFile(stepId)));
    } catch {
      return null;
    }
  },

  /** Pin (or replace) a step's baseline with the given PNG bytes. */
  set(
    testId: string,
    stepId: string,
    png: Buffer,
    meta: { runId: string; label: string; rect?: NormalizedRect },
  ): void {
    const dir = baselineDir(testId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeStepFile(stepId)), png);
    const m = readManifest(testId);
    m.steps[stepId] = {
      stepId,
      runId: meta.runId,
      at: Date.now(),
      label: meta.label,
      ...(meta.rect ? { rect: meta.rect } : {}),
    };
    m.updatedAt = Date.now();
    writeManifest(testId, m);
  },

  /** Metadata for one step's baseline, or null. */
  entry(testId: string, stepId: string): BaselineEntry | null {
    return readManifest(testId).steps[stepId] ?? null;
  },

  /** Full baseline metadata for a test. */
  manifest(testId: string): BaselineManifest {
    return readManifest(testId);
  },

  /** Serve a baseline PNG as a data URL (for the replay UI's side-by-side). */
  readShotDataUrl(testId: string, stepId: string): string | null {
    const buf = this.readShot(testId, stepId);
    return buf ? `data:image/png;base64,${buf.toString("base64")}` : null;
  },

  /** Delete every baseline for a test (called when the test is deleted). */
  deleteTest(testId: string): void {
    try {
      fs.rmSync(baselineDir(testId), { recursive: true, force: true });
    } catch (err) {
      logger.warn("baseline", "Failed to delete baselines", { testId, err: String(err) });
    }
  },
};
