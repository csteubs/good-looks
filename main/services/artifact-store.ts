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

import { app, logger } from "@shell/backend";

import type { A11yResult, A11yViolation } from "./a11y-diff.js";
import { redactWithSnapshot } from "./secret-redaction.js";

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

/**
 * Called for every run directory about to be deleted, before it is deleted.
 *
 * The seam the metrics rollup hangs off: retention is where per-step evidence
 * dies, so it is the last moment anything can distil a run into the ~60 bytes
 * of rows that outlive it.
 *
 * REGISTERED rather than imported. metrics-store reads through this module, so
 * importing it here would be a cycle — and this way the store stays free of any
 * knowledge that metrics exist, which is what keeps a metrics failure from
 * being able to break pruning.
 */
let prunePreflight: ((testId: string, runId: string) => void) | null = null;

export function setPrunePreflight(fn: (testId: string, runId: string) => void): void {
  prunePreflight = fn;
}

export interface ArtifactStepEntry {
  index: number;
  action: string;
  target: string;
  value?: string;
  ok: boolean;
  ts: number;
  /** wall-clock ms this one SCREENSHOT took (absent on pre-instrumentation
   *  runs). Summed into `captureMs` — this is what capture costs, not what the
   *  step costs. For the latter see `stepMs`. */
  ms?: number;
  /** wall-clock ms the ACTION itself took, from call to resolve — excluding the
   *  screenshot and the axe run, including crawl's settling waits (those are
   *  time the step really took).
   *
   *  Recorded from 2026-08-07. The two durations were conflated before that,
   *  with only the screenshot's measured: reading `ms` as step duration would
   *  make "this step went from 1.2s to 4.8s" a statement about how long a PNG
   *  took to write. Absent on older runs, and not reconstructible from them. */
  stepMs?: number;
  /** the acted-on element's viewport rect, NORMALIZED 0–1, measured at capture
   *  time. Present only for locator actions; the anchor for component-level
   *  diffing (no selector is re-resolved later). */
  rect?: NormalizedRect;
  /** accessibility violations found after this action, when a11y checks were
   *  on. Compacted by the fixture — see A11yViolation. */
  a11y?: A11yViolation[];
  /** Which tab this action ran on, 1-based from the SECOND tab: the run
   *  follows the newest tab (shared/tabs-fixture-source.mjs) and the fixture
   *  stamps a later tab's index here. Absent on the first tab, so a manifest
   *  predating tabs reads as it always did. */
  page?: number;
}

/** A normalized (0–1) rectangle in page/viewport space. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** total ms spent on accessibility checks, and how many ran. Separate from
   *  the capture numbers: axe usually costs more than the screenshots do, and
   *  folding the two together would misattribute a slow run. */
  a11yMs?: number;
  a11yChecks?: number;
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

/** One measured area of change. Mirror of `visual-diff.ts`'s own type; kept
 *  structural here so the record types do not import the diffing service. */
export interface DiffRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: number;
  share: number;
}

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
  /** "element" when this step was compared element-scoped rather than
   *  page-wide, so the UI can label what the ratio is a share OF. */
  scope?: "page" | "element";
  /** Where the change is, largest first — REDESIGN §6.6's "what moved".
   *  Normalized (0–1) against the compared image, like every other rect in
   *  this app, so the viewer can lay a box over the frame at any size.
   *  Recorded only for "changed": it is what the user triages, and a matched
   *  step's sub-threshold specks are noise stored in every replay forever. */
  regions?: DiffRegion[];
  /** Regions found beyond the cap and folded away, so the UI can say "and 12
   *  smaller" rather than implying the list is everything. */
  regionsOmitted?: number;
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
  /** This step's index in ACTION order — the manifest entry it matched.
   *
   *  The join between the app's two index spaces: `index` above counts Step[]
   *  positions, while the capture fixture numbers screenshots, and tags every
   *  console.json / network.json entry, by action order. Absent for a step that
   *  captures nothing (assertions, waits, if/endif).
   *
   *  Recorded explicitly since 2026-08-07. It was previously only recoverable
   *  by parsing it back out of `screenshot`'s filename, which is null whenever
   *  the shot failed and on every a11y-only or logs-only run — so a join keyed
   *  on it silently matched nothing exactly when there were no screenshots to
   *  notice were missing. */
  actionIndex?: number;
  /** the acted-on element's normalized rect at capture time, when recorded. */
  rect?: NormalizedRect;
  /** Which tab the step acted on, counted from 0 for the tab the run started
   *  on. Present only for a later tab — the manifest entry's `page` — so the
   *  Visual tab can say a screenshot is of tab 2 rather than leaving the
   *  reader to notice the page changed. */
  tab?: number;
  /** visual-diff result for this step's screenshot, when captured (Phase 3). */
  diff?: VisualDiff;
  /** accessibility result for this step, when a11y checks were on. Reported
   *  only — a step with new violations still passes if its assertions did. */
  a11y?: A11yResult;
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
  /** Which of the replay screen's findings banners the user has dismissed.
   *  Lives on the replay rather than in renderer state because a dismissal that
   *  comes back when you click away is not a dismissal. Safe to pin to the run:
   *  a run's findings never change after it finishes, and a re-run writes a new
   *  replay that starts undismissed. */
  dismissedNotices?: RunNoticeKind[];
  steps: ReplayStep[];
}

/** The two findings a run reports that don't fail it, and that the user can
 *  therefore either resolve (accept) or wave off (dismiss). */
export type RunNoticeKind = "visual" | "a11y";

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
  /** how many steps reported accessibility violations that aren't accepted. */
  a11yNewSteps: number;
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


// ── Console + network recording ──────────────────────────────────────
// Written by the capture fixture into the run dir as console.json /
// network.json. Kept out of manifest.json because they are unbounded in a way
// per-step entries are not, and every existing manifest reader would have to
// parse past them.

export interface ConsoleEntry {
  /** Action index that was current when this was logged, for correlation. */
  step: number;
  ts: number;
  /** console type (log/warn/error/debug/…) or "pageerror" for an uncaught throw. */
  type: string;
  text: string;
  url: string;
  line: number;
  /** Which tab produced this, 1-based, and ONLY for a tab the page opened —
   *  the same rule the manifest's `page` follows, so a log file predating tabs
   *  reads exactly as it did. Absent means the tab the test started on, or a
   *  run with no tab vocabulary at all. Written since 2026-09-02, declared
   *  here since 2026-09-03: the fixture had been recording it into a file
   *  whose type said it did not exist. */
  page?: number;
}

export interface NetworkEntry {
  step: number;
  ts: number;
  ms: number;
  method: string;
  url: string;
  resourceType: string;
  /** 0 for a request that never got a response (blocked, DNS, CORS). */
  status: number;
  ok: boolean;
  failure?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** As `ConsoleEntry.page`. Every recorded request has one, because a request
   *  the fixture cannot attribute to a page is not recorded at all — a tab's
   *  own navigation has no frame yet, so nothing can name it. */
  page?: number;
}

/** One step run-time Auto-Heal tried to rescue and could not.
 *
 *  `"no-candidates"` is the stronger of the two: the probe found nothing on the
 *  page resembling the element, so there was not even anything to try.
 *  `"exhausted"` means candidates were ranked and acting on every one of them
 *  failed too. Both say the element is GONE rather than merely renamed, which
 *  is evidence about the SITE — the opposite conclusion to a successful heal,
 *  where the element existed and only the locator was stale. */
export interface HealFailure {
  outcome: "exhausted" | "no-candidates";
  stepId: string;
  stepIndex: number;
  stepLabel: string;
  /** the Locator action that failed (`click`, `fill`, …) */
  method?: string;
  originalLocator?: unknown;
  /** what the probe managed to rank, when it ranked anything */
  candidates?: unknown[];
  at: number;
}

export interface RunLogs {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /** Entries dropped by the per-run cap, so a truncated log says so. */
  consoleDropped: number;
  networkDropped: number;
  /** False when the run recorded every header (the explicit escape hatch). */
  headersFiltered: boolean;
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
   *  the active/most-recent run always sorts newest). Best-effort; never throws.
   *
   *  `maxAgeMs` adds an age rule ON TOP of the count: a run survives only if it
   *  is both within the newest `keep` AND newer than the cutoff. Omit or pass 0
   *  to disable the age rule. `baseline/` is excluded from both rules. */
  pruneRuns(testId: string, keep: number = DEFAULT_RETAINED_RUNS, maxAgeMs = 0): void {
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

    const cutoff = maxAgeMs > 0 ? Date.now() - maxAgeMs : 0;
    const doomed = runDirs.filter(
      (r, i) => i >= Math.max(0, keep) || (cutoff > 0 && r.mtime > 0 && r.mtime < cutoff),
    );

    for (const r of doomed) {
      // Roll the run up BEFORE the evidence goes. Wrapped separately from the
      // delete so a preflight that throws cannot stop retention from running —
      // the disk filling up is a worse failure than a gap in the metrics.
      if (prunePreflight) {
        try {
          prunePreflight(testId, path.basename(r.full));
        } catch (err) {
          logger.warn("artifacts", "Prune preflight failed", {
            dir: r.full,
            err: String(err),
          });
        }
      }
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

  /** Apply retention to EVERY test that has artifacts, not just one.
   *
   *  `pruneRuns` alone only ever runs as a side effect of a capture run for the
   *  test being run, which leaves three holes: an idle test's artifacts never
   *  age out (so an age rule silently does nothing), lowering the run limit
   *  doesn't apply to tests until their next capture run, and deleted/hidden
   *  tests are never swept at all. This closes them. Returns what it freed so
   *  the UI can report it. */
  pruneAllTests(keep: number, maxAgeMs = 0): { removedRuns: number; freedBytes: number } {
    const before = this.usage();
    let removedRuns = 0;
    let testDirs: fs.Dirent[];
    try {
      testDirs = fs.readdirSync(artifactsDir(), { withFileTypes: true });
    } catch {
      return { removedRuns: 0, freedBytes: 0 }; // nothing captured yet
    }
    for (const t of testDirs) {
      if (!t.isDirectory()) continue;
      const was = this.listRuns(t.name).length;
      this.pruneRuns(t.name, keep, maxAgeMs);
      removedRuns += Math.max(0, was - this.listRuns(t.name).length);
    }
    const after = this.usage();
    return { removedRuns, freedBytes: Math.max(0, before.bytes - after.bytes) };
  },

  /** Snapshot the exact Step[] a run executed, alongside its screenshots.
   *  replay.json holds only labels/statuses — not locators — so re-executing a
   *  past run needs the real steps. Storing them per run also means a re-run
   *  replays what actually ran, even if the test has been edited since. */
  writeSteps(testId: string, runId: string, steps: unknown[]): void {
    try {
      fs.writeFileSync(
        path.join(this.runDir(testId, runId), "steps.json"),
        JSON.stringify(steps, null, 2),
        "utf-8",
      );
    } catch (err) {
      logger.warn("artifacts", "Failed to snapshot run steps", { testId, runId, err: String(err) });
    }
  },

  /** The Step[] snapshot for a run, or null when it predates snapshotting. */
  readSteps<T>(testId: string, runId: string): T[] | null {
    try {
      const raw = fs.readFileSync(path.join(this.runDir(testId, runId), "steps.json"), "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : null;
    } catch {
      return null;
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


  /** Read a run's recorded console + network, or null when the run has none
   *  (recording was off, or the test is imported and never gets the fixture).
   *
   *  SECRETS ARE REDACTED HERE, not at write time. The fixture runs in
   *  Playwright's own process and has no access to the secret snapshot, so it
   *  can only do the STRUCTURAL scrubbing (header allowlist, credential-bearing
   *  query parameters). The user's configured secret VALUES are stripped on the
   *  way out, which is the last point before this data reaches a UI or a
   *  prompt. Both are needed; neither is sufficient alone. */
  readLogs(testId: string, runId: string): RunLogs | null {
    const dir = this.runDir(testId, runId);
    const readJson = <T>(name: string): T | null => {
      try {
        return JSON.parse(redactWithSnapshot(fs.readFileSync(path.join(dir, name), "utf-8"))) as T;
      } catch {
        return null;
      }
    };
    const consoleFile = readJson<{ entries?: ConsoleEntry[]; dropped?: number }>("console.json");
    const networkFile = readJson<{
      entries?: NetworkEntry[];
      dropped?: number;
      headersFiltered?: boolean;
    }>("network.json");
    if (!consoleFile && !networkFile) return null;
    return {
      console: consoleFile?.entries ?? [],
      network: networkFile?.entries ?? [],
      consoleDropped: consoleFile?.dropped ?? 0,
      networkDropped: networkFile?.dropped ?? 0,
      headersFiltered: networkFile?.headersFiltered !== false,
    };
  },

  /** Whether a run recorded logs at all — cheap enough to ask before offering
   *  them to the model, without parsing megabytes to find out. */
  hasLogs(testId: string, runId: string): boolean {
    const dir = this.runDir(testId, runId);
    return fs.existsSync(path.join(dir, "console.json")) || fs.existsSync(path.join(dir, "network.json"));
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

  /** Persist the steps run-time Auto-Heal tried to rescue and could not.
   *
   *  Its own file, beside console.json and network.json rather than inside
   *  manifest.json, for the same reason those are: it is unbounded in a way a
   *  per-step manifest entry is not, and every existing manifest reader would
   *  have to parse past it.
   *
   *  Deliberately NOT the heal journal. That is a review surface — every row is
   *  a locator change to accept or revert — and an attempt that healed nothing
   *  offers no such action. This is evidence about one run, keyed by step. */
  writeHealFailures(testId: string, runId: string, failures: HealFailure[]): void {
    if (failures.length === 0) return;
    const dir = this.ensureRunDir(testId, runId);
    fs.writeFileSync(
      path.join(dir, "heal-failures.json"),
      JSON.stringify({ testId, runId, entries: failures }, null, 2),
    );
  },

  /** Whether this run recorded anything about the page around a failing step —
   *  either file. Asked before offering the data to a model, so an unavailable
   *  request can be answered without reading and normalizing to find it empty.
   *
   *  Either alone is a complete answer to a different question, so this is an
   *  OR: a step whose ambiguous locator then healed writes matches and no heal
   *  failure, and a run from before matches existed writes the reverse. */
  hasHealFailures(testId: string, runId: string): boolean {
    const dir = this.runDir(testId, runId);
    return (
      fs.existsSync(path.join(dir, "heal-failures.json")) ||
      fs.existsSync(path.join(dir, "step-matches.json"))
    );
  },

  /** Persist what each failing locator actually resolved to. Its own file for
   *  the same reason heal-failures.json is: unbounded in a way a per-step
   *  manifest entry is not. */
  writeStepMatches(testId: string, runId: string, sets: unknown[]): void {
    if (sets.length === 0) return;
    const dir = this.ensureRunDir(testId, runId);
    fs.writeFileSync(
      path.join(dir, "step-matches.json"),
      JSON.stringify({ testId, runId, entries: sets }, null, 2),
    );
  },

  /** Read what each failing locator resolved to, or an empty list. Returned
   *  RAW in shape: every field is page-authored, and the rebuild belongs at
   *  the IPC edge with the other boundary normalizers, not here. Redacted in
   *  CONTENT, like `readLogs`: this is what `artifacts:getStructure` hands to
   *  a hosted model, and a page that echoed a secret into an element's text
   *  is a page this file quotes. */
  readStepMatches(testId: string, runId: string): unknown[] {
    try {
      const raw = redactWithSnapshot(
        fs.readFileSync(path.join(this.runDir(testId, runId), "step-matches.json"), "utf-8"),
      );
      const parsed = JSON.parse(raw) as { entries?: unknown[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  },

  /** Read a run's failed heal attempts, or an empty list. Redacted, as
   *  `readStepMatches` is and for the same reason. */
  readHealFailures(testId: string, runId: string): HealFailure[] {
    try {
      const raw = redactWithSnapshot(
        fs.readFileSync(path.join(this.runDir(testId, runId), "heal-failures.json"), "utf-8"),
      );
      const parsed = JSON.parse(raw) as { entries?: HealFailure[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
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
          a11yNewSteps: r.steps.filter((s) => (s.a11y?.newKeys.length ?? 0) > 0).length,
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
