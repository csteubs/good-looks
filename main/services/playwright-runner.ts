// Runs generated Playwright specs locally using the bundled @playwright/test.
// Browsers are installed on first run into a writable userData folder. Output is
// streamed to the app's main window; each run is tracked by a runId.

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { app, logger } from "@shell/backend";

import { healKeyAnd, healKeyHasText, healKeyWithin } from "../../shared/heal-key.mjs";
import { testIdOverride, testIdSelector } from "../../shared/testid-attr.mjs";

import { sendToMain } from "./app-window.js";
import { getScriptsDir, testStore } from "./test-store.js";
import { runHistoryStore } from "./run-history-store.js";
import { stepReporterSource } from "./step-reporter-source.js";
import { splitStepMarkers } from "./step-marker.js";
import { captureFixtureSource } from "./capture-fixture-source.js";
import {
  SIGNATURE_COUNT_ENV,
  SIGNATURE_FIXTURE_FILE,
  signatureEnvNames,
  signatureFixtureSource,
} from "./signature-fixture-source.js";
import { downloadProxyEnv, runProxyEnv } from "./proxy-service.js";
import * as overlayRuleStore from "./overlay-rule-store.js";
import { shopifySignatureStore } from "./shopify-signature-store.js";
import type { ShopifySignatureEntry } from "./shopify-signature-store.js";
import { normalizeSignatureHost } from "../../shared/shopify-signature.mjs";
import { artifactStore, DEFAULT_RETAINED_RUNS } from "./artifact-store.js";
import type { HealFailure } from "./artifact-store.js";
import { metricsStore } from "./metrics-store.js";
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
import { ensureSessionsDir, freshSessionState, sessionStatePath } from "./session-state-store.js";
import { evaluateAiChecks } from "./ai-check.js";
import { HEAL_FIXTURE_FILE, healFixtureSource } from "./heal-fixture-source.js";
import {
  DISMISS_COUNT_ENV,
  DISMISS_FIXTURE_FILE,
  dismissEnvNames,
  dismissFixtureSource,
} from "./dismiss-fixture-source.js";
import { SETTLE_FIXTURE_FILE, settleFixtureSource } from "./settle-fixture-source.js";
import { buildHealProbeScript } from "./auto-heal.js";
import { healJournalStore } from "./heal-journal-store.js";
import { describeStep } from "./script-generator.js";
import { testSecretsStore } from "./test-secrets-store.js";
import { backfillBaseUrl, importedSandboxDir } from "./import-service.js";
import { shouldRefuseForMissingBaseUrl } from "./imported-config.js";
import { refreshSecretSnapshot, redactWithSnapshot } from "./secret-redaction.js";
import { stripAnsi } from "../../shared/strip-ansi.mjs";
import { firstErrorLine } from "../../shared/error-signature.mjs";
import { suggestFailureReason } from "../../shared/failure-reasons.mjs";
import { armedRulesFor } from "../../shared/overlay-rules.mjs";
import type { RunTrigger } from "../../shared/run-trigger.mjs";
import {
  PLAYWRIGHT_CONFIG_FILE,
  playwrightConfigSource,
} from "../../shared/playwright-config-source.mjs";
import type {
  HealApplyMode,
  HealCandidate,
  Locator,
  OverlayRule,
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

/**
 * Why a run was killed, for the teardown that writes its RunRecord.
 *
 * SEPARATE FROM `runs` ON PURPOSE. The obvious place is a field on the handle,
 * but `stop()` deletes the handle immediately and `isRunning` is a poll the
 * renderer's Stop button reads — so keeping the handle alive to carry a reason
 * would make the button lag until the killed process actually closed. The
 * reason has to outlive the handle by a moment, so it lives beside it.
 *
 * Cleared at the start of every `runCli`, which is what stops an install that
 * timed out from attributing its death to the test run that follows it on the
 * same runId.
 */
const endReasons = new Map<string, "user" | "process-timeout">();

/**
 * Kill a run and record WHY, in that order.
 *
 * One function rather than two call sites doing it by hand, because the order
 * is a race and getting it wrong is silent: `close` fires asynchronously and
 * the run's teardown reads `endReasons`, so a reason recorded after the signal
 * can lose to the read it exists for. The result would be a run that looks
 * like an ordinary failure — which is exactly the state this whole field was
 * added to distinguish.
 */
function killRun(runId: string, child: ChildProcess, reason: "user" | "process-timeout"): void {
  endReasons.set(runId, reason);
  child.kill("SIGKILL");
}

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
 * The bundled backend runs from `build/main`, and dependencies live in the
 * project root's `node_modules` — two levels up either way (build/main → root,
 * or main/services → root when run from source). The extra candidate covers a
 * packaged layout where the app contents sit one level deeper. */
function resolvePlaywright(): { cliPath: string; nodeModules: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [
    // build/main -> approot/node_modules (also main/services -> root in dev)
    path.resolve(here, "..", "..", "node_modules"),
    // one deeper, for a packaged Resources/app/ layout
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

/**
 * Point `<scriptsDir>/node_modules` at the SAME tree the Playwright CLI came
 * from. Specs live under userData and import "@playwright/test"; this symlink
 * is how Node resolves that.
 *
 * REPAIRS a link that points elsewhere — it does not merely create a missing
 * one, and that distinction is the whole bug this function shipped with.
 *
 * The scripts directory outlives the build that created the link. Adopting a
 * legacy Glaze data directory (`main/shell/user-data.ts`) inherits that
 * install's `scripts/node_modules`, which still points into the SDK's own tree.
 * Two failure modes, both silent, and the app hit each in turn:
 *
 *  - **The old tree is still on disk.** The CLI runs from OUR node_modules
 *    while the spec resolves a SECOND copy of @playwright/test through the
 *    link. Playwright compares module identity, not version, so every run dies
 *    at collection with "Playwright Test did not expect test() to be called
 *    here" followed by "No tests found" — no step ever executes, and nothing in
 *    the message points at a symlink.
 *  - **The old tree is gone.** The link dangles. `fs.existsSync` FOLLOWS
 *    symlinks, so it answers false for a dangling one; the old code read that
 *    as "no link here", called `symlinkSync`, got EEXIST because the path is
 *    occupied, logged a warning and carried on with the broken link still in
 *    place. Runs then survived only on the NODE_PATH fallback, which ESM
 *    imports (the capture fixture is `.mjs`) do not consult.
 *
 * Hence `lstat` rather than `existsSync`: the question is what the link IS, not
 * what it points at. A real directory is left alone — that is someone's own
 * install, not ours to delete.
 */
export function ensureModuleResolution(scriptsDir: string, nodeModules: string): void {
  const link = path.join(scriptsDir, "node_modules");
  try {
    const entry = fs.lstatSync(link, { throwIfNoEntry: false });
    if (entry) {
      if (!entry.isSymbolicLink()) return;
      // Resolve against the link's own directory so a relative target compares
      // correctly. Deliberately NOT realpath: that throws on a dangling link,
      // which is precisely the case that has to be repaired.
      const target = path.resolve(scriptsDir, fs.readlinkSync(link));
      if (target === path.resolve(nodeModules)) return;
      logger.info("runner", "Repointing a stale node_modules link beside the specs", {
        from: target,
        to: nodeModules,
      });
      fs.unlinkSync(link);
    }
    fs.symlinkSync(nodeModules, link, "dir");
  } catch (err) {
    logger.warn("runner", "Could not symlink node_modules; relying on NODE_PATH", {
      err: String(err),
    });
  }
}

// Contents live in shared/playwright-config-source.mjs — see there for why ONE
// definition serves both this and the MCP server, and for what each env-driven
// field is for. The write is `writeIfChanged`, like every other fixture here.
function ensureConfig(scriptsDir: string): string {
  const configPath = path.join(scriptsDir, PLAYWRIGHT_CONFIG_FILE);
  writeIfChanged(configPath, playwrightConfigSource);
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

/**
 * Say, in the run output, what happened to the Shopify crawler signature.
 *
 * Every branch here exists because the alternative is silence, and the failure
 * this feature has is silent by construction: an unsigned run against a store
 * that throttles automated traffic fails somewhere further down, as a timeout
 * or a missing element, with nothing connecting it to the signature.
 *
 * Emitted through `emitOutput(runId, "system", …)`, the same surface that
 * already carries "Crawl: page-settling is skipped for imported tests".
 */
async function announceSignatureState(args: {
  runId: string;
  testHost: string | null;
  originEntry: ShopifySignatureEntry | null;
  entries: readonly ShopifySignatureEntry[];
  imported: boolean;
}): Promise<void> {
  const { runId, testHost, originEntry, entries, imported } = args;
  const say = (text: string): void => emitOutput(runId, "system", `${text}\n`);

  if (originEntry) {
    // The positive case gets a line too. "It is being sent" and "it silently is
    // not" are otherwise indistinguishable until the store starts refusing.
    say(`Sending the Shopify crawler signature for ${originEntry.host} on this run.`);
    return;
  }

  // Everything below is a run that will NOT present a signature. Reading the
  // register (rather than the decrypted entries) is what separates "none is
  // configured" from "one is, and could not be read".
  let statuses: Awaited<ReturnType<typeof shopifySignatureStore.list>>;
  try {
    statuses = await shopifySignatureStore.list();
  } catch {
    return;
  }
  if (statuses.length === 0) return;

  const forHost = testHost ? statuses.find((entry) => entry.host === testHost) : undefined;

  if (forHost?.state === "unreadable") {
    say(
      `A Shopify crawler signature is registered for ${forHost.host} but couldn't be decrypted on ` +
        "this Mac, so it wasn't sent.",
    );
    return;
  }

  if (forHost?.state === "expired") {
    // Ran unsigned rather than refused: the test may still pass at low volume,
    // and refusing would turn a degraded run into no run. Sending it anyway is
    // the one option that is affirmatively worse than both — an expired
    // signature fails verification, which is a spoofing signal.
    const on = forHost.expiresAt ? new Date(forHost.expiresAt * 1000).toISOString().slice(0, 10) : null;
    say(
      `The Shopify crawler signature for ${forHost.host}${on ? ` expired on ${on}` : " has expired"}` +
        " and was NOT sent — an expired signature fails verification, which is worse than sending " +
        "none. Shopify signatures last at most three months and can't be renewed; create a new one " +
        "in your Shopify admin.",
    );
    return;
  }

  if (imported) {
    // The gap this feature cannot close, stated rather than discovered. The
    // headers travel on the same fixture as screenshots and Auto-Heal, and that
    // fixture reaches a spec by rewriting its `@playwright/test` import — which
    // an imported project's own spec may not even have.
    if (forHost) {
      say(
        `The Shopify crawler signature for ${forHost.host} is not sent for imported tests — it ` +
          "travels on the same fixture as screenshots and Auto-Heal, which needs the spec to " +
          "import @playwright/test directly.",
      );
    }
    return;
  }

  if (!forHost && testHost && entries.length > 0) {
    // Named rather than left as silence, because "I registered a signature and
    // it isn't working" is the same experience as "I registered it for the
    // other domain" — and a signature is bound to exactly one.
    say(
      `No Shopify crawler signature for ${testHost}. One is registered for ` +
        `${entries.map((entry) => entry.host).join(", ")} — a signature is bound to one domain and ` +
        "can't be used for another.",
    );
  }
}

// Write the Shopify crawler-signature fixture. Unconditional for the same
// reason again: the capture fixture imports it at the top of the module, so a
// run with no signature registered still has to be able to resolve the file.
function ensureSignatureFixture(scriptsDir: string): void {
  writeIfChanged(path.join(scriptsDir, SIGNATURE_FIXTURE_FILE), signatureFixtureSource);
}

// Write the overlay-dismissal fixture. Unconditional for the same reason as
// every other one: the capture fixture imports it at the top of the module, so
// a run with no rules for its host still has to be able to resolve the file.
function ensureDismissFixture(scriptsDir: string): void {
  writeIfChanged(path.join(scriptsDir, DISMISS_FIXTURE_FILE), dismissFixtureSource);
}

/**
 * The env carrying this run's overlay rules — one pair of variables per rule.
 *
 * Same rule as `signatureEnv`: never a JSON blob for the whole set. The TARGET
 * is itself JSON because a locator is structured, but it is one rule's locator
 * per variable, which is what keeps a crash dump from carrying the lot.
 */
function dismissEnv(rules: readonly OverlayRule[]): Record<string, string> {
  const out: Record<string, string> = { [DISMISS_COUNT_ENV]: String(rules.length) };
  rules.forEach((rule, index) => {
    const names = dismissEnvNames(index);
    out[names.label] = rule.label || rule.host;
    out[names.target] = JSON.stringify(rule.target);
  });
  return out;
}

/**
 * The env carrying this run's signatures — one variable per value.
 *
 * Never a JSON blob, for the reason `variableEnv` states about secrets: a blob
 * is a single string that shows up whole in a crash dump or a process listing.
 */
function signatureEnv(entries: readonly ShopifySignatureEntry[]): Record<string, string> {
  const out: Record<string, string> = { [SIGNATURE_COUNT_ENV]: String(entries.length) };
  entries.forEach((entry, index) => {
    const names = signatureEnvNames(index);
    out[names.host] = entry.host;
    out[names.input] = entry.signatureInput;
    out[names.value] = entry.signature;
    out[names.agent] = entry.signatureAgent;
  });
  return out;
}

/** One factory call's key. MUST match the `FACTORIES` table in
 *  heal-fixture-source.ts — if the two spellings drift, every lookup misses and
 *  healing silently stops happening with no error. */
function healKeyBase(loc: Locator): string {
  switch (loc.k) {
    case "testid": {
      // A testid on a non-default attribute is EMITTED as `locator("[…]")`,
      // so at run time the fixture tags it through the `locator` factory —
      // the key must therefore be the css key of that exact selector string,
      // or every lookup for such a step misses.
      const attr = testIdOverride(loc.attr);
      return attr ? `css|${testIdSelector(attr, loc.v ?? "")}` : `testid|${loc.v ?? ""}`;
    }
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
 * The canonical key the heal fixture tags a locator with.
 *
 * A context-carrying locator is a CHAIN, so its key is composed — in the same
 * order the generator emits the chain and therefore the order the fixture
 * observes it: the container, then its `hasText` filter, then the target, then
 * each `and` predicate. The three operators come from `shared/heal-key.mjs`
 * rather than being spelled here, because the fixture builds the identical key
 * from factory ARGUMENTS at run time and the two must agree exactly. See that
 * file for why a transcribed copy is not good enough.
 *
 * `nth` is deliberately absent, here and in the fixture: `.nth()` is a REFINER
 * that propagates the tag it was given (see `REFINERS`), so an indexed step
 * shares its key with the unindexed one it narrows — which is what makes a
 * `.nth()` step healable at all.
 */
export function healKeyFor(loc: Locator): string {
  let key = healKeyBase(loc);
  const ctx = loc.ctx;
  if (ctx?.within) {
    let container = healKeyBase(ctx.within);
    if (ctx.withinHasText !== undefined) container = healKeyHasText(container, ctx.withinHasText);
    key = healKeyWithin(container, key);
  }
  if (ctx?.and) {
    for (const pred of ctx.and) key = healKeyAnd(key, healKeyBase(pred));
  }
  return key;
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
    // Framed steps are excluded from the run-time heal fixture too: the probe
    // is a top-document query and cannot reach inside an iframe. A key that
    // never gets a probe simply is not healed, which is the honest outcome.
    if (step.locator.frame && step.locator.frame.length > 0) return;
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
  steps: Step[] = [],
): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = {};
  if (vars && Object.keys(vars).length > 0) out.GLAZE_VARS = JSON.stringify(vars);

  // Secrets, per owning test. An inlined flow's secret lives in the FLOW's
  // encrypted store, not the caller's — the caller's spec declares the env
  // reference (the generator merges the flow's secret declarations into the
  // header), so without this walk the value never arrives and every run fails
  // with an empty field. Caller first, so a caller declaring the same name
  // wins — the same no-shadowing rule the generated header applies.
  const sources: { testId: string; names: string[] }[] = [];
  const seenTests = new Set<string>([testId]);
  sources.push({
    testId,
    names: variables.filter((v) => v.kind === "secret").map((v) => v.name),
  });
  const walk = (list: Step[]): void => {
    for (const step of list) {
      if (step.type !== "runFlow" || !step.flowId) continue;
      if (seenTests.has(step.flowId)) continue; // cycle guard, matches the generator's
      seenTests.add(step.flowId);
      const flow = testStore.get(step.flowId);
      if (!flow) continue;
      sources.push({
        testId: flow.id,
        names: (flow.variables ?? []).filter((v) => v.kind === "secret").map((v) => v.name),
      });
      walk(flow.steps);
    }
  };
  walk(steps);

  for (const source of sources) {
    if (source.names.length === 0) continue;
    const stored = await testSecretsStore.valuesFor(source.testId);
    for (const name of source.names) {
      const key = secretEnvName(name);
      if (key in out) continue; // first declaration wins (caller over flow)
      // A declared-but-unset secret becomes an empty string rather than being
      // left undefined, so the spec's `?? ""` fallback is what runs and the
      // failure is "the field was empty", not "process.env is missing a key".
      out[key] = stored[name] ?? "";
    }
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

/** One line of the fixture's heals.json. Every field beyond the identity is
 *  outcome-dependent, which is what the two guards below exist to sort out. */
interface HealEvent {
  outcome?: "healed" | "exhausted" | "no-candidates";
  stepId: string;
  stepIndex: number;
  stepLabel: string;
  method?: string;
  originalLocator?: Locator;
  /** Present only on a heal — a failed attempt applied nothing. */
  appliedLocator?: Locator;
  candidates?: HealCandidate[];
  at: number;
}

/** A heal, narrowed so the journal can rely on `appliedLocator` being there.
 *
 *  An event with NO `outcome` predates the field (2026-08-07) and is therefore
 *  a heal — that was the only kind the fixture wrote. Defaulting the other way
 *  would reclassify every historical heal as a failure. The `appliedLocator`
 *  test is not belt-and-braces: journalling one without a locator would write a
 *  review row whose "revert" button has nothing to revert to. */
function isHeal(e: HealEvent): e is HealEvent & { appliedLocator: Locator } {
  return (e.outcome ?? "healed") === "healed" && !!e.appliedLocator;
}

/** A failed attempt. Keyed on the outcomes that EXIST rather than on
 *  "not a heal", so a value this build doesn't recognise is dropped from both
 *  counts instead of silently inflating the failure one. */
function isHealFailure(e: HealEvent): e is HealEvent & HealFailure {
  return e.outcome === "exhausted" || e.outcome === "no-candidates";
}

/**
 * Read what run-time Auto-Heal did, journal the heals, persist the failures,
 * and return a count of each.
 *
 * Under "suggest" (the default) nothing is written back to the test: the run
 * used the healed locator in memory to get past the step, and the journal entry
 * is the user's record of that plus the means to apply or dismiss it. Under
 * "apply" the step's locator is updated here, on the backend, because the child
 * process has no business writing to tests.json.
 *
 * FAILED attempts are deliberately NOT journalled. The journal is a review
 * surface — every row is a locator change to accept or revert — and an attempt
 * that healed nothing offers no such action; putting it there would fill the
 * review list with rows nobody can act on. They go to the run's artifacts
 * instead, beside console.json and network.json, because that is what they are:
 * evidence about one run, keyed by step. See `recordFailure` in
 * heal-fixture-source.ts for why they are worth keeping at all.
 */
/**
 * Persist what each failing locator actually resolved to.
 *
 * Called from `collectRunHeals` rather than beside it, and that is the whole
 * point: that function owns the scratch dir and removes it on EVERY path out,
 * including the early ones where no heal was recorded but a match set may
 * still have been. As a sibling call this was one statement order away from
 * writing nothing, forever, with no error — so the function that deletes the
 * directory is the one that reads it.
 *
 * Independent of whether anything healed: a step whose ambiguous locator was
 * then rescued leaves a match record and no heal failure, and the ambiguity is
 * the thing worth reporting either way.
 */
function collectRunMatches(testId: string, runId: string, healDir: string): number {
  if (!healDir) return 0;
  try {
    const raw = fs.readFileSync(path.join(healDir, "matches.json"), "utf-8");
    const sets = JSON.parse(raw);
    if (!Array.isArray(sets) || sets.length === 0) return 0;
    artifactStore.writeStepMatches(testId, runId, sets);
    return sets.length;
  } catch {
    // The common case is that the file does not exist — nothing failed to
    // resolve. A corrupt one is the same answer: no match data for this run.
    return 0;
  }
}

function collectRunHeals(
  testId: string,
  runId: string,
  healDir: string,
  mode: HealApplyMode,
): { healed: number; failed: number } {
  const none = { healed: 0, failed: 0 };
  if (!healDir) return none;
  // First, and unconditionally: every path below this line can reach
  // `discardScratch`, and a run that failed to resolve a locator without
  // healing anything is exactly the run whose matches are worth keeping.
  collectRunMatches(testId, runId, healDir);
  // The fixture's scratch dir, removed on EVERY path out of here. It used to be
  // cleaned only on the heals path; once failures became recordable, a run that
  // failed to heal and healed nothing would have left it behind for good.
  const discardScratch = (): void => {
    try {
      fs.rmSync(healDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  const file = path.join(healDir, "heals.json");
  let all: HealEvent[] = [];
  try {
    all = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    // Nothing happened (the common case) — the fixture only writes on an event.
    discardScratch();
    return none;
  }
  if (!Array.isArray(all) || all.length === 0) {
    discardScratch();
    return none;
  }

  const events = all.filter(isHeal);
  const failures = all.filter(isHealFailure);
  if (failures.length > 0) {
    try {
      artifactStore.writeHealFailures(testId, runId, failures);
    } catch (err) {
      logger.warn("runner", "Could not persist heal failures", { err: String(err) });
    }
  }
  if (events.length === 0) {
    discardScratch();
    logger.info("runner", "Run could not heal steps", {
      testId,
      runId,
      failed: failures.length,
    });
    return { healed: 0, failed: failures.length };
  }

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
  discardScratch();
  logger.info("runner", "Run healed steps", {
    testId,
    runId,
    count: events.length,
    failed: failures.length,
    apply,
  });
  return { healed: events.length, failed: failures.length };
}

/** CSI escape sequences are stripped at the same choke point as redaction, for
 *  the same reason: these bytes are meaningless outside a terminal, and all
 *  three consumers suffer from them. Defined in shared/strip-ansi.mjs so the
 *  MCP server's own single write point can apply it too; re-exported because
 *  strip-ansi.test.ts and the rest of the app import it from here. */
export { stripAnsi } from "../../shared/strip-ansi.mjs";

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

// Parse a stdout chunk: extract the step markers, map their line number to a
// step index, emit `runner:step` events, and return the remaining visible text.
//
// The splitting itself lives in `step-marker.ts` — it is the half with the two
// non-obvious rules (a marker can straddle chunks, and a marker written by the
// WORKER lands after the `line` reporter's cursor-control prefix rather than at
// the start of its line), and it is testable without a child process.
function processStdout(runId: string, chunk: string): string {
  const { visible, markers, rest } = splitStepMarkers(stdoutBuffers.get(runId) ?? "", chunk);
  stdoutBuffers.set(runId, rest);
  // Markers are stripped whether or not this run can map them: a spec with no
  // line map (hand-edited past what the scanner recognizes) would otherwise
  // print raw `__GLAZE_STEP__:` lines into the user's Output panel.
  const map = stepLineMaps.get(runId);
  if (map) {
    for (const marker of markers) {
      const stepIndex = map.get(marker.line);
      if (typeof stepIndex === "number") {
        emitStep(runId, stepIndex, marker.event, marker.ok);
      }
    }
  }
  return visible;
}

/** First `trace.zip` under Playwright's scratch dir, walking at most a few
 *  levels — the layout is `<outputDir>/<test-slug>[/retryN]/trace.zip` and a
 *  bounded walk cannot be sent spelunking by a weird artifact tree. */
export function findTraceZip(root: string, depth = 3): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === "trace.zip") return path.join(root, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findTraceZip(path.join(root, e.name), depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** Open a failed run's salvaged trace in Playwright's trace viewer.
 *
 *  Spawned exactly the way runs are — `process.execPath` +
 *  ELECTRON_RUN_AS_NODE — and DETACHED: the viewer serves a local page and
 *  outlives any interest this process has in it. `spawnImpl` is test
 *  scaffolding; nothing else should pass it. */
export function openTrace(
  testId: string,
  runId: string,
  spawnImpl: typeof spawn = spawn,
): { ok: boolean; reason?: string } {
  // The ids become path segments and `runDir` is a bare join, so they are
  // validated HERE, before any filesystem look: an id carrying a separator or
  // `..` would walk out of the artifact root, and "open whatever trace.zip
  // sits at an attacker-chosen path" is not a capability this handler should
  // have even in its low-harm form. Same posture as the import sandbox:
  // containment asserted where the path is built.
  const SAFE_ID = /^[A-Za-z0-9._-]+$/;
  if (!SAFE_ID.test(testId) || !SAFE_ID.test(runId) || testId.includes("..") || runId.includes("..")) {
    return { ok: false, reason: "No trace for this run." };
  }
  const tracePath = path.join(artifactStore.runDir(testId, runId), "trace.zip");
  if (!fs.existsSync(tracePath)) {
    return {
      ok: false,
      reason:
        "No trace for this run. Traces are kept for failed runs until their artifacts are pruned.",
    };
  }
  const { cliPath } = resolvePlaywright();
  const child = spawnImpl(process.execPath, [cliPath, "show-trace", tracePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();
  return { ok: true };
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
    // Under Electron, process.execPath is the Electron binary, not node.
    // ELECTRON_RUN_AS_NODE makes that binary behave as plain node for the
    // child, so the Playwright CLI runs exactly as it would under `node`.
    // Without it this spawn would launch a second instance of the app.
    // A stale reason here would belong to a PREVIOUS invocation on this runId —
    // `runCli` is also how a missing browser gets installed, and that install
    // runs under the same id. An install that timed out must not make the test
    // run that follows it look like it timed out too.
    endReasons.delete(runId);
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    });
    runs.set(runId, { child, testId: runId });

    const timer = setTimeout(() => {
      emitOutput(runId, "system", "\nTimed out — stopping test run.\n");
      killRun(runId, child, "process-timeout");
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
      // NOT the step line map. `runCli` is also how a missing browser gets
      // installed, and that call runs under the SAME runId — so deleting the map
      // here threw away the mapping the test run was about to need, and the
      // first run on any new engine silently highlighted nothing. It is dropped
      // where it is set instead: the run's own `finally`.
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
    /** WHO asked for this run. Defaults to `manual`, because every caller that
     *  does not say is an IPC handler answering a click. The scheduler is the
     *  one caller that must pass a value, and it is the reason the field
     *  exists: without it a Routine firing overnight is indistinguishable from
     *  a person pressing Run. Never describes what the run EXECUTES — a replay
     *  is `replayOfRunId` above. */
    trigger?: RunTrigger;
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
      // Resolved inside the try (the run's steps), read in the finally (the
      // post-run evaluation) — same seam checkedAccessibility crosses.
      let hasAiChecks = false;
      let aiCheckDir = "";
      let healDir = "";
      let healMapPath = "";
      let healApplyMode: HealApplyMode = "suggest";
      // The budget this run actually got. Hoisted so the RunRecord can carry
      // it: read back from the TestRecord later it would be the CURRENT value,
      // and a timeout raised since would make every older run's "how close was
      // this step to its budget?" read wrong while still looking plausible.
      let runTestTimeoutMs: number | undefined;
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
        const varEnv = await variableEnv(rec.id, params.vars, rec.variables ?? [], rec.steps);

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
        // Login sessions: where this run SAVES its signed-in state (a passing
        // run of a saveSession test), and which saved state it STARTS from.
        // Stale or missing state is said out loud and the run proceeds fresh —
        // an invisible fallback here would read as auth flake in the consumer.
        const sessionEnv: NodeJS.ProcessEnv = {};
        if (rec.saveSession && !rec.sourceDir) {
          ensureSessionsDir();
          sessionEnv.GLAZE_SAVE_STATE = sessionStatePath(rec.id);
        }
        if (rec.useSessionFrom) {
          const fresh = freshSessionState(rec.useSessionFrom);
          if (fresh) {
            sessionEnv.GLAZE_STORAGE_STATE = fresh.path;
            const from = testStore.get(rec.useSessionFrom);
            emitOutput(
              runId,
              "system",
              `Starting from the saved login session of "${from?.name ?? rec.useSessionFrom}".\n`,
            );
          } else {
            const from = testStore.get(rec.useSessionFrom);
            emitOutput(
              runId,
              "system",
              `No fresh saved session from "${from?.name ?? rec.useSessionFrom}" — running without. Run that test (with session saving on) first.\n`,
            );
          }
        }
        // AI visual checks: the helper screenshots into the run's artifact
        // dir; the app evaluates them after the run. The dir is created here
        // because a checks-only run may have every capture toggle off.
        hasAiChecks = runSteps.some((st) => st.type === "aiCheck" && !st.disabled);
        aiCheckDir = hasAiChecks ? artifactStore.runDir(rec.id, recordId) : "";
        if (aiCheckDir) {
          try { fs.mkdirSync(aiCheckDir, { recursive: true }); } catch { /* fixture reports */ }
        }
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

        // ── The Shopify crawler signature ────────────────────────────────
        //
        // TWO different rules, deliberately.
        //
        // Whether to ARM is narrow: only when this test's OWN origin has a
        // registered, readable, unexpired signature. Routing disables the
        // browser's HTTP cache for the context, which changes timing and can
        // move a screenshot, so a machine with a signature registered must not
        // pay that on every unrelated test.
        //
        // What gets INSTALLED once armed is complete: a route for every
        // registered host, each scoped to its own. A test that starts at one
        // registered store and navigates to another signs both.
        const signatureEntries = rec.sourceDir ? [] : await shopifySignatureStore.entries();
        const testOrigin = rec.sourceDir ? (rec.baseUrl ?? "") : (rec.url ?? "");
        const testHost = normalizeSignatureHost(testOrigin);
        const originEntry = signatureEntries.find((entry) => entry.host === testHost) ?? null;
        let signing = originEntry !== null;
        // ── Standing overlay rules ──────────────────────────────────────
        //
        // Armed by HOST, from the test's own starting URL. Nothing here is a
        // toggle: a run against a host with no rules installs nothing and pays
        // nothing, which is why there is no setting to forget to turn on.
        //
        // Imported tests are excluded along with every other fixture — their
        // spec is somebody else's file and is never redirected through ours.
        const overlayRules = rec.sourceDir
          ? []
          : armedRulesFor(overlayRuleStore.listRules(), rec.url ?? "");
        let dismissing = overlayRules.length > 0;
        await announceSignatureState({
          runId,
          testHost,
          originEntry,
          entries: signatureEntries,
          imported: !!rec.sourceDir,
        });
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
        if (
          (captureArtifacts || healing || a11y || recordLogs || settling || signing || dismissing) &&
          !rec.sourceDir
        ) {
          ensureCaptureFixture(scriptsDir);
          ensureHealFixture(scriptsDir);
          ensureSettleFixture(scriptsDir);
          ensureSignatureFixture(scriptsDir);
          ensureDismissFixture(scriptsDir);
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
            //
            // `signing` is NOT here, for the same reason `settling` is not:
            // it writes nothing to disk. Including it would make a run that
            // only attaches a header prune the artifact history and create an
            // empty run dir — the exact bug settling shipped once.
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
              signing ? "The Shopify crawler signature" : null,
              dismissing ? "Overlay rules" : null,
            ]
              .filter(Boolean)
              .join(" and ");
            // Keep the env var honest about what actually happens: the fixture
            // that reads it was never loaded.
            settling = false;
            signing = false;
            dismissing = false;
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
        // costs one install, not a re-download of everything. The download is
        // APP traffic (the app fetching its own tooling), so it gets the
        // conventional HTTPS_PROXY variables when Settings → Proxy covers it —
        // behind a mandatory proxy this download is otherwise the one thing
        // that still can't reach the network.
        if (!isBrowserInstalled(runBrowser)) {
          await installBrowser(runId, runBrowser, cliPath, scriptsDir, {
            ...env,
            ...(await downloadProxyEnv()),
          });
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
        runTestTimeoutMs = testTimeoutMs;
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
        // An imported spec navigates the way its own project did — relative to a
        // `baseURL` that lived in that project's config file and did not come
        // with the copied spec. Running anyway spends the full timeout and fails
        // inside Playwright's protocol layer, naming neither the config nor the
        // missing URL; reading that error took an entire AI-debug session. So
        // refuse here, and say the one thing that fixes it.
        //
        // Recorded tests can't reach this: they navigate to absolute URLs, and
        // `treeNeedsBaseUrl` only answers yes to a relative one.
        if (shouldRefuseForMissingBaseUrl(rec, importedSandboxDir(rec.id))) {
          // Every test imported before this field existed is in this state, and
          // most of them came from a project still sitting on disk. Ask it
          // once, out loud, rather than refusing a run we can complete.
          const adopted = backfillBaseUrl(rec.id);
          if (adopted) {
            rec.baseUrl = adopted;
            emitOutput(
              runId,
              "system",
              `Base URL ${adopted} — read from the playwright.config of the project this test was ` +
                "imported from, because this test's relative navigations had nothing to resolve " +
                "against. Saved on the test; change it next to the Timeout box.\n",
            );
          } else {
            emitOutput(
              runId,
              "system",
              'This test navigates to relative URLs (like "/"), which need a base URL to resolve against.\n' +
                "It had one in the project it was imported from — that lives in playwright.config, which " +
                "doesn't travel with the spec.\n" +
                "Set Base URL on this test (next to the Timeout box) and run it again.\n",
            );
            // Returns the same shape a real run does — the `finally` records
            // it, and exitCode is still -1, so the run reads as failed. It did.
            return exitCode;
          }
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
            // The Settings → Proxy manual configuration, when it covers test
            // traffic — the config file reads these. Empty in automatic mode:
            // the browsers detect the OS configuration themselves. Built by
            // the same shared rule the MCP server uses, password added here
            // because only this process can decrypt it.
            ...(await runProxyEnv()),
            GLAZE_HEAL: healing ? "1" : "0",
            GLAZE_SETTLE: settling ? "1" : "0",
            GLAZE_AI_CHECK_DIR: aiCheckDir,
            GLAZE_A11Y: a11y ? "1" : "0",
            // The path travels whenever the file exists, not only when the CAPTURE
            // toggle is on: an `a11y` GATE step injects axe itself mid-test via
            // glazeA11yGate, and gating the path on the toggle would make the
            // gate fail on runs that never asked for per-step capture.
            GLAZE_AXE_PATH: fs.existsSync(axeFile) ? axeFile : "",
            // Accepted violations, flattened to keys. Env rather than baked into
            // the spec so an accept takes effect without regenerating.
            GLAZE_A11Y_BASELINE: JSON.stringify(
              Object.values(rec.a11yBaseline ?? {}).flat(),
            ),
            GLAZE_HEAL_DIR: healDir,
            GLAZE_HEAL_MAP: healMapPath,
            PW_SLOWMO_MS: String(slowMo),
            PW_TEST_TIMEOUT_MS: String(testTimeoutMs),
            PW_OUTPUT_DIR: outputDir,
            // What an imported spec's relative navigations resolve against.
            // Empty for a recorded test, which always goes to an absolute URL —
            // and empty is falsy, so the config then declares no baseURL at all
            // and behaves exactly as it did before this existed.
            PW_BASE_URL: rec.baseUrl ?? "",
            ...sessionEnv,
            GLAZE_CAPTURE_ARTIFACTS: capturing ? "1" : "0",
            GLAZE_RECORD_LOGS: recordLogs ? "1" : "0",
            GLAZE_RECORD_ALL_HEADERS: healSettings.recordAllHeaders ? "1" : "0",
            GLAZE_ARTIFACT_DIR: artifactDir,
            GLAZE_TEST_ID: rec.id,
            GLAZE_RUN_ID: recordId,
            ...signatureEnv(signing ? signatureEntries : []),
            ...dismissEnv(dismissing ? overlayRules : []),
          },
          processTimeoutMs,
        );
      } catch (err) {
        emitOutput(runId, "system", "\nError: " + String(err) + "\n");
      } finally {
        // Read and cleared together — the map must not outlive the run it
        // describes, or the next run on this id inherits the reason.
        const endedBy = endReasons.get(runId);
        endReasons.delete(runId);
        runs.delete(runId);
        // Remove the temp capture spec (best-effort).
        if (tempSpecPath) {
          try {
            fs.rmSync(tempSpecPath, { force: true });
          } catch {
            /* ignore */
          }
        }
        // Salvage the failure trace BEFORE the scratch dir goes. The generated
        // config has said `trace: "retain-on-failure"` since it was written,
        // and this cleanup was deleting the result on every run — retention
        // that never bought a trace anyone could open. Copied into the run's
        // artifact dir, where the retention sweep manages it like every other
        // run artifact. A missing or uncopyable trace must never fail a run's
        // bookkeeping.
        const hasTrace = (() => {
          if (!outputDir || exitCode === 0) return false;
          try {
            const zip = findTraceZip(outputDir);
            if (!zip) return false;
            const dest = path.join(artifactStore.runDir(rec.id, recordId), "trace.zip");
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(zip, dest);
            return true;
          } catch {
            return false;
          }
        })();
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
        const { healed: healedSteps, failed: healFailedSteps } = collectRunHeals(
          rec.id,
          recordId,
          healDir,
          healApplyMode,
        );
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
        // Dropped here rather than when the Playwright process closes, because
        // a browser install runs through the same `runCli` under the same runId
        // and would otherwise take the map with it.
        stepLineMaps.delete(runId);
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

        // AI visual checks: judge each captured screenshot against its claim
        // with the configured model, AFTER the run — the run's own verdict is
        // already sealed and is never touched. Provider failures degrade to
        // UNEVALUATED with the provider's sentence, per check, said in the
        // output panel; silence is the one outcome this pipeline refuses.
        let aiChecksPassed = 0;
        let aiChecksFailed = 0;
        let aiChecksUnevaluated = 0;
        if (hasAiChecks) {
          const results = await evaluateAiChecks({
            steps: runSteps,
            dir: aiCheckDir,
            emit: (line) => emitOutput(runId, "system", line),
          });
          aiChecksPassed = results.filter((r) => r.verdict === "pass").length;
          aiChecksFailed = results.filter((r) => r.verdict === "fail").length;
          aiChecksUnevaluated = results.filter((r) => r.verdict === "unevaluated").length;
          try {
            fs.writeFileSync(
              path.join(aiCheckDir, "ai-checks.json"),
              JSON.stringify({ testId: rec.id, runId: recordId, checks: results }, null, 2),
            );
          } catch (err) {
            logger.warn("runner", "Failed to persist AI check results", { err: String(err) });
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
              ...(hasTrace ? { hasTrace: true } : {}),
              batchId: params.batchId,
              datasetId: params.datasetId,
              datasetName: params.datasetName,
              healedSteps,
              healFailedSteps,
              testTimeoutMs: runTestTimeoutMs,
              captureOverheadMs,
              shotCount,
              a11yMs,
              a11yChecks: a11yCheckCount,
              a11yNewSteps,
              aiChecksPassed,
              aiChecksFailed,
              aiChecksUnevaluated,
              replayOfRunId,
              // Derived above from the replay, and until now it lived and died
              // in this function — the notification and the alert named the
              // step and nothing that outlived the process could.
              failedStepLabel: failedLabel,
              endedBy,
              // Defaulted at the ENTRY POINT, not on read: from here on every
              // run this process starts records a trigger, so an absent one in
              // history means "predates the field" and nothing else.
              trigger: params.trigger ?? "manual",
            },
            logText,
          );
          sendToMain("runs:changed", {});
          // Distil this run into metric rows while every artifact it produced
          // is still on disk. Best-effort and non-throwing by contract — a
          // bookkeeping failure must not become a failed run — and idempotent,
          // so the prune preflight rewriting the same run later is harmless.
          metricsStore.ingest(recordId, "app");
        } catch (err) {
          logger.warn("runner", "Failed to persist run history", { err: String(err) });
        }
        // Label WHY the run failed, while the evidence is fresh. AFTER ingest,
        // because the mapping reads triage, and triage reads the metric rows
        // ingest just wrote (both synchronous). Deterministic — the triage
        // classifier's strongest signal, or a connect-level error line — and
        // best-effort like everything else on this path: a run that cannot be
        // categorized stays uncategorized, which the run panel offers as a
        // state, not an error. setFailureReason itself refuses to touch a
        // label a user already set.
        //
        // Compared as `!== "passed"` on purpose: a11y-diff.test.ts pins
        // "runStatus is assigned exactly once" with a source regex crude
        // enough to read an equality comparison of this variable as an
        // assignment. The two spellings are the same claim over a two-value
        // union.
        if (runStatus !== "passed") {
          try {
            if (recorderSettingsStore.get().autoFailureReasons) {
              const suggestion = suggestFailureReason(
                metricsStore.triage(recordId),
                firstErrorLine(stripAnsi(logText)),
              );
              if (suggestion) {
                runHistoryStore.setFailureReason(
                  recordId,
                  suggestion.reasonId,
                  "auto",
                  suggestion.signal,
                );
                sendToMain("runs:changed", {});
              }
            }
          } catch (err) {
            logger.warn("runner", "Could not auto-categorize the failure", { err: String(err) });
          }
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
            testId: rec.id,
            // The RUN's id, not `runId` — that is the test id, which every run
            // of this test shares, and a link built from it would open the
            // newest run rather than the one that fired this alert.
            runId: recordId,
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
      // The reason lives outside the handle, which goes on the next line: the
      // run's own teardown writes the RunRecord and needs to know a person
      // ended this rather than an assertion.
      killRun(runId, handle.child, "user");
      runs.delete(runId);
    }
  },

  isRunning(runId: string): boolean {
    return runs.has(runId);
  },
};
