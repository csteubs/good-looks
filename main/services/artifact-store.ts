// Storage for per-run visual-testing artifacts (Phase 1 of the roadmap).
//
// Layout (kept OUT of tests.json — screenshots are binary and must never inflate
// the JSON store):
//   <userData>/recorder/artifacts/<testId>/<runId>/<stepIndex>.png
//   <userData>/recorder/artifacts/<testId>/<runId>/manifest.json
//
// `runId` is the RunRecord id (unique per execution), so Stats/logs/artifacts
// all join on one id. `stepIndex` is the 0-based page-ACTION order captured by
// the glaze-capture fixture. This key scheme is what later phases (replay,
// visual diffing) retrieve by, so it is intentionally stable.
//
// Retention: keep the newest N run directories per test; older ones are pruned.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

/** Default number of runs whose artifacts are retained per test. */
export const DEFAULT_RETAINED_RUNS = 10;

export interface ArtifactStepEntry {
  index: number;
  action: string;
  target: string;
  value?: string;
  ok: boolean;
  ts: number;
}

export interface ArtifactManifest {
  testId: string;
  runId: string;
  title?: string;
  status?: string;
  startedAt?: number;
  finishedAt?: number;
  steps: ArtifactStepEntry[];
}

function artifactsDir(): string {
  return path.join(app.getPath("userData"), "recorder", "artifacts");
}

function testDir(testId: string): string {
  return path.join(artifactsDir(), testId);
}

export const artifactStore = {
  /** Absolute path to the artifacts root (for "Reveal in Finder" later). */
  rootPath(): string {
    return artifactsDir();
  },

  /** Directory for one run's screenshots + manifest. */
  runDir(testId: string, runId: string): string {
    return path.join(testDir(testId), runId);
  },

  /** Create (and return) the directory for a run's artifacts. */
  ensureRunDir(testId: string, runId: string): string {
    const dir = this.runDir(testId, runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },

  /** Keep the newest `keep` run directories for a test; delete the rest.
   *  Ordered by directory mtime (screenshots are written into the run dir, so
   *  the active/most-recent run always sorts newest). Best-effort; never throws. */
  pruneRuns(testId: string, keep: number = DEFAULT_RETAINED_RUNS): void {
    const dir = testDir(testId);
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // nothing to prune
    }
    const runDirs = names
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.join(dir, e.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const r of runDirs.slice(Math.max(0, keep))) {
      try {
        fs.rmSync(r.full, { recursive: true, force: true });
      } catch (err) {
        logger.warn("artifacts", "Failed to prune run artifacts", {
          dir: r.full,
          err: String(err),
        });
      }
    }
  },

  /** Run ids that have artifacts for a test, newest first (by dir mtime). */
  listRuns(testId: string): string[] {
    const dir = testDir(testId);
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const full = path.join(dir, e.name);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            /* ignore */
          }
          return { name: e.name, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .map((e) => e.name);
    } catch {
      return [];
    }
  },

  /** Read a run's manifest (the per-step artifact + outcome model), or null. */
  readManifest(testId: string, runId: string): ArtifactManifest | null {
    try {
      const raw = fs.readFileSync(path.join(this.runDir(testId, runId), "manifest.json"), "utf-8");
      return JSON.parse(raw) as ArtifactManifest;
    } catch {
      return null;
    }
  },

  /** Delete all artifacts for a test (e.g. when the test is deleted). Best-effort. */
  deleteTest(testId: string): void {
    try {
      fs.rmSync(testDir(testId), { recursive: true, force: true });
    } catch (err) {
      logger.warn("artifacts", "Failed to delete test artifacts", {
        testId,
        err: String(err),
      });
    }
  },
};
