// Runs generated Playwright specs locally using the bundled @playwright/test.
// Browsers are installed on first run into a writable userData folder. Output is
// streamed to the app's main window; each run is tracked by a runId.

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { app, logger } from "@glaze/core/backend";

import { sendToMain } from "./app-window.js";
import { getScriptsDir, testStore } from "./test-store.js";
import { runHistoryStore } from "./run-history-store.js";
import { stepReporterSource } from "./step-reporter-source.js";
import { captureFixtureSource } from "./capture-fixture-source.js";
import { artifactStore, DEFAULT_RETAINED_RUNS } from "./artifact-store.js";
import type { ReplayStep, ReplayStepStatus, RunReplay } from "./artifact-store.js";
import { baselineStore } from "./baseline-store.js";
import { diffPngBuffers } from "./visual-diff.js";
import { describeStep } from "./script-generator.js";
import { DEFAULT_VISUAL_THRESHOLD } from "../recorder/types.js";
import type { Step, TestSpeed } from "../recorder/types.js";

// Module Playwright specs import test/expect from — redirected to the capture
// fixture for a run that captures artifacts.
const CAPTURE_FIXTURE_FILE = "glaze-capture.mjs";

const RUN_TIMEOUT_MS = 5 * 60 * 1000;

// Delay (ms) Playwright inserts between actions via launchOptions.slowMo, so a
// "slow" run is easy to follow with the naked eye and "fast" matches today's
// default (no artificial delay).
const SLOW_MO_MS: Record<TestSpeed, number> = { fast: 0, medium: 400, slow: 1200 };

interface RunHandle {
  child: ChildProcess;
  testId: string;
}

const runs = new Map<string, RunHandle>();

function browsersPath(): string {
  return path.join(app.getPath("userData"), "recorder", "browsers");
}

/** Locate the app's node_modules root and the @playwright/test CLI entry.
 *
 * The bundled backend runs from `.glaze/build/main`, but dependencies live in
 * `.glaze-sources/node_modules` (and, in dev, the backend runs straight from
 * source). Scan the likely roots and use whichever actually contains the
 * package. */
function resolvePlaywright(): { cliPath: string; nodeModules: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [
    // dev: main/services -> .glaze-sources/node_modules
    path.resolve(here, "..", "..", "node_modules"),
    // prod: .glaze/build/main -> appDir/.glaze-sources/node_modules
    path.resolve(here, "..", "..", "..", ".glaze-sources", "node_modules"),
    // fallback: appDir/node_modules
    path.resolve(here, "..", "..", "..", "node_modules"),
  ];

  const nodeModules = candidateRoots.find((root) =>
    fs.existsSync(path.join(root, "@playwright", "test", "package.json")),
  );
  if (!nodeModules) {
    throw new Error(
      "Could not find @playwright/test. Looked in: " + candidateRoots.join(", "),
    );
  }

  const cliCandidates = [
    path.join(nodeModules, "@playwright", "test", "cli.js"),
    path.join(nodeModules, "playwright", "cli.js"),
    path.join(nodeModules, "playwright-core", "cli.js"),
  ];
  const cliPath = cliCandidates.find((c) => fs.existsSync(c));
  if (!cliPath) {
    throw new Error("Could not locate the Playwright CLI in " + nodeModules);
  }
  return { cliPath, nodeModules };
}

function ensureModuleResolution(scriptsDir: string, nodeModules: string): void {
  // Specs import "@playwright/test"; a node_modules symlink next to them lets
  // Node resolve it even though they live under userData.
  const link = path.join(scriptsDir, "node_modules");
  try {
    if (!fs.existsSync(link)) {
      fs.symlinkSync(nodeModules, link, "dir");
    }
  } catch (err) {
    logger.warn("runner", "Could not symlink node_modules; relying on NODE_PATH", {
      err: String(err),
    });
  }
}

// Playwright's test CLI has no --slow-mo flag; launchOptions.slowMo only comes
// from config. Write a minimal config once, alongside the specs, that reads
// the delay from an env var so each run can pick its own speed.
function ensureConfig(scriptsDir: string): string {
  const configPath = path.join(scriptsDir, "playwright.config.ts");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      'import { defineConfig } from "@playwright/test";\n\n' +
        "export default defineConfig({\n" +
        "  use: {\n" +
        "    launchOptions: {\n" +
        "      slowMo: Number(process.env.PW_SLOWMO_MS || 0),\n" +
        "    },\n" +
        "  },\n" +
        "});\n",
      "utf-8",
    );
  }
  return configPath;
}

// Write the StepReporter next to the specs so the Playwright CLI can load it.
// Always rewritten so it stays in sync with the app's current build.
function ensureReporter(scriptsDir: string): string {
  const reporterPath = path.join(scriptsDir, "step-reporter.mjs");
  fs.writeFileSync(reporterPath, stepReporterSource, "utf-8");
  return reporterPath;
}

// Write the capture fixture (glaze-capture.mjs) next to the specs so a
// capture run's redirected spec can import it. Always rewritten to stay in sync
// with the app build.
function ensureCaptureFixture(scriptsDir: string): void {
  fs.writeFileSync(path.join(scriptsDir, CAPTURE_FIXTURE_FILE), captureFixtureSource, "utf-8");
}

// For a capture run, produce a temp copy of the spec whose `@playwright/test`
// import is redirected to the capture fixture, leaving the stored spec pristine.
// Only line 1's module specifier changes, so line numbers (and the step line
// map) are preserved. Returns the temp path, or null when the spec doesn't
// import @playwright/test directly (nothing to redirect → run the original).
function prepareCaptureSpec(scriptsDir: string, scriptPath: string, runId: string): string | null {
  let src: string;
  try {
    src = fs.readFileSync(scriptPath, "utf-8");
  } catch {
    return null;
  }
  const redirected = src.replace(
    /from\s+["']@playwright\/test["']/,
    `from "./${CAPTURE_FIXTURE_FILE}"`,
  );
  if (redirected === src) return null; // no direct import to redirect
  const tempPath = path.join(scriptsDir, `${runId}.capture.spec.ts`);
  fs.writeFileSync(tempPath, redirected, "utf-8");
  return tempPath;
}

// Build a map from 1-based spec line number → 0-based step index, by scanning
// the generated spec's test body for indented `await ...` step lines. The
// StepReporter emits `location.line`; this map turns it into a step index the
// renderer can highlight. Returns null when the spec can't be mapped (e.g.
// hand-authored imported scripts with no clean step-per-line structure).
function buildStepLineMap(scriptPath: string): Map<number, number> | null {
  let src: string;
  try {
    src = fs.readFileSync(scriptPath, "utf-8");
  } catch {
    return null;
  }
  const lines = src.split("\n");
  const map = new Map<number, number>();
  let stepIndex = 0;
  let inBody = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The test body starts after the `test("...", async ({ page }) => {` line.
    if (!inBody) {
      if (/^\s*test\s*\(/.test(line) && line.includes("async")) inBody = true;
      continue;
    }
    // Body ends at the closing `});`.
    if (/^\s*}\s*\)/.test(line)) break;
    // Each step is a single indented line starting with `await `.
    if (/^\s+await /.test(line)) {
      map.set(i + 1, stepIndex); // location.line is 1-based
      stepIndex++;
    }
  }
  return map.size > 0 ? map : null;
}

function isChromiumInstalled(): boolean {
  const dir = browsersPath();
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.startsWith("chromium"));
  } catch {
    return false;
  }
}

function baseEnv(nodeModules: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath(),
    NODE_PATH: nodeModules,
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function emitOutput(runId: string, stream: "stdout" | "stderr" | "system", chunk: string): void {
  const buf = logBuffers.get(runId);
  if (buf) buf.push(chunk);
  sendToMain("runner:output", { runId, stream, chunk });
}

// Per-run stdout buffer for splitting `__GLAZE_STEP__:` marker lines out of
// the visible output. Step markers may straddle chunk boundaries, so we hold
// a trailing partial line until the next chunk completes it.
const stdoutBuffers = new Map<string, string>();
const stepLineMaps = new Map<string, Map<number, number> | null>();

// Per-run accumulation of the visible console output (markers stripped), so a
// completed run can be persisted to the run-history log database.
const logBuffers = new Map<string, string[]>();

// Per-run accumulation of per-step pass/fail, keyed by the reporter's step
// index (same index the renderer highlights by). Written to replay.json at run
// end so the replay timeline (Phase 2) has persisted outcome data — the live
// runner:step stream is otherwise ephemeral.
const stepStatusMaps = new Map<string, Record<number, "passed" | "failed">>();

function emitStep(runId: string, index: number, status: "begin" | "end", ok: boolean): void {
  if (status === "end") {
    const map = stepStatusMaps.get(runId);
    if (map) map[index] = ok ? "passed" : "failed";
  }
  sendToMain("runner:step", { runId, index, status, ok });
}

// The Playwright action a step captures a screenshot for (mirrors the fixture's
// PAGE_ACTIONS/LOCATOR_ACTIONS in capture-fixture-source.ts). null → the step
// produces no screenshot (assertions, waits, keyboard press, if/endif). Used to
// match manifest entries to steps by method, so a single classification miss
// can never cascade-desync the whole timeline.
function captureMethod(step: Step): string | null {
  switch (step.type) {
    case "goto":
      return "goto";
    case "click":
      return "click";
    case "fill":
      return "fill";
    case "select":
      return "selectOption";
    case "check":
      return "check";
    case "uncheck":
      return "uncheck";
    case "viewport":
      return "setViewportSize";
    case "press":
      // Only locator.press() is captured; page.keyboard.press() is not.
      return step.locator ? "press" : null;
    default:
      return null;
  }
}

// Correlate the reporter's per-step statuses and the capture manifest against
// the test's Step[] to produce the canonical replay model. All index reconciling
// (reporter step index, action-order screenshot index, Step[] index) happens
// here, once, so the replay UI is a dumb reader.
//
// Status uses two independent, complementary signals — neither alone is
// sufficient for a capture run:
//   • Reporter statuses are authoritative for steps the StepReporter sees —
//     asserts, waits, page-level calls. But the capture fixture WRAPS action
//     methods, so Playwright attributes those wrapped actions' step location to
//     the fixture file and the reporter's file guard drops them. So the wrapped
//     actions (goto/click/fill/…) get NO reporter status on a capture run.
//   • A wrapped action's screenshot is taken only AFTER it resolves, so a
//     screenshot present ⇒ that action ran and passed; the run halts at the
//     first failure, so the failing step is the first uncaptured step after the
//     last screenshot (or a reported failure, whichever comes first).
function buildReplay(params: {
  testId: string;
  runId: string;
  testName: string;
  url?: string;
  status: "passed" | "failed";
  startedAt: number;
  finishedAt: number;
  steps: Step[];
  statuses: Record<number, "passed" | "failed">;
}): RunReplay {
  const shots = artifactStore.readManifest(params.testId, params.runId)?.steps ?? [];

  // Pass 1 — screenshots per step, matched in execution order by method so a
  // non-captured step can never steal the next action's shot.
  let shotPtr = 0;
  const shotByStep: (string | null)[] = params.steps.map((s) => {
    const method = s.type === "if" || s.type === "endif" ? null : captureMethod(s);
    if (method && shotPtr < shots.length && shots[shotPtr].action === method) {
      const entry = shots[shotPtr++];
      return entry.ok ? `${entry.index}.png` : null;
    }
    return null;
  });
  const lastShotIdx = shotByStep.reduce((acc, sc, i) => (sc ? i : acc), -1);

  // Pass 2 — the failing step. A reported failure wins; otherwise, for a failed
  // run, it's the first step past the last screenshot that could actually fail.
  const reportedFail = Object.keys(params.statuses)
    .map(Number)
    .filter((i) => params.statuses[i] === "failed")
    .sort((a, b) => a - b)[0];
  let failedIdx: number | null = null;
  if (reportedFail !== undefined) {
    failedIdx = reportedFail;
  } else if (params.status === "failed") {
    const cand = params.steps.findIndex(
      (s, i) => i > lastShotIdx && s.type !== "if" && s.type !== "endif",
    );
    failedIdx = cand >= 0 ? cand : lastShotIdx >= 0 ? lastShotIdx : params.steps.length ? 0 : null;
  }

  // Pass 3 — status per step, reconciling both signals.
  const steps: ReplayStep[] = params.steps.map((s, i) => {
    const isControl = s.type === "if" || s.type === "endif";
    let status: ReplayStepStatus;
    if (isControl) status = "skipped";
    else if (params.statuses[i]) status = params.statuses[i];
    else if (shotByStep[i]) status = "passed";
    else if (failedIdx !== null && i === failedIdx) status = "failed";
    else if (failedIdx !== null && i > failedIdx) status = "skipped";
    else status = "passed";
    return {
      index: i,
      stepId: s.id,
      label: describeStep(s),
      type: s.type,
      status,
      screenshot: shotByStep[i],
    };
  });
  const failedIndex = steps.find((s) => s.status === "failed")?.index ?? null;
  return {
    testId: params.testId,
    runId: params.runId,
    testName: params.testName,
    url: params.url,
    status: params.status,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    failedIndex,
    steps,
  };
}

// Phase 3 — visual-diff enrichment. For each captured step, compare its
// screenshot against the PINNED baseline (keyed by Step.id, not URL). If no
// baseline exists yet, this run's shot seeds it ("new-baseline"). Mutates each
// step's `diff`. Best-effort: any failure degrades to "unable" — a diff must
// never throw into the run's finally block or false-flag a change.
function enrichWithVisualDiffs(replay: RunReplay, threshold: number): void {
  replay.visualThreshold = threshold;
  for (const step of replay.steps) {
    if (!step.screenshot) continue; // asserts/waits/skipped — nothing to compare
    const next = artifactStore.readShot(replay.testId, replay.runId, step.screenshot);
    if (!next) {
      step.diff = { state: "unable", reason: "screenshot unreadable", threshold };
      continue;
    }
    if (!baselineStore.has(replay.testId, step.stepId)) {
      // First captured run for this step — seed the pinned baseline.
      baselineStore.set(replay.testId, step.stepId, next, {
        runId: replay.runId,
        label: step.label,
      });
      step.diff = { state: "new-baseline", threshold };
      continue;
    }
    const baseline = baselineStore.readShot(replay.testId, step.stepId);
    if (!baseline) {
      step.diff = { state: "unable", reason: "baseline unreadable", threshold };
      continue;
    }
    const outcome = diffPngBuffers(baseline, next, threshold);
    if (outcome.state === "unable") {
      step.diff = { state: "unable", reason: outcome.reason, threshold };
    } else if (outcome.state === "changed") {
      const shotIndex = Number.parseInt(step.screenshot, 10);
      const diffFile = artifactStore.writeDiff(replay.testId, replay.runId, shotIndex, outcome.diffPng);
      step.diff = { state: "changed", ratio: outcome.ratio, threshold, diffFile };
    } else {
      step.diff = { state: "match", ratio: outcome.ratio, threshold };
    }
  }
}

// Parse a stdout chunk: extract complete `__GLAZE_STEP__:` lines, map their
// line number to a step index, emit `runner:step` events, and return the
// remaining visible text (markers stripped).
function processStdout(runId: string, chunk: string): string {
  const map = stepLineMaps.get(runId);
  if (!map) return chunk; // no step mapping for this run — pass through

  const buf = (stdoutBuffers.get(runId) ?? "") + chunk;
  const lines = buf.split("\n");
  // Last element is the partial trailing line (no trailing newline) — hold it.
  stdoutBuffers.set(runId, lines.pop() ?? "");

  let visible = "";
  for (const line of lines) {
    if (line.startsWith("__GLAZE_STEP__:")) {
      try {
        const payload = JSON.parse(line.slice("__GLAZE_STEP__:".length));
        const stepIndex = map.get(payload.line);
        if (typeof stepIndex === "number") {
          emitStep(runId, stepIndex, payload.event, payload.ok ?? true);
        }
      } catch {
        // ignore malformed marker
      }
    } else {
      visible += line + "\n";
    }
  }
  return visible;
}

function runCli(
  runId: string,
  args: string[],
  cliPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env });
    runs.set(runId, { child, testId: runId });

    const timer = setTimeout(() => {
      emitOutput(runId, "system", "\nTimed out — stopping test run.\n");
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      const visible = processStdout(runId, d.toString());
      if (visible) emitOutput(runId, "stdout", visible);
    });
    child.stderr?.on("data", (d: Buffer) => emitOutput(runId, "stderr", d.toString()));
    child.on("error", (err) => {
      emitOutput(runId, "system", "\nFailed to start Playwright: " + String(err) + "\n");
    });
    child.on("close", (code) => {
      // Flush any remaining buffer (treat trailing partial as visible output).
      const tail = stdoutBuffers.get(runId);
      if (tail) {
        const visible = processStdout(runId, "\n");
        if (visible) emitOutput(runId, "stdout", visible);
      }
      stdoutBuffers.delete(runId);
      stepLineMaps.delete(runId);
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

export const playwrightRunner = {
  isBrowserInstalled(): boolean {
    return isChromiumInstalled();
  },

  /** Start a run. Returns immediately; progress streams over runner:* events.
   *
   * When `captureArtifacts` is set (the per-run visual-testing gate, off by
   * default) AND the test is app-generated, the run captures a screenshot after
   * every page action into <userData>/recorder/artifacts/<testId>/<runId>/ via
   * the glaze-capture fixture (see capture-fixture-source.ts). `runId` here is
   * the live-stream key (=== testId); the persisted RunRecord/artifact id is a
   * fresh uuid so a test's runs don't overwrite each other's artifacts. */
  start(params: {
    testId: string;
    headed: boolean;
    captureArtifacts?: boolean;
  }): { runId: string } {
    const captureArtifacts = params.captureArtifacts ?? false;
    const runId = params.testId;
    if (runs.has(runId)) {
      return { runId };
    }

    const rec = testStore.get(params.testId);
    if (!rec) {
      throw new Error("Test not found: " + params.testId);
    }

    const startedAt = Date.now();
    // Unique per execution — names the artifacts dir and (below) the RunRecord,
    // so Stats/logs/artifacts all join on one id.
    const recordId = randomUUID();
    logBuffers.set(runId, []);
    stepStatusMaps.set(runId, {});

    void (async () => {
      let exitCode = -1;
      let tempSpecPath: string | null = null;
      let capturingRun = false;
      try {
        const { cliPath, nodeModules } = resolvePlaywright();
        const scriptsDir = getScriptsDir();
        ensureModuleResolution(scriptsDir, nodeModules);
        const configPath = ensureConfig(scriptsDir);
        const reporterPath = ensureReporter(scriptsDir);
        const env = baseEnv(nodeModules);

        // Decide whether this run actually captures. Gate BEFORE any capture
        // work so an off run (or an imported test) pays nothing. Imported specs
        // are their own source of truth and aren't guaranteed one-action-per-
        // line, so — like step highlighting — capture is app-generated only.
        let specToRun = rec.scriptPath;
        let capturing = false;
        let artifactDir = "";
        if (captureArtifacts && !rec.sourceDir) {
          ensureCaptureFixture(scriptsDir);
          const prepared = prepareCaptureSpec(scriptsDir, rec.scriptPath, recordId);
          if (prepared) {
            tempSpecPath = prepared;
            specToRun = prepared;
            capturing = true;
            capturingRun = true;
            // Prune old runs first, then create this run's dir (newest).
            artifactStore.pruneRuns(rec.id, Math.max(0, DEFAULT_RETAINED_RUNS - 1));
            artifactDir = artifactStore.ensureRunDir(rec.id, recordId);
          } else {
            emitOutput(
              runId,
              "system",
              "Capture skipped: this test doesn't import @playwright/test directly.\n",
            );
          }
        }

        // Map spec line numbers → step indices so the StepReporter's markers
        // can be translated into highlightable step indices for the renderer.
        // (The redirected capture spec preserves line numbers.)
        stepLineMaps.set(runId, buildStepLineMap(specToRun));

        if (!isChromiumInstalled()) {
          emitOutput(runId, "system", "Installing the test browser (first run only)…\n");
          await runCli(runId, ["install", "chromium"], cliPath, scriptsDir, env);
        }

        const slowMo = SLOW_MO_MS[rec.speed ?? "fast"];
        emitOutput(runId, "system", "Running " + path.basename(rec.scriptPath) + "…\n");
        if (capturing) emitOutput(runId, "system", "Capturing screenshots for this run.\n");
        // Use our custom StepReporter (emits per-step progress markers) plus
        // the built-in `line` reporter for the human-readable Output panel.
        const args = [
          "test",
          specToRun,
          "--config",
          configPath,
          "--reporter",
          `${reporterPath},line`,
          "--workers=1",
        ];
        if (params.headed) args.push("--headed");
        exitCode = await runCli(runId, args, cliPath, scriptsDir, {
          ...env,
          PW_SLOWMO_MS: String(slowMo),
          GLAZE_CAPTURE_ARTIFACTS: capturing ? "1" : "0",
          GLAZE_ARTIFACT_DIR: artifactDir,
          GLAZE_TEST_ID: rec.id,
          GLAZE_RUN_ID: recordId,
        });
      } catch (err) {
        emitOutput(runId, "system", "\nError: " + String(err) + "\n");
      } finally {
        runs.delete(runId);
        // Remove the temp capture spec (best-effort).
        if (tempSpecPath) {
          try {
            fs.rmSync(tempSpecPath, { force: true });
          } catch {
            /* ignore */
          }
        }
        const finishedAt = Date.now();
        const runStatus = exitCode === 0 ? "passed" : "failed";

        // When this run captured artifacts, persist the canonical replay model
        // (per-step outcome + screenshot mapping) alongside them, keyed by the
        // same runId so the Phase 2 timeline can retrieve it.
        const statuses = stepStatusMaps.get(runId) ?? {};
        stepStatusMaps.delete(runId);
        if (capturingRun) {
          try {
            const replay = buildReplay({
              testId: rec.id,
              runId: recordId,
              testName: rec.name,
              url: rec.url,
              status: runStatus,
              startedAt,
              finishedAt,
              steps: rec.steps,
              statuses,
            });
            // Phase 3 — diff each captured shot against the pinned baseline.
            enrichWithVisualDiffs(replay, rec.visualThreshold ?? DEFAULT_VISUAL_THRESHOLD);
            artifactStore.writeReplay(rec.id, recordId, replay);
          } catch (err) {
            logger.warn("runner", "Failed to persist replay model", { err: String(err) });
          }
        }

        // Persist this run to the log database (metadata + raw output). The
        // record id === the artifacts runId so later phases can join them.
        const logText = (logBuffers.get(runId) ?? []).join("");
        logBuffers.delete(runId);
        try {
          runHistoryStore.append(
            {
              id: recordId,
              testId: rec.id,
              testName: rec.name,
              url: rec.url,
              status: runStatus,
              exitCode,
              startedAt,
              finishedAt,
              captureArtifacts,
            },
            logText,
          );
          sendToMain("runs:changed", {});
        } catch (err) {
          logger.warn("runner", "Failed to persist run history", { err: String(err) });
        }
        sendToMain("runner:done", { runId, code: exitCode });
      }
    })();

    return { runId };
  },

  stop(runId: string): void {
    const handle = runs.get(runId);
    if (handle) {
      handle.child.kill("SIGKILL");
      runs.delete(runId);
    }
  },

  isRunning(runId: string): boolean {
    return runs.has(runId);
  },
};
