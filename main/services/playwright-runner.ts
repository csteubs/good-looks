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
import { resolveTestTimeoutMs, SLOW_MO_MS } from "./run-pacing.js";
import { notifyRunOutcome, shouldNotifyRun } from "./run-notifier.js";
import { sendAlert } from "./alert-service.js";
import { applyRetention } from "./retention.js";
import { buildReplay, enrichWithA11y, enrichWithVisualDiffs } from "./replay-builder.js";
import { describeA11yOutcome } from "./a11y-diff.js";
import { DEFAULT_VISUAL_THRESHOLD } from "../recorder/types.js";
import { generateSpec, generateSpecDetailed, secretEnvName } from "./script-generator.js";
import { GLAZE_RUNTIME_FILE, glazeRuntimeSource } from "./glaze-runtime-source.js";
import { PLAYWRIGHT_CONFIG_SOURCE } from "./playwright-config-source.js";
import { HEAL_FIXTURE_FILE, healFixtureSource } from "./heal-fixture-source.js";
import { SETTLE_FIXTURE_FILE, settleFixtureSource } from "./settle-fixture-source.js";
import { buildHealProbeScript } from "./auto-heal.js";
import { healJournalStore } from "./heal-journal-store.js";
import { describeStep } from "./script-generator.js";
import { testSecretsStore } from "./test-secrets-store.js";
import { refreshSecretSnapshot, redactWithSnapshot } from "./secret-redaction.js";
import type {
  HealApplyMode,
  HealCandidate,
  Locator,
  RunBrowser,
  Step,
  TestRecord,
  TestSpeed,
  TestVariable,
} from "../recorder/types.js";

// Module Playwright specs import test/expect from — redirected to the capture
// fixture for a run that captures artifacts.
const CAPTURE_FIXTURE_FILE = "glaze-capture.mjs";

/** Resolve a `runFlow` step's target for the generator. Flows are ordinary
 *  TestRecords, so this is just a store lookup — but it's named here so the
 *  three generation sites in this file can't disagree about what a flow is. */
function resolveFlow(flowId: string): TestRecord | null {
  return testStore.get(flowId) ?? null;
}

/** Floor on the hard process kill. Independent of the per-test timeout so a
 *  short test timeout never leaves a hung install/browser-download with only a
 *  few seconds of runway. */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** Extra time past the per-test timeout before SIGKILL — covers browser launch,
 *  reporter teardown, and Playwright's own cleanup after a test timeout. */
const PROCESS_TIMEOUT_BUFFER_MS = 60_000;


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

/** Path to axe-core's bundled build, for injection into the page under test.
 *  Resolved from the same node_modules the Playwright CLI came from, so it
 *  can't pick up a different copy than the one this app installed. */
function axePath(nodeModules: string): string {
  return path.join(nodeModules, "axe-core", "axe.min.js");
}

/** Serial number for temp filenames, so two atomic writes in the same process
 *  can never pick the same scratch path. */
let tmpSeq = 0;

/**
 * Write a file only when its content would actually change, and atomically when
 * it would.
 *
 * Every `ensure*` helper below rewrites a file SHARED by every run, on every
 * run — while other runs' Playwright processes may be reading it. Truncate-then-
 * write is not atomic, so a concurrent reader could see a half-written config or
 * fixture; renaming into place is, and the content of these files is fixed per
 * app build, so after the first run of a session this writes nothing at all.
 */
function writeIfChanged(filePath: string, content: string): void {
  try {
    if (fs.readFileSync(filePath, "utf-8") === content) return;
  } catch {
    // Missing or unreadable — fall through and write it.
  }
  const tmp = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
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

// Contents live in playwright-config-source.ts — see there for why, and for
// what each env-driven field is for.
function ensureConfig(scriptsDir: string): string {
  const configPath = path.join(scriptsDir, "playwright.config.ts");
  writeIfChanged(configPath, PLAYWRIGHT_CONFIG_SOURCE);
  return configPath;
}

// Write the StepReporter next to the specs so the Playwright CLI can load it.
// Always rewritten so it stays in sync with the app's current build.
function ensureReporter(scriptsDir: string): string {
  const reporterPath = path.join(scriptsDir, "step-reporter.mjs");
  writeIfChanged(reporterPath, stepReporterSource);
  return reporterPath;
}

// Write the capture fixture (glaze-capture.mjs) next to the specs so a
// capture run's redirected spec can import it. Always rewritten to stay in sync
// with the app build.
function ensureCaptureFixture(scriptsDir: string): void {
  writeIfChanged(path.join(scriptsDir, CAPTURE_FIXTURE_FILE), captureFixtureSource);
}

// Write the spec runtime helper (glaze-runtime.mjs) next to the specs, for
// specs with a `capture` step. Unconditional and always rewritten, like the
// reporter: it's a few hundred bytes, and writing it only when a capture step
// exists would mean a test that gains one mid-session runs against a missing
// module until the next app start.
function ensureRuntime(scriptsDir: string): void {
  writeIfChanged(path.join(scriptsDir, GLAZE_RUNTIME_FILE), glazeRuntimeSource);
}

// Write the run-time heal fixture. Always written alongside the capture
// fixture, which imports it unconditionally — a missing module would fail the
// import even on a run with healing switched off.
function ensureHealFixture(scriptsDir: string): void {
  writeIfChanged(path.join(scriptsDir, HEAL_FIXTURE_FILE), healFixtureSource);
}

// Write the "crawl" page-settling fixture. Unconditional for the same reason as
// the heal fixture: the capture fixture imports it at the top of the module, so
// a run with settling OFF still has to be able to resolve the file.
function ensureSettleFixture(scriptsDir: string): void {
  writeIfChanged(path.join(scriptsDir, SETTLE_FIXTURE_FILE), settleFixtureSource);
}

/** The canonical key the heal fixture tags a locator with. MUST match the
 *  `FACTORIES` table in heal-fixture-source.ts — if the two spellings drift,
 *  every lookup misses and healing silently stops happening with no error. */
export function healKeyFor(loc: Locator): string {
  switch (loc.k) {
    case "testid":
      return `testid|${loc.v ?? ""}`;
    case "label":
      return `label|${loc.v ?? ""}`;
    case "placeholder":
      return `placeholder|${loc.v ?? ""}`;
    case "text":
      return `text|${loc.v ?? ""}`;
    case "role":
      return `role|${loc.role ?? ""}|${loc.name ?? ""}`;
    case "xpath":
      return `css|xpath=${loc.v ?? ""}`;
    case "css":
    default:
      return `css|${loc.v ?? ""}`;
  }
}

/**
 * Build the heal map the run-time fixture reads: canonical locator key → the
 * step's identity plus a pre-built probe script.
 *
 * The probe is built HERE, with `buildHealProbeScript` — the same function the
 * trainer uses. The fixture only evaluates it. That's deliberate: two
 * implementations of candidate ranking would drift, and the ranking is where
 * every Auto-Heal bug so far has lived.
 */
export function buildHealMap(steps: Step[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  steps.forEach((step, index) => {
    if (!step.locator || step.disabled) return;
    const key = healKeyFor(step.locator);
    // First step wins on a collision. Two steps with an identical locator act
    // on the same element, so they'd share a fingerprint anyway.
    if (map[key]) return;
    map[key] = {
      stepId: step.id,
      stepIndex: index,
      stepLabel: describeStep(step),
      locator: step.locator,
      probe: buildHealProbeScript(step, []),
    };
  });
  return map;
}

/** Environment carrying this run's variable values into the spec.
 *
 *  Two channels on purpose. Plain values (including a dataset row) go as one
 *  JSON blob the spec spreads over its declared defaults. Secrets go one env
 *  var each, and are NEVER put in the JSON blob: the blob is a single string
 *  that would show up whole in a crash dump or a process listing, and it is
 *  also the thing a future feature is most likely to log. */
async function variableEnv(
  testId: string,
  vars: Record<string, string> | undefined,
  variables: TestVariable[],
): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = {};
  if (vars && Object.keys(vars).length > 0) out.GLAZE_VARS = JSON.stringify(vars);
  const secretNames = variables.filter((v) => v.kind === "secret").map((v) => v.name);
  if (secretNames.length === 0) return out;
  const stored = await testSecretsStore.valuesFor(testId);
  for (const name of secretNames) {
    // A declared-but-unset secret becomes an empty string rather than being
    // left undefined, so the spec's `?? ""` fallback is what runs and the
    // failure is "the field was empty", not "process.env is missing a key".
    out[secretEnvName(name)] = stored[name] ?? "";
  }
  return out;
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

/**
 * The authoritative line→step map for an app-generated spec: ask the generator,
 * which is the only thing that knows which step produced which line.
 *
 * `buildStepLineMap` below infers the mapping by counting `await` lines, which
 * is right only when every step emits exactly one such line. It isn't: an `if`
 * step emits `if (...) {`, a disabled step emits a comment, and an inlined flow
 * emits several lines for one step — each of which shifts every later step's
 * highlight and screenshot attribution silently.
 *
 * Returns null for a hand-edited or imported spec, where the stored steps no
 * longer describe the file and the regex scan is the only option left.
 */
function generatedStepLineMap(
  rec: TestRecord,
  steps: Step[],
  resolveFlow: (flowId: string) => TestRecord | null,
): Map<number, number> | null {
  if (rec.scriptEdited || rec.sourceDir) return null;
  try {
    const { lineMap } = generateSpecDetailed(
      { name: rec.name, url: rec.url, steps, variables: rec.variables },
      { resolveFlow },
    );
    const map = new Map<number, number>();
    for (const [line, index] of Object.entries(lineMap)) map.set(Number(line), index);
    return map.size > 0 ? map : null;
  } catch (err) {
    logger.warn("runner", "Could not build the generated step map", { err: String(err) });
    return null;
  }
}

// Build a map from 1-based spec line number → 0-based step index, by scanning
// the generated spec's test body for indented `await ...` step lines. The
// StepReporter emits `location.line`; this map turns it into a step index the
// renderer can highlight. Returns null when the spec can't be mapped (e.g.
// hand-authored imported scripts with no clean step-per-line structure).
//
// Fallback only — see `generatedStepLineMap` for why.
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

/** Browser installs currently in flight, keyed by engine.
 *
 *  Parallel batches make this load-bearing. Several runs can discover the same
 *  missing engine at the same moment, and N concurrent `playwright install`
 *  processes unpacking into ONE directory is how you end up with a half-written
 *  browser that then fails to launch for every run after it. First caller
 *  installs; the rest await the same promise. */
const installs = new Map<RunBrowser, Promise<unknown>>();

async function installBrowser(
  runId: string,
  browser: RunBrowser,
  cliPath: string,
  scriptsDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const inProgress = installs.get(browser);
  if (inProgress) {
    // Said out loud, because the install's own output is streaming to a
    // DIFFERENT run's Output panel — without this line, this run just sits
    // there for a minute with nothing printed.
    emitOutput(runId, "system", `Waiting for ${browser} to finish installing…\n`);
    await inProgress;
    return;
  }
  emitOutput(runId, "system", `Installing ${browser} (first run on this browser)…\n`);
  const pending = runCli(runId, ["install", browser], cliPath, scriptsDir, env);
  installs.set(browser, pending);
  try {
    await pending;
  } finally {
    installs.delete(browser);
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

/**
 * Read the heals a finished run performed, write them to the journal, and
 * return how many there were.
 *
 * Under "suggest" (the default) nothing is written back to the test: the run
 * used the healed locator in memory to get past the step, and the journal entry
 * is the user's record of that plus the means to apply or dismiss it. Under
 * "apply" the step's locator is updated here, on the backend, because the child
 * process has no business writing to tests.json.
 */
function collectRunHeals(
  testId: string,
  runId: string,
  healDir: string,
  mode: HealApplyMode,
): number {
  if (!healDir) return 0;
  const file = path.join(healDir, "heals.json");
  let events: {
    stepId: string;
    stepIndex: number;
    stepLabel: string;
    originalLocator?: Locator;
    appliedLocator: Locator;
    candidates?: HealCandidate[];
  }[] = [];
  try {
    events = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return 0; // no heals (the common case) — the fixture only writes on a heal
  }
  if (!Array.isArray(events) || events.length === 0) return 0;

  const apply = mode === "apply";
  const rec = apply ? testStore.get(testId) : null;
  let changed = false;
  for (const ev of events) {
    try {
      healJournalStore.record({
        testId,
        stepId: ev.stepId,
        stepIndex: ev.stepIndex,
        stepLabel: ev.stepLabel,
        source: "run",
        runId,
        originalLocator: ev.originalLocator,
        appliedLocator: ev.appliedLocator,
        candidates: ev.candidates ?? [],
        applied: apply,
      });
    } catch (err) {
      logger.warn("runner", "Could not journal a run heal", { err: String(err) });
    }
    if (rec) {
      const idx = rec.steps.findIndex((st) => st.id === ev.stepId);
      if (idx >= 0) {
        rec.steps[idx] = { ...rec.steps[idx], locator: ev.appliedLocator };
        changed = true;
      }
    }
  }
  if (rec && changed) {
    try {
      rec.updatedAt = Date.now();
      if (!rec.scriptEdited) rec.scriptPath = testStore.regenerateScript(rec);
      testStore.save(rec);
    } catch (err) {
      logger.warn("runner", "Could not persist applied heals", { err: String(err) });
    }
  }
  try {
    fs.rmSync(healDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  logger.info("runner", "Run healed steps", { testId, runId, count: events.length, apply });
  return events.length;
}

/** CSI escape sequences — Playwright's `line` reporter redraws its progress
 *  line with cursor-up + erase-line, and colours failures.
 *
 *  Stripped at the same choke point as redaction, for the same reason: these
 *  bytes are meaningless outside a terminal, and all three consumers suffer
 *  from them. The Output panel renders them as visible mojibake (`⌧[1A⌧[2K`),
 *  the log file keeps them forever, and — worst — they are sent verbatim to
 *  the model in the Debug-with-AI prompt, where they spend context on cursor
 *  movements and give the model garbage to reason about. */
// Built from a char code rather than a regex literal: ESC is a control
// character, and `no-control-regex` rejects it inline. Disabling that rule
// here would also disable it for anything added to this file later.
const ANSI_ESCAPE = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

function emitOutput(runId: string, stream: "stdout" | "stderr" | "system", chunk: string): void {
  // Redact HERE, at the single point every byte of run output passes through,
  // rather than at each consumer. The live stream feeds the Output panel and
  // (via Debug with AI) the prompt sent to a hosted LLM; the buffer feeds the
  // log file. Redacting downstream would mean getting all three right, forever.
  //
  // Chunk-boundary caveat: a secret split across two chunks survives this. The
  // buffered log is redacted again on write, which catches those; the live
  // stream can't be, since it has already been sent.
  const safe = stripAnsi(redactWithSnapshot(chunk));
  const buf = logBuffers.get(runId);
  if (buf) buf.push(safe);
  sendToMain("runner:output", { runId, stream, chunk: safe });
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
  /** Hard kill for the whole Playwright process. Must be comfortably above the
   *  per-test timeout or the process dies before Playwright can report a clean
   *  test-timeout failure. */
  processTimeoutMs: number = RUN_TIMEOUT_MS,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env });
    runs.set(runId, { child, testId: runId });

    const timer = setTimeout(() => {
      emitOutput(runId, "system", "\nTimed out — stopping test run.\n");
      child.kill("SIGKILL");
    }, processTimeoutMs);

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
    /** Variable values for this execution, injected as GLAZE_VARS and spread
     *  over the spec's declared defaults. This is how one spec runs once per
     *  dataset row without being regenerated. Secrets are NOT passed here —
     *  they're read from the encrypted store, so a caller can't inject one. */
    vars?: Record<string, string>;
    /** The dataset row this run represents, recorded on the RunRecord so run
     *  history can say WHICH row failed. */
    datasetId?: string;
    datasetName?: string;
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
    // Resolved out here rather than inside the run body because the RunRecord
    // is written from the `finally`, which cannot see into the `try`.
    const speed: TestSpeed = rec.speed ?? "fast";

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
      // Playwright's own scratch dir (traces, failure screenshots). Per-run
      // rather than the shared default: it is derived from the SPEC's path, so
      // two concurrent runs of one spec would write to — and clean — the same
      // folder. Nothing in the app reads it (our artifacts go to artifactStore
      // via GLAZE_ARTIFACT_DIR), so it's removed in the finally rather than
      // accumulating one directory per run forever.
      let outputDir = "";
      // Declared out here because the finally block reads them: everything
      // below is set inside the try, which the finally cannot see into.
      let checkedAccessibility = false;
      let healDir = "";
      let healMapPath = "";
      let healApplyMode: HealApplyMode = "suggest";
      try {
        const { cliPath, nodeModules } = resolvePlaywright();
        const scriptsDir = getScriptsDir();
        outputDir = path.join(scriptsDir, "test-results", recordId);
        ensureModuleResolution(scriptsDir, nodeModules);
        const configPath = ensureConfig(scriptsDir);
        const reporterPath = ensureReporter(scriptsDir);
        ensureRuntime(scriptsDir);
        const env = baseEnv(nodeModules);
        // Refresh the redaction snapshot BEFORE the run: the log this run
        // produces is redacted synchronously when it's persisted, so the
        // snapshot has to already know every secret the run could expose.
        await refreshSecretSnapshot();
        const varEnv = await variableEnv(rec.id, params.vars, rec.variables ?? []);

        // Decide whether this run actually captures. Gate BEFORE any capture
        // work so an off run (or an imported test) pays nothing. Imported specs
        // are their own source of truth and aren't guaranteed one-action-per-
        // line, so — like step highlighting — capture is app-generated only.
        let specToRun = rec.scriptPath;
        let capturing = false;
        let artifactDir = "";

        // Run-time Auto-Heal, gated independently of capture. Imported specs are
        // excluded for the same reason capture is: the heal map is keyed by the
        // locators the app RECORDED, and a hand-authored spec's locators are not
        // ours to reason about.
        const healSettings = recorderSettingsStore.get();
        // Accessibility checks: per-test choice, falling back to the global
        // default. Like capture, app-generated tests only — an imported spec's
        // actions aren't ones we hooked.
        const wantA11y = (rec.a11yChecks ?? healSettings.defaultA11yChecks) && !rec.sourceDir;
        // Console + network recording. Same per-test-with-global-default shape
        // as capture and a11y, and app-generated tests only for the same
        // reason: an imported spec never gets the fixture that does the
        // recording.
        const recordLogs = (rec.recordLogs ?? healSettings.defaultRecordLogs) && !rec.sourceDir;
        const axeFile = axePath(nodeModules);
        const a11y = wantA11y && fs.existsSync(axeFile);
        checkedAccessibility = a11y;
        if (wantA11y && !a11y) {
          emitOutput(runId, "system", "Accessibility checks skipped: axe-core was not found.\n");
        }
        const healing =
          healSettings.autoHealEnabled && !rec.sourceDir && runSteps.some((st) => !!st.locator);
        healApplyMode = healSettings.autoHealApply;
        // "Crawl" speed's page-settling. App-generated tests only, like every
        // other fixture-borne feature: the settle patch reaches the page
        // through the redirected import, and an imported spec never gets it.
        let settling = speed === "crawl" && !rec.sourceDir;
        // Named rather than left implicit, because "crawl did nothing" is
        // otherwise indistinguishable from "crawl worked": the step delay still
        // applies, so the run just looks slow and settles nothing.
        if (speed === "crawl" && rec.sourceDir) {
          emitOutput(
            runId,
            "system",
            "Crawl: page-settling is skipped for imported tests — only the slower step delay applies.\n",
          );
        }
        if (healing) {
          ensureHealFixture(scriptsDir);
          healDir = path.join(getScriptsDir(), `${recordId}.heal`);
          healMapPath = path.join(scriptsDir, `${recordId}.heal-map.json`);
          try {
            fs.writeFileSync(healMapPath, JSON.stringify(buildHealMap(runSteps)), "utf-8");
          } catch (err) {
            logger.warn("runner", "Could not write the heal map", { err: String(err) });
          }
        }

        // Re-running a past run: generate a spec from ITS recorded steps rather
        // than the test's current script, so an edit since then can't change
        // what gets reproduced.
        if (replaySteps) {
          const replaySpecPath = path.join(scriptsDir, `${recordId}.replay.spec.ts`);
          fs.writeFileSync(
            replaySpecPath,
            generateSpec(
              { name: rec.name, url: rec.url, steps: replaySteps, variables: rec.variables },
              { resolveFlow },
            ),
            "utf-8",
          );
          tempSpecPath = replaySpecPath;
          specToRun = replaySpecPath;
        }
        // The redirect is what puts the fixture in the spec's import path, and
        // the fixture is where capture, healing AND crawl's page-settling live
        // — so a heal-only or crawl-only run needs it too.
        if ((captureArtifacts || healing || a11y || recordLogs || settling) && !rec.sourceDir) {
          ensureCaptureFixture(scriptsDir);
          ensureHealFixture(scriptsDir);
          ensureSettleFixture(scriptsDir);
          const prepared = prepareCaptureSpec(scriptsDir, specToRun, recordId);
          if (prepared) {
            tempSpecPath = prepared;
            specToRun = prepared;
            // `capturing` is the SCREENSHOT gate specifically — an a11y-only
            // run redirects the spec and writes a manifest without taking a
            // single picture. `capturingRun` is the broader "this run produced
            // artifacts worth building a replay from".
            capturing = captureArtifacts;
            // Settling is the one redirect reason that produces NOTHING on
            // disk. Without this distinction, turning auto-heal off and a test
            // to crawl would make every run prune the artifact history and
            // create an empty run dir — paying the storage bookkeeping for a
            // feature that never writes an artifact.
            const artifactRun = captureArtifacts || healing || a11y || recordLogs;
            capturingRun = artifactRun;
            if (artifactRun) {
              // Prune old runs first, then create this run's dir (newest). The
              // retained count is user-configurable in Settings; `- 1` leaves
              // room for the run about to be created, so the on-disk total
              // after this run equals the configured number.
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
            }
          } else {
            // No direct import to redirect means the fixture never loads — so
            // neither capture NOR healing happens, whatever the settings say.
            // Naming only capture here would leave healing failing silently.
            const skipped = [
              captureArtifacts ? "Screenshot capture" : null,
              a11y ? "Accessibility checks" : null,
              healing ? "Auto-Heal" : null,
              recordLogs ? "Console and network recording" : null,
              settling ? "Crawl page-settling" : null,
            ]
              .filter(Boolean)
              .join(" and ");
            // Keep the env var honest about what actually happens: the fixture
            // that reads it was never loaded.
            settling = false;
            emitOutput(
              runId,
              "system",
              `${skipped} skipped: this test doesn't import @playwright/test directly.\n`,
            );
          }
        }

        // Map spec line numbers → step indices so the StepReporter's markers
        // can be translated into highlightable step indices for the renderer.
        // (The redirected capture spec preserves line numbers.) Prefer the
        // generator's own map; fall back to scanning the file for specs it
        // didn't produce.
        stepLineMaps.set(
          runId,
          generatedStepLineMap(rec, runSteps, resolveFlow) ?? buildStepLineMap(specToRun),
        );

        // Each engine is downloaded on its own first use — switching browsers
        // costs one install, not a re-download of everything.
        if (!isBrowserInstalled(runBrowser)) {
          await installBrowser(runId, runBrowser, cliPath, scriptsDir, env);
        }

        const slowMo = SLOW_MO_MS[speed];
        // Explicit per-test override → global Settings default → 1 minute, then
        // raised to the crawl floor if this is a crawl run. See
        // `resolveTestTimeoutMs`.
        const settingsTimeout = recorderSettingsStore.get().defaultTestTimeoutMs;
        const { timeoutMs: testTimeoutMs, raised: timeoutRaised } = resolveTestTimeoutMs(
          rec.testTimeoutMs,
          settingsTimeout,
          speed,
        );
        // Process kill must outlive the test timeout, otherwise a legitimate
        // long test dies with "Timed out — stopping test run" before Playwright
        // can report a clean per-test timeout.
        const processTimeoutMs = Math.max(
          RUN_TIMEOUT_MS,
          testTimeoutMs + PROCESS_TIMEOUT_BUFFER_MS,
        );
        emitOutput(runId, "system", "Running " + path.basename(rec.scriptPath) + "…\n");
        if (capturing) emitOutput(runId, "system", "Capturing screenshots for this run.\n");
        if (recordLogs) emitOutput(runId, "system", "Recording console and network for this run.\n");
        // Announced like the other two. Without it the only evidence the check
        // was even armed was the run taking longer — and axe is slow enough
        // that "slower than usual" is not evidence of anything.
        if (a11y) emitOutput(runId, "system", "Checking accessibility for this run.\n");
        if (settling) {
          emitOutput(
            runId,
            "system",
            "Crawl: waiting for the page to load, go quiet and paint after every step.\n",
          );
        }
        // Said out loud, with the number. A timeout that changed itself is
        // worse than a slow run: the user set 30 seconds, watched a run take
        // four minutes, and had nothing to read that explained it.
        if (timeoutRaised) {
          emitOutput(
            runId,
            "system",
            `Crawl: raised this run's test timeout to ${Math.round(testTimeoutMs / 1000)}s — ` +
              "crawl runs take far longer than the configured limit allows.\n",
          );
        }
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
          // Authoritative: wins over whatever timeout the config (or a hand-
          // edited one) declares. Env var still set so config-only runs match.
          `--timeout=${testTimeoutMs}`,
        ];
        if (params.headed) args.push("--headed");
        // The generated config defines no projects, so --browser selects the
        // engine directly (with projects it would be ignored in favor of them).
        args.push(`--browser=${runBrowser}`);
        exitCode = await runCli(
          runId,
          args,
          cliPath,
          scriptsDir,
          {
            ...env,
            ...varEnv,
            GLAZE_HEAL: healing ? "1" : "0",
            GLAZE_SETTLE: settling ? "1" : "0",
            GLAZE_A11Y: a11y ? "1" : "0",
            GLAZE_AXE_PATH: a11y ? axeFile : "",
            GLAZE_HEAL_DIR: healDir,
            GLAZE_HEAL_MAP: healMapPath,
            PW_SLOWMO_MS: String(slowMo),
            PW_TEST_TIMEOUT_MS: String(testTimeoutMs),
            PW_OUTPUT_DIR: outputDir,
            GLAZE_CAPTURE_ARTIFACTS: capturing ? "1" : "0",
            GLAZE_RECORD_LOGS: recordLogs ? "1" : "0",
            GLAZE_RECORD_ALL_HEADERS: healSettings.recordAllHeaders ? "1" : "0",
            GLAZE_ARTIFACT_DIR: artifactDir,
            GLAZE_TEST_ID: rec.id,
            GLAZE_RUN_ID: recordId,
          },
          processTimeoutMs,
        );
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
        // …and this run's Playwright scratch dir, for the same reason.
        if (outputDir) {
          try {
            fs.rmSync(outputDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        const finishedAt = Date.now();
        const runStatus = exitCode === 0 ? "passed" : "failed";

        // Collect anything run-time Auto-Heal did, and journal it. Read before
        // the temp files are cleaned up below.
        const healedSteps = collectRunHeals(rec.id, recordId, healDir, healApplyMode);
        if (healMapPath) {
          try {
            fs.rmSync(healMapPath, { force: true });
          } catch {
            /* ignore */
          }
        }

        // When this run captured artifacts, persist the canonical replay model
        // (per-step outcome + screenshot mapping) alongside them, keyed by the
        // same runId so the Phase 2 timeline can retrieve it.
        const statuses = stepStatusMaps.get(runId) ?? {};
        stepStatusMaps.delete(runId);
        // Read once, up here, because both the replay summary below and the
        // overhead numbers further down need it — and the summary has to be
        // emitted before the log buffer is drained a few lines later.
        const manifest = capturingRun ? artifactStore.readManifest(rec.id, recordId) : null;
        // Filled in from the replay when capturing, so the notification can
        // mention visual changes and name the failing step.
        let changedSteps = 0;
        let a11yNewSteps = 0;
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
            // Accessibility, compared against what the user has accepted for
            // this test. Reported only — this never touches runStatus.
            a11yNewSteps = enrichWithA11y(replay, rec.a11yBaseline);
            artifactStore.writeReplay(rec.id, recordId, replay);
            // Say what the check did, in the Output panel the user is already
            // looking at. The results themselves live in the Visual view, and
            // nothing used to point there — or admit when nothing was measured.
            if (checkedAccessibility) {
              emitOutput(
                runId,
                "system",
                describeA11yOutcome({ checks: manifest?.a11yChecks ?? 0, steps: replay.steps }) +
                  "\n",
              );
            }
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
        let a11yMs: number | undefined;
        let a11yCheckCount: number | undefined;
        if (manifest) {
          captureOverheadMs = manifest.captureMs;
          shotCount = manifest.shotCount ?? manifest.steps.length;
          a11yMs = manifest.a11yMs;
          a11yCheckCount = manifest.a11yChecks;
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
              speed,
              batchId: params.batchId,
              datasetId: params.datasetId,
              datasetName: params.datasetName,
              healedSteps,
              captureOverheadMs,
              shotCount,
              a11yMs,
              a11yChecks: a11yCheckCount,
              a11yNewSteps,
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
        // user opted in. Never fires for a clean run, and never for a run
        // inside a batch — see shouldNotifyRun.
        if (
          shouldNotifyRun({
            batchId: params.batchId,
            enabled: recorderSettingsStore.get().notifyOnRunIssues,
          })
        ) {
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
        // recordId identifies this execution's artifact directory. The
        // renderer needs it to ask for the run's recorded console/network —
        // runId is the TEST id, which every run of that test shares.
        sendToMain("runner:done", { runId, code: exitCode, recordId });
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
