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
import { recorderSettingsStore } from "./recorder-settings-store.js";
import { notifyRunOutcome } from "./run-notifier.js";
import { sendAlert } from "./alert-service.js";
import { applyRetention } from "./retention.js";
import { buildReplay, enrichWithVisualDiffs } from "./replay-builder.js";
import { DEFAULT_VISUAL_THRESHOLD } from "../recorder/types.js";
import { generateSpec } from "./script-generator.js";
import type { RunBrowser, Step, TestSpeed } from "../recorder/types.js";

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

/** Completion promises for runs currently in flight, keyed by runId, resolving
 *  to the Playwright exit code. `runs` only holds an entry while the child
 *  process is alive — it's empty during setup (browser install, spec
 *  generation) and after the process exits but before the RunRecord is
 *  persisted — so it can't be used to await a whole run. Batch runs need
 *  exactly that, hence this second map. */
const inFlight = new Map<string, Promise<number>>();

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

/** Playwright unpacks each engine into `<browsersPath>/<engine>-<revision>`.
 *  Chromium additionally ships a `chromium_headless_shell-*` directory, which
 *  is NOT a usable headed browser — so match the engine prefix followed by "-"
 *  rather than a bare `startsWith`, or a headless-shell-only install would be
 *  mistaken for a full one and the run would fail at launch. */
function isBrowserInstalled(browser: RunBrowser): boolean {
  const dir = browsersPath();
  try {
    return (
      fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.startsWith(`${browser}-`))
    );
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
  /** Is the engine a run would use already downloaded? Defaults to the
   *  global setting's engine when none is named. */
  isBrowserInstalled(browser?: RunBrowser): boolean {
    return isBrowserInstalled(browser ?? recorderSettingsStore.get().defaultRunBrowser);
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
    runHeadless?: boolean;
    /** Browser engine to run on. Falls back to the test's saved preference,
     *  then the global default. */
    browser?: RunBrowser;
    /** Re-execute the steps a PAST run recorded, instead of the test's current
     *  script. The new run is tagged with this id so the two can be compared. */
    replayOfRunId?: string;
    /** id of the batch driving this run, when it's part of one. Recorded on the
     *  RunRecord so a persisted batch can be joined back to its runs. */
    batchId?: string;
  }): { runId: string; recordId?: string; alreadyRunning?: boolean } {
    const captureArtifacts = params.captureArtifacts ?? false;
    const runHeadless = params.runHeadless ?? false;
    const runId = params.testId;
    if (runs.has(runId)) {
      // No new run was started. Say so explicitly: `inFlight` still holds the
      // IN-PROGRESS run's promise, so a caller that fell back to waitFor(runId)
      // would silently await someone else's run — one started with different
      // browser/headless/capture options and no batchId — and report its exit
      // code as its own result.
      return { runId, alreadyRunning: true };
    }

    const rec = testStore.get(params.testId);
    if (!rec) {
      throw new Error("Test not found: " + params.testId);
    }

    // Explicit choice → the test's saved preference → the global default.
    const runBrowser: RunBrowser =
      params.browser ?? rec.runBrowser ?? recorderSettingsStore.get().defaultRunBrowser;

    // Re-running a past run replays THAT run's recorded steps — the test may
    // have been edited since, and the point is to reproduce what happened.
    const replayOfRunId = params.replayOfRunId;
    let replaySteps: Step[] | null = null;
    if (replayOfRunId) {
      replaySteps = artifactStore.readSteps<Step>(params.testId, replayOfRunId);
      if (!replaySteps || replaySteps.length === 0) {
        throw new Error(
          "That run predates step snapshots, so it can't be re-run. Capture a new run first.",
        );
      }
    }
    // Which steps this execution correlates its results against.
    const runSteps: Step[] = replaySteps ?? rec.steps;

    const startedAt = Date.now();
    // Unique per execution — names the artifacts dir and (below) the RunRecord,
    // so Stats/logs/artifacts all join on one id.
    const recordId = randomUUID();
    logBuffers.set(runId, []);
    stepStatusMaps.set(runId, {});

    const done = (async () => {
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

        // Re-running a past run: generate a spec from ITS recorded steps rather
        // than the test's current script, so an edit since then can't change
        // what gets reproduced.
        if (replaySteps) {
          const replaySpecPath = path.join(scriptsDir, `${recordId}.replay.spec.ts`);
          fs.writeFileSync(
            replaySpecPath,
            generateSpec({ name: rec.name, url: rec.url, steps: replaySteps }),
            "utf-8",
          );
          tempSpecPath = replaySpecPath;
          specToRun = replaySpecPath;
        }
        if (captureArtifacts && !rec.sourceDir) {
          ensureCaptureFixture(scriptsDir);
          const prepared = prepareCaptureSpec(scriptsDir, specToRun, recordId);
          if (prepared) {
            tempSpecPath = prepared;
            specToRun = prepared;
            capturing = true;
            capturingRun = true;
            // Prune old runs first, then create this run's dir (newest). The
            // retained count is user-configurable in Settings; `- 1` leaves
            // room for the run about to be created, so the on-disk total after
            // this run equals the configured number.
            const settings = recorderSettingsStore.get();
            const keep = settings.artifactRetainedRuns ?? DEFAULT_RETAINED_RUNS;
            const days = settings.artifactRetentionDays ?? 0;
            artifactStore.pruneRuns(
              rec.id,
              Math.max(0, keep - 1),
              days > 0 ? days * 24 * 60 * 60 * 1000 : 0,
            );
            artifactDir = artifactStore.ensureRunDir(rec.id, recordId);
            // Snapshot exactly what this run executes, so it can be re-run
            // later even if the test is edited in the meantime.
            artifactStore.writeSteps(rec.id, recordId, runSteps);
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

        // Each engine is downloaded on its own first use — switching browsers
        // costs one install, not a re-download of everything.
        if (!isBrowserInstalled(runBrowser)) {
          emitOutput(
            runId,
            "system",
            `Installing ${runBrowser} (first run on this browser)…\n`,
          );
          await runCli(runId, ["install", runBrowser], cliPath, scriptsDir, env);
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
        // The generated config defines no projects, so --browser selects the
        // engine directly (with projects it would be ignored in favor of them).
        args.push(`--browser=${runBrowser}`);
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
        // Filled in from the replay when capturing, so the notification can
        // mention visual changes and name the failing step.
        let changedSteps = 0;
        let failedLabel: string | undefined;
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
              steps: runSteps,
              statuses,
            });
            // Phase 3 — diff each captured shot against the pinned baseline.
            enrichWithVisualDiffs(
              replay,
              rec.visualThreshold ?? DEFAULT_VISUAL_THRESHOLD,
              rec.visualMasks ?? [],
              rec.visualElementSteps ?? [],
            );
            artifactStore.writeReplay(rec.id, recordId, replay);
            changedSteps = replay.steps.filter((st) => st.diff?.state === "changed").length;
            if (replay.failedIndex !== null) {
              failedLabel = replay.steps[replay.failedIndex]?.label;
            }
          } catch (err) {
            logger.warn("runner", "Failed to persist replay model", { err: String(err) });
          }
        }

        // Persist this run to the log database (metadata + raw output). The
        // record id === the artifacts runId so later phases can join them.
        const logText = (logBuffers.get(runId) ?? []).join("");
        logBuffers.delete(runId);
        // What capture actually cost this run, straight from the fixture's
        // manifest. Absent for non-capture runs and pre-instrumentation ones.
        let captureOverheadMs: number | undefined;
        let shotCount: number | undefined;
        if (capturingRun) {
          const manifest = artifactStore.readManifest(rec.id, recordId);
          captureOverheadMs = manifest?.captureMs;
          shotCount = manifest?.shotCount ?? manifest?.steps.length;
        }
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
              runHeadless,
              runBrowser,
              batchId: params.batchId,
              captureOverheadMs,
              shotCount,
              replayOfRunId,
            },
            logText,
          );
          sendToMain("runs:changed", {});
        } catch (err) {
          logger.warn("runner", "Failed to persist run history", { err: String(err) });
        }
        // Sweep artifacts against retention after every run — including
        // non-capture ones, so the rules apply even when this test isn't the
        // one generating screenshots.
        applyRetention();
        // Local desktop notification for a failure or a visual change, when the
        // user opted in. Never fires for a clean run.
        if (recorderSettingsStore.get().notifyOnRunIssues) {
          notifyRunOutcome({
            testName: rec.name,
            status: runStatus,
            changedSteps,
            failedLabel,
          });
        }
        // Outgoing webhook alert (off by default, summary only, never throws).
        // Skipped for runs inside a batch — the batch sends one alert for the
        // whole suite instead of one per test.
        if (!params.batchId) {
          void sendAlert({
            kind: "run",
            testName: rec.name,
            status: runStatus,
            changedSteps,
            failedLabel,
            durationMs: Math.max(0, finishedAt - startedAt),
            browser: runBrowser,
          });
        }
        sendToMain("runner:done", { runId, code: exitCode });
      }
      return exitCode;
    })();
    // Never rejects: the IIFE catches everything and reports via runner:output,
    // so an awaiting batch sees a non-zero exit code rather than a rejection.
    inFlight.set(runId, done);
    void done.finally(() => {
      // Only clear if this is still the promise we registered — a fast
      // sequential batch can start the same test again before this settles.
      if (inFlight.get(runId) === done) inFlight.delete(runId);
    });

    return { runId, recordId };
  },

  /** Resolve when the given run finishes, with its Playwright exit code
   *  (0 = passed). Resolves to null if that run isn't in flight — either it
   *  already finished or it never started. */
  waitFor(runId: string): Promise<number> | null {
    return inFlight.get(runId) ?? null;
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
