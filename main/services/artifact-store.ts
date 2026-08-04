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

/** Default number of runs whose artifacts are retained per test.
 *  Sized against real usage: a captured run dir is ~0.6 MB for a small test
 *  (page-level PNGs ~0.1–0.4 MB each), so 10 retained runs is ~6 MB for a
 *  small test and tens of MB for a large one — recent history for scrubbing/
 *  diffing without being wasteful. The PINNED baseline lives in a sibling
 *  `baseline/` dir that pruning never touches (see RESERVED_DIRS), so the
 *  comparison anchor always survives regardless of this number. */
export const DEFAULT_RETAINED_RUNS = 10;

/** Subdirectories of a test's artifact dir that are NOT runs and must never be
 *  listed or pruned as one. `baseline/` holds the pinned Phase 3 baselines —
 *  deleting it during retention would silently destroy the comparison anchor. */
const RESERVED_DIRS = new Set(["baseline"]);

export interface ArtifactStepEntry {
  index: number;
  action: string;
  target: string;
  value?: string;
  ok: boolean;
  ts: number;
  /** wall-clock ms this one screenshot took (absent on pre-instrumentation runs) */
  ms?: number;
}

export interface ArtifactManifest {
  testId: string;
  runId: string;
  title?: string;
  status?: string;
  startedAt?: number;
  finishedAt?: number;
  /** total ms spent taking screenshots this run (absent on older manifests) */
  captureMs?: number;
  /** how many screenshots were attempted (absent on older manifests) */
  shotCount?: number;
  steps: ArtifactStepEntry[];
}

/** Per-step outcome for a completed run, aligned to the test's Step[] index.
 *  `screenshot` is a filename (e.g. "3.png") within the run dir, or null when
 *  the step produced no artifact (assertions/waits aren't captured, the step
 *  was skipped/never ran, or the capture failed). */
export type ReplayStepStatus = "passed" | "failed" | "skipped" | "unknown";

/** Visual-diff outcome for a step (Phase 3), persisted in replay.json.
 *  - "new-baseline": no prior baseline existed, so this shot seeded it.
 *  - "match": changed pixels within the test's threshold.
 *  - "changed": changed pixels exceeded the threshold — flagged in the UI.
 *  - "unable": couldn't compare (corrupt image, or size mismatch from a
 *    viewport/responsive change) — never a false flag. */
export type VisualDiffState = "new-baseline" | "match" | "changed" | "unable";

export interface VisualDiff {
  state: VisualDiffState;
  /** fraction of pixels changed (0–1), for match/changed. */
  ratio?: number;
  /** threshold (percent, 0–100) this step was compared at. */
  threshold?: number;
  /** why the comparison couldn't run, for state "unable". */
  reason?: string;
  /** diff-overlay filename (e.g. "3.diff.png") in the run dir, for "changed". */
  diffFile?: string;
  /** how many ignore masks were applied to this step's comparison, when any.
   *  Lets the UI say the result was measured with regions excluded. */
  maskedCount?: number;
}

export interface ReplayStep {
  /** 0-based index into the test's Step[] at run time. */
  index: number;
  /** stable Step.id — the key baselines are pinned under. */
  stepId: string;
  /** human-friendly label (mirrors describeStep). */
  label: string;
  type: string;
  status: ReplayStepStatus;
  screenshot: string | null;
  /** visual-diff result for this step's screenshot, when captured (Phase 3). */
  diff?: VisualDiff;
}

/** The canonical replay model persisted per run (replay.json). The runner
 *  builds this at run end by correlating the reporter's per-step statuses and
 *  the capture manifest against the test's Step[], so the replay UI is a dumb
 *  reader — all index correlation lives here, computed once. */
export interface RunReplay {
  testId: string;
  runId: string;
  testName: string;
  url?: string;
  status: "passed" | "failed";
  startedAt: number;
  finishedAt: number;
  /** 0-based Step[] index of the first failed step, or null when the run passed. */
  failedIndex: number | null;
  /** threshold (percent, 0–100) this run's visual diffs used, when captured. */
  visualThreshold?: number;
  steps: ReplayStep[];
}

/** Lightweight summary for the replay run list (from each run's replay.json). */
export interface RunReplaySummary {
  testId: string;
  runId: string;
  testName: string;
  status: "passed" | "failed";
  startedAt: number;
  finishedAt: number;
  stepCount: number;
  failedIndex: number | null;
  /** how many steps exceeded the visual threshold this run (Phase 3). */
  changedSteps: number;
}

/** On-disk footprint of all captured artifacts, for the retention setting's
 *  "using X MB across N runs" readout. */
export interface ArtifactUsage {
  /** total bytes under the artifacts root (screenshots + manifests + baselines) */
  bytes: number;
  /** number of retained run directories across all tests (excludes `baseline/`) */
  runs: number;
  /** number of tests that have any artifacts */
  tests: number;
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

  /** Total on-disk footprint of every captured artifact (screenshots, manifests,
   *  replay.json, and pinned baselines), so the retention setting can be shown
   *  against a real number instead of a guess. Best-effort: unreadable entries
   *  are skipped rather than throwing. */
  usage(): ArtifactUsage {
    const root = artifactsDir();
    let bytes = 0;
    let runs = 0;
    let tests = 0;

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          try {
            bytes += fs.statSync(full).size;
          } catch {
            /* skip unreadable file */
          }
        }
      }
    };

    let testDirs: fs.Dirent[];
    try {
      testDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return { bytes: 0, runs: 0, tests: 0 }; // nothing captured yet
    }
    for (const t of testDirs) {
      if (!t.isDirectory()) continue;
      tests += 1;
      runs += this.listRuns(t.name).length;
      walk(path.join(root, t.name));
    }
    return { bytes, runs, tests };
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
      .filter((e) => e.isDirectory() && !RESERVED_DIRS.has(e.name))
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
        .filter((e) => e.isDirectory() && !RESERVED_DIRS.has(e.name))
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

  /** Persist the canonical replay model for a run (replay.json in the run dir). */
  writeReplay(testId: string, runId: string, replay: RunReplay): void {
    try {
      const dir = this.ensureRunDir(testId, runId);
      fs.writeFileSync(path.join(dir, "replay.json"), JSON.stringify(replay, null, 2));
    } catch (err) {
      logger.warn("artifacts", "Failed to write replay model", {
        testId,
        runId,
        err: String(err),
      });
    }
  },

  /** Read a run's replay model, or null if it doesn't exist (e.g. capture off). */
  readReplay(testId: string, runId: string): RunReplay | null {
    try {
      const raw = fs.readFileSync(path.join(this.runDir(testId, runId), "replay.json"), "utf-8");
      return JSON.parse(raw) as RunReplay;
    } catch {
      return null;
    }
  },

  /** All runs (across all tests) that have a persisted replay, newest first.
   *  Reflects retention automatically — pruned run dirs simply aren't found. */
  listReplays(): RunReplaySummary[] {
    const root = artifactsDir();
    let testIds: fs.Dirent[];
    try {
      testIds = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: RunReplaySummary[] = [];
    for (const t of testIds) {
      if (!t.isDirectory()) continue;
      for (const runId of this.listRuns(t.name)) {
        const r = this.readReplay(t.name, runId);
        if (!r) continue;
        out.push({
          testId: r.testId,
          runId: r.runId,
          testName: r.testName,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          stepCount: r.steps.length,
          failedIndex: r.failedIndex,
          changedSteps: r.steps.filter((s) => s.diff?.state === "changed").length,
        });
      }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  },

  /** Read a single screenshot's raw PNG bytes. `file` is validated to a bare
   *  "<index>.png" or diff-overlay "<index>.diff.png" so it can't escape the
   *  run directory. */
  readShot(testId: string, runId: string, file: string): Buffer | null {
    if (!/^\d+(\.diff)?\.png$/.test(file)) return null;
    try {
      return fs.readFileSync(path.join(this.runDir(testId, runId), file));
    } catch {
      return null;
    }
  },

  /** Write a diff-overlay PNG for a step (Phase 3). Returns the bare filename. */
  writeDiff(testId: string, runId: string, index: number, png: Buffer): string {
    const file = `${index}.diff.png`;
    try {
      fs.writeFileSync(path.join(this.runDir(testId, runId), file), png);
    } catch (err) {
      logger.warn("artifacts", "Failed to write diff overlay", {
        testId,
        runId,
        index,
        err: String(err),
      });
    }
    return file;
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
