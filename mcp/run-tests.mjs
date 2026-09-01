// Running recorded tests from plain Node — the path a CLI needs.
//
// WHY THIS MODULE EXISTS. `docs/plans/test-runner-improvements.md` §3.3 makes
// one load-bearing decision about the CLI: it must be a third CALLER of what
// `mcp/` already does, never a third implementation. `run-plan.mjs` records why
// — the app's runner and this server's had silently diverged in four ways by
// 2026-08-07, and `check:mcp-parity` exists to stop a third. But all of it lived
// inside `server.mjs`, a 2,150-line file that boots an MCP server on import, so
// there was nothing to call.
//
// Three of the four pieces here moved verbatim. The fourth did not, and it is
// the reason this is its own change: the batch driver RETURNED MCP TOOL CONTENT
// (`{content:[{type:"text"}], isError}`) at every exit, so a caller that is not
// an MCP tool could not use it. `runSelection` returns a RESULT instead — a
// discriminated `{ok:false, reason}` for the four refusals and a structured
// payload for a run that happened — and the tool in `server.mjs` renders that
// into exactly the text it produced before. The CLI turns the same result into
// an exit code (0 passed / 1 failed / 2 selector matched nothing / 3 could not
// start), which is the contract §3.3 pins.
//
// A FACTORY, for the reason `store.mjs` gives: everything here is bound to one
// `dataDir`, and `server.mjs` destructures the result into the names it already
// used, so its call sites did not change.

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "./data-dir.mjs";
import { resolveScriptPath, scriptsDirFor } from "../shared/script-path.mjs";
import { normalizeBaseUrl } from "../shared/base-url.mjs";
import { readRunProvenance } from "../shared/run-provenance.mjs";
import { normalizeRunTrigger } from "../shared/run-trigger.mjs";
import { splitStepMarkers } from "../shared/step-marker.mjs";
import { retryFields } from "../shared/run-attempts.mjs";
import { buildStepLineMapFromSource } from "../shared/step-line-map.mjs";
import { recordRun } from "./metrics.mjs";
import { clampParallel, runPool } from "./run-pool.mjs";
import { selectTests, summarizeResults, UNGROUPED } from "./select-tests.mjs";
import {
  describeRun,
  runArgs,
  runEnv,
  sanitizeOutput,
} from "./run-plan.mjs";
import { buildQueue } from "../shared/batch-queue.mjs";
import { browserInstalledIn, expectedBrowserDirs } from "../shared/browser-install.mjs";
import {
  PLAYWRIGHT_CONFIG_FILE,
  playwrightConfigSource,
} from "../shared/playwright-config-source.mjs";
import { resolveRunSpeed, resolveTestTimeoutMs } from "../shared/run-pacing.mjs";
// What gets written beside a spec, and what an unattended run turns on — one
// table both runners read, so they cannot disagree about WHICH files exist.
// A missing one is an import error at run time, not a diff. See R8.
import {
  ALWAYS_WRITTEN,
  CAPABILITY_FIXTURES,
  STEP_REPORTER_FILE,
  redirectToCaptureFixture,
} from "../shared/run-fixtures.mjs";
import {
  HEAL_EVENTS_FILE,
  HEAL_MATCHES_FILE,
  healArtifactEnvelope,
  healDirName,
  healMapFileName,
  isHealFailure,
} from "../shared/heal-artifacts.mjs";
import { buildHealMap } from "../shared/heal-map.mjs";
import { seedsForTest } from "../shared/propagation.mjs";
import { dismissEnv } from "../shared/dismiss-fixture-names.mjs";
import { armedRulesFor } from "../shared/overlay-rules.mjs";
import { userPageEnv } from "../shared/user-page-fixture-source.mjs";
// The CI secret contract — where a secret comes from without the app, and
// the refusal when it comes from nowhere.
import { describeMissingSecrets, resolveCiSecrets } from "../shared/ci-secrets.mjs";

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MCP_DIR, "..");

/** Floor on the hard process kill, matching playwright-runner.ts. Independent
 *  of the per-test timeout so a short test timeout never leaves a hung
 *  install/browser-download with only a few seconds of runway. */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** Extra time past the per-test timeout before the process is killed — covers
 *  browser launch and Playwright's own cleanup after a test timeout. Without
 *  it, a test given a long timeout dies here first and reports as a hard kill
 *  rather than as the clean per-test timeout Playwright was about to write. */
const PROCESS_TIMEOUT_BUFFER_MS = 60_000;

/** The engines a run may name. */
export const RUN_BROWSERS = ["chromium", "firefox", "webkit"];

/**
 * The runner, bound to one data directory and one store.
 *
 * ── `trigger` has NO DEFAULT, deliberately ─────────────────────────────────
 * This function is the single run path behind two entry points, and it wrote
 * `trigger: "mcp"` as a literal until R6. That was right while the MCP server
 * was the only caller and became wrong the moment `cli/run.mjs` imported it:
 * every `good-looks run` — every run of the GitHub Action included — was filed
 * in the app's history as "Started by an MCP client".
 *
 * The reflex fix is a default of `"mcp"`, which reproduces the same bug for the
 * next caller. An absent trigger is the honest answer for a caller that has not
 * said, and `shared/run-trigger.mjs` already rules that absent means UNKNOWN
 * rather than any particular value. So it is passed or it is not recorded, and
 * it is NARROWED here rather than trusted: a typo would otherwise be written
 * into a store the app reads back through a cast.
 *
 * @param {{
 *   dataDir: string,
 *   store: ReturnType<import("./store.mjs").createStore>,
 *   secretEnv?: Record<string, string | undefined>,
 *   secretFile?: Record<string, unknown>,
 *   trigger?: string,
 *   provenanceEnv?: Record<string, string | undefined>,
 * }} deps
 */
export function createRunner({
  dataDir,
  store,
  secretEnv = process.env,
  secretFile = {},
  trigger,
  provenanceEnv = process.env,
}) {
  const { listTests, readSettings, readSignatures, readOverlayRules, saveRunRecord, saveBatchRecord } =
    store;

  /** Narrowed once. An unrecognised value is not carried through — see the
   *  note on the signature. */
  const runTrigger = normalizeRunTrigger(trigger);

  /** WHERE these runs came from, resolved ONCE for the life of the runner.
   *
   *  Per run would be wrong rather than merely wasteful: a batch is one
   *  invocation against one checkout, and re-reading the environment per test
   *  invites a history in which two runs of the same batch record two
   *  revisions — which is exactly the confusion the field exists to remove.
   *
   *  Nothing is fabricated when the environment says nothing. On a laptop this
   *  is `undefined` and the field is simply absent, which is what an
   *  un-attributable run honestly is. */
  const runProvenance = readRunProvenance(provenanceEnv);

  /** WHERE BROWSERS LIVE, once. Three things need this answer and they must be
   *  the same one: `isBrowserInstalled` asks whether an engine is there,
   *  `executeTest` tells Playwright where to launch it from, and
   *  `installBrowser` unpacks it. Two spellings would mean the CLI installing a
   *  browser into a directory the run does not look in — which fails as
   *  "install it, then it is still not installed", with nothing naming the
   *  cause. It was already written out twice before the installer made it
   *  three. */
  function browsersDir() {
    return path.join(dataDir, "recorder", "browsers");
  }

  function findPlaywrightCli() {
    const nodeModules = path.join(PROJECT_ROOT, "node_modules");
    const candidates = [
      path.join(nodeModules, "@playwright", "test", "cli.js"),
      path.join(nodeModules, "playwright", "cli.js"),
    ];
    const cliPath = candidates.find((c) => fs.existsSync(c));
    return cliPath ? { cliPath, nodeModules } : null;
  }

  /** Playwright unpacks each engine as `<engine>-<revision>`, and the revision
   *  is the bundled CLI's — read from its `browsers.json`, the same rule the
   *  app's runner applies (shared/browser-install.mjs). A name-prefix match
   *  stood here until 2026-08-22 and accepted the previous Playwright's build
   *  after an upgrade, so every run launched a browser that was not there. */
  function isBrowserInstalled(browser = "chromium") {
    const dir = browsersDir();
    try {
      if (!fs.existsSync(dir)) return false;
      let expected = null;
      const pw = findPlaywrightCli();
      if (pw) {
        try {
          expected = expectedBrowserDirs(
            fs.readFileSync(path.join(pw.nodeModules, "playwright-core", "browsers.json"), "utf-8"),
            browser,
          );
        } catch {
          expected = null;
        }
      }
      return browserInstalledIn(fs.readdirSync(dir), browser, expected);
    } catch {
      return false;
    }
  }

  /**
   * Install one engine into the library's own browsers directory (R11).
   *
   * WHY THIS IS NOT `npx playwright install`. Playwright's default install
   * location is a machine-wide cache; this app keeps its browsers under the
   * user's data directory, so an engine installed the ordinary way is invisible
   * to every run. `PLAYWRIGHT_BROWSERS_PATH` is what makes the two agree, and
   * it comes from the SAME `browsersDir()` the runner launches from — a second
   * spelling would fail as "I installed it and it is still not installed".
   *
   * It is also the same bundled CLI the run spawns, so the revision installed
   * is by construction the revision `isBrowserInstalled` expects. Reaching for a
   * Playwright on the caller's PATH is how the 1.62 upgrade broke installs
   * before: a different CLI unpacks a different `<engine>-<revision>` directory
   * and nothing here would launch it.
   *
   * `onOutput` receives the child's bytes as they arrive rather than at the end,
   * because a browser download is the longest thing this CLI does and silence
   * for a minute reads as a hang.
   *
   * @returns {Promise<{ok: true} | {ok: false, reason: string, exitCode?: number}>}
   */
  async function installBrowser(browser, { withDeps = false, onOutput } = {}) {
    if (!RUN_BROWSERS.includes(browser)) {
      return { ok: false, reason: "unknown-browser" };
    }
    const playwright = findPlaywrightCli();
    if (!playwright) {
      return { ok: false, reason: "no-playwright" };
    }
    // Created here rather than left to Playwright: the directory is the thing
    // `isBrowserInstalled` reads, and an install that succeeds into a path
    // nothing created is a difference between the two answers.
    fs.mkdirSync(browsersDir(), { recursive: true });

    const args = [playwright.cliPath, "install", browser];
    // `--with-deps` needs root on Linux and does not exist as a concept on
    // macOS. Passed through rather than inferred: a CI image that needs it
    // knows it does, and running it unasked on a developer's laptop would
    // prompt for a password out of nowhere.
    if (withDeps) args.push("--with-deps");

    return new Promise((resolveInstall) => {
      const child = spawn(process.execPath, args, {
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: browsersDir(),
          NODE_PATH: playwright.nodeModules,
          // Harmless from plain Node, required when this same code runs inside
          // the packaged app: `process.execPath` is the Electron binary there,
          // and without the flag spawning it launches a second copy of the app
          // instead of running the CLI.
          ELECTRON_RUN_AS_NODE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const emit = (buf) => onOutput?.(sanitizeOutput(String(buf)));  // install: no test, no secrets
      child.stdout.on("data", emit);
      child.stderr.on("data", emit);
      child.on("error", (error) => {
        resolveInstall({ ok: false, reason: String(error?.message ?? error) });
      });
      child.on("close", (code) => {
        resolveInstall(
          code === 0
            ? { ok: true }
            : { ok: false, reason: "install-failed", exitCode: code ?? -1 },
        );
      });
    });
  }

  /** Write-if-different through an atomic rename, mirroring the app's
   *  `writeIfChanged`. Both matter with several tests in flight: rewriting
   *  unconditionally means one run can be truncating a fixture while another's
   *  Playwright process is reading it, and a plain write is not atomic. */
  function writeIfChanged(filePath, content) {
    try {
      if (fs.readFileSync(filePath, "utf-8") === content) return;
    } catch {
      // Missing or unreadable — fall through and write it.
    }
    const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, filePath);
  }

  /**
   * The files a spec needs beside it. `ALWAYS_WRITTEN` really is always: the
   * spec runtime is IMPORTED by any generated spec that uses a helper, so it is
   * a dependency rather than a feature — and it was written only by the app
   * until now, which meant an MCP or CLI run worked exactly when the app had
   * happened to run that test on the same machine first.
   */
  function ensureRunFixtures(scriptsDir, { capabilities = false } = {}) {
    for (const { file, source } of ALWAYS_WRITTEN) {
      writeIfChanged(path.join(scriptsDir, file), source);
    }
    if (!capabilities) return;
    // Written as a SET: the capture fixture imports the others, so writing it
    // without them beside it is an import error rather than a disabled feature.
    // What each one DOES is decided by the environment, not by its existence.
    for (const { file, source } of CAPABILITY_FIXTURES) {
      writeIfChanged(path.join(scriptsDir, file), source);
    }
  }

  /**
   * Turn the heal fixture's scratch output into this run's artifacts.
   *
   * The fixture writes `heals.json` and `matches.json` into GLAZE_HEAL_DIR as
   * it goes; every reader — `get_step_matches`, the failure view, the app's own
   * artifact store — asks for `step-matches.json` and `heal-failures.json` in
   * the RUN's artifact directory instead. The app's collector does this
   * conversion and also journals the heals; this does the file half only,
   * because journalling means writing back into a library that dies with the
   * container.
   *
   * Envelope and discriminator both come from shared/heal-artifacts.mjs: two
   * writers of one artifact format is a run whose evidence is simply not found.
   *
   * Best-effort throughout, and it removes the scratch directory on every path
   * out — including the common one where nothing healed and the fixture wrote
   * nothing at all. Returns what it saw, for the run's own reporting.
   */
  function collectHealEvidence(env, artifactDir, testId, runId) {
    const healDir = env.GLAZE_HEAL_DIR;
    const none = { healed: 0, failed: 0, matched: 0 };
    if (!healDir) return none;
    const out = { ...none };
    const readJson = (file) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(healDir, file), "utf-8"));
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        // The common case is that the file does not exist — nothing failed to
        // resolve. A corrupt one is the same answer: no data for this run.
        return null;
      }
    };
    const write = (name, entries) => {
      if (!entries.length) return;
      try {
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(
          path.join(artifactDir, name),
          JSON.stringify(healArtifactEnvelope(testId, runId, entries), null, 2),
          "utf-8",
        );
      } catch {
        // Evidence is a diagnostic aid. Failing to persist it must never become
        // a second failure on top of whatever the run already reported.
      }
    };
    const events = readJson(HEAL_EVENTS_FILE) ?? [];
    const failures = events.filter(isHealFailure);
    out.healed = events.length - failures.length;
    out.failed = failures.length;
    write("heal-failures.json", failures);
    const matches = readJson(HEAL_MATCHES_FILE) ?? [];
    out.matched = matches.length;
    write("step-matches.json", matches);
    // The scratch directory goes on EVERY path out, the map with it. The app's
    // collector learned this the hard way: cleaning only on the heals path left
    // a directory behind for good whenever a run failed to heal.
    try {
      fs.rmSync(healDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    if (env.GLAZE_HEAL_MAP) {
      try {
        fs.rmSync(env.GLAZE_HEAL_MAP, { force: true });
      } catch {
        // best-effort
      }
    }
    return out;
  }

  /**
   * The `node_modules` link beside the specs, and it REPAIRS a stale one rather
   * than only creating a missing one.
   *
   * The app's runner learned this and this copy did not — see the long comment
   * on `ensureModuleResolution` in `main/services/playwright-runner.ts`, which
   * documents both failure modes. They are worse here, because THIS is the path
   * a copied library reaches: R10 exists so a library can be handed to a runner,
   * and a library that has ever been run carries an absolute link to the
   * node_modules of the machine that ran it.
   *
   *  - **The old tree is still on disk** (two installs on one machine — a source
   *    checkout and a packaged app, or the app and this CLI). The CLI runs from
   *    OUR node_modules while the spec resolves a SECOND @playwright/test
   *    through the link. Playwright compares module identity, not version, so
   *    collection dies with "Playwright Test did not expect test() to be called
   *    here" and then "No tests found".
   *  - **The old tree is gone** (the library was copied to a CI runner). The
   *    link dangles. `fs.existsSync` FOLLOWS symlinks, so it answers false for a
   *    dangling one; the old code read that as "no link here", called
   *    `symlinkSync`, got EEXIST because the path is occupied, and carried on
   *    with the broken link in place.
   *
   * Both end in the same message, and it names four possible causes of which
   * none is this one — it sends the reader to their own package.json. Verified
   * by reproducing each against a library copied out of one tree and run from
   * another.
   *
   * Hence `lstat` rather than `existsSync`: the question is what the link IS,
   * not what it points at. A real directory is left alone — that is someone's
   * own install, not ours to delete.
   */
  function ensureModuleResolution(scriptsDir, nodeModules) {
    const link = path.join(scriptsDir, "node_modules");
    try {
      const entry = fs.lstatSync(link, { throwIfNoEntry: false });
      if (entry) {
        if (!entry.isSymbolicLink()) return;
        // Resolved against the link's own directory so a relative target
        // compares correctly. Deliberately NOT realpath: that throws on a
        // dangling link, which is precisely the case to repair.
        const target = path.resolve(scriptsDir, fs.readlinkSync(link));
        if (target === path.resolve(nodeModules)) return;
        fs.unlinkSync(link);
      }
      fs.symlinkSync(nodeModules, link, "dir");
    } catch {
      // best-effort; NODE_PATH env still lets Node resolve @playwright/test —
      // though ESM imports do not consult it, so this is a degraded state and
      // not a supported one.
    }
  }

  /** Write the shared playwright config beside the specs, and return its path.
   *
   *  ALWAYS rewritten, matching the app. The old "only if absent" form is how the
   *  MCP's own config — which had no `timeout` line — could outlive the app's and
   *  silently hand a later run Playwright's built-in default. */
  function ensurePlaywrightConfig(scriptsDir) {
    const configPath = path.join(scriptsDir, PLAYWRIGHT_CONFIG_FILE);
    // Write-if-different, via an atomic rename. Both matter now that run_batch
    // runs several tests at once: rewriting unconditionally means one run can be
    // truncating the file while another's Playwright process is reading it, and a
    // plain write is not atomic. The contents come from shared/, so the app and
    // this server cannot disagree about them — see that file.
    try {
      if (fs.readFileSync(configPath, "utf-8") === playwrightConfigSource) return configPath;
    } catch {
      // Missing or unreadable — fall through and write it.
    }
    const tmp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, playwrightConfigSource, "utf-8");
    fs.renameSync(tmp, configPath);
    return configPath;
  }

  /**
   * Run one recorded test to completion and persist its RunRecord.
   * Shared by run_test and run_batch so the two can't drift in how they invoke
   * Playwright or what they record.
   *
   * @returns {{ runId, status, exitCode, startedAt, finishedAt, durationMs, output, timeoutMs, timeoutRaised, speed, ran }}
   */
  async function executeTest(
    test,
    {
      playwright,
      browser,
      batchId,
      vars,
      datasetId,
      datasetName,
      speed: speedOverride,
      baseUrl: baseUrlOverride,
      retries = 0,
    },
  ) {
    // The scripts ROOT, not the spec's own directory. An imported test's spec
    // lives in a sandbox subdirectory beside the sibling modules it imports, so
    // deriving the root from the spec would drop a config and a node_modules
    // link into that sandbox — and resolve the spec against the wrong base.
    const scriptsDir = scriptsDirFor(path.join(dataDir, "recorder"));
    ensureModuleResolution(scriptsDir, playwright.nodeModules);
    const configPath = ensurePlaywrightConfig(scriptsDir);

    // Minted before the spawn, not after, because it names this run's Playwright
    // output directory. Playwright derives that directory from the SPEC's path by
    // default, so with run_batch running several tests at once, two runs of one
    // spec would write to — and clean — the same folder mid-flight.
    const runId = randomUUID();
    const outputDir = path.join(scriptsDir, "test-results", runId);

    // ONE read of the settings file, used for all three decisions below. It was
    // read twice per run, which is not just wasteful: two reads are two answers
    // if the app writes between them, and the pace a run went at would then
    // disagree with the proxy it went through.
    const settings = readSettings();
    // Read once beside the settings, and for the same reason: two reads are two
    // answers if the app writes between them, and a rule armed by one and not
    // the other is a run that dismisses a banner it did not report arming.
    const overlayRules = readOverlayRules();

    // The same three-layer rule the app resolves, through the same function:
    // no override (that is the CLI's `--speed`, not the MCP's), then the test's
    // own pin, then the global default.
    //
    // `test.speed ?? "fast"` is what this said, and R18 turned it into a real
    // divergence: recordings STOPPED stamping their speed, so absent now means
    // INHERIT rather than "nobody chose". Every test recorded since then reads
    // as unpinned, so the app ran it at `defaultRunSpeed` (medium, shipped) and
    // this server ran the same test at fast. Nothing reports it — the run just
    // behaves differently depending on which process started it, which is the
    // exact drift `check:mcp-parity` exists to catch and did not, because it
    // had no rule about how the pace is RESOLVED.
    // The override layer is real now: the CLI's `--speed`. It is deliberately
    // NOT written back to the test — "run this one slowly while I watch it" is a
    // decision about one run, the same contract the app's Pace control has.
    const speed = resolveRunSpeed(speedOverride, test.speed, settings.defaultRunSpeed);

    // The per-test timeout, resolved exactly as the app resolves it: explicit
    // per-test value → the app's global default → 1 minute, then raised to the
    // crawl floor. Ignoring it (which this server did) meant an MCP run used
    // Playwright's own default no matter what the test said — so a test given
    // four minutes for a long flow was failed at one, and one deliberately held
    // to thirty seconds was allowed to run for far longer.
    //
    // It reads `speed` above, which is the other half of why the two have to be
    // resolved together: an inherited `crawl` raises this floor to five minutes,
    // and resolving the pace wrongly silently resolved the timeout wrongly too.
    // ── The base URL this run resolves relative navigations against (R5) ──
    //
    // Override → the test's own record. There is no environment layer yet; R16
    // adds one and it slots between these two, which is why this is a
    // resolution rather than a `??` at the call site.
    //
    // Normalized HERE as well as in the CLI's parser, through the same shared
    // gate: `runSelection` is a function anything in this process can call, and
    // "the caller already validated it" is how an unchecked value gets in.
    const resolvedBaseUrl = normalizeBaseUrl(baseUrlOverride) ?? test.baseUrl;

    const { timeoutMs: testTimeoutMs, raised: timeoutRaised } = resolveTestTimeoutMs(
      test.testTimeoutMs,
      settings.defaultTestTimeoutMs,
      speed,
    );
    // The hard kill must outlive the per-test timeout, or a legitimately long
    // test is killed here before Playwright can report a clean timeout failure.
    const processTimeoutMs = Math.max(RUN_TIMEOUT_MS, testTimeoutMs + PROCESS_TIMEOUT_BUFFER_MS);

    // ── Secrets (R7) ───────────────────────────────────────────────────
    //
    // Resolved from the environment or a --secrets-file, never from the app's
    // encrypted store: this is plain Node, where that API does not exist.
    // `values` is what must be redacted out of everything this run produces,
    // and it is carried alongside the env rather than re-derived from it,
    // because a supplied secret that is not also a redacted one turns a run log
    // into a credential store — the failure R7's own wording warns about.
    const secrets = resolveCiSecrets(test, { env: secretEnv, fileValues: secretFile });

    const env = runEnv({
      base: process.env,
      browsersPath: browsersDir(),
      nodeModules: playwright.nodeModules,
      speed,
      testTimeoutMs,
      outputDir,
      vars,
      // Read straight off the record, exactly as the app reads it. An imported
      // test whose navigations are relative has one; a recorded test does not.
      // Resolved above rather than read straight off the record: R5 lets one run
      // be pointed somewhere else — a PR preview — without editing the test. An
      // imported test whose navigations are relative has a stored one; a
      // recorded test does not, and see the caveat in `runSelection` for why an
      // override on one of those is REPORTED rather than silently ignored.
      baseUrl: resolvedBaseUrl,
      // The proxy settings ride the same file as everything else here. The
      // shared rule inside runEnv turns them into PW_PROXY_* — or into nothing,
      // which is most libraries.
      settings,
    });

    // Merged AFTER runEnv rather than passed into it: runEnv is shared with the
    // app's runner, whose secrets come from a store this process cannot read,
    // and `check:mcp-parity` pins that runEnv itself never mints a
    // GLAZE_SECRET_* key. The injection belongs to the caller that also holds
    // the values for redaction.
    Object.assign(env, secrets.env);

    // MOVED ABOVE THE ENV BLOCK, and that is the whole point of the order.
    // These are `const`, so the `if (anyCapability)` below sits in their
    // TEMPORAL DEAD ZONE if they are declared after it — every run threw
    // `ReferenceError: Cannot access 'anyCapability' before initialization`
    // before it did anything at all. Nothing in the suite executed this
    // function against a real spawn, so 5800 tests and 89 checks were green
    // throughout — see the DECISIONS entry, and `check:cli-exit`, which now
    // reaches it with a planted browser precisely so this cannot recur.
    // ── What this run turns on (R8) ────────────────────────────────────
    //
    // The policy is stated in shared/run-fixtures.mjs; this is it applied. Each
    // gate reads the TEST's own preference where it has one, exactly as the app
    // reads it — an unattended run is not a different product.
    //
    // An IMPORTED spec gets none of it: `sourceDir` means someone else's
    // Playwright project, where redirecting the `@playwright/test` import would
    // rewrite their code rather than instrument ours. Same rule the app applies.
    const imported = Boolean(test.sourceDir);
    const wantsScreenshots =
      !imported && Boolean(test.captureArtifacts ?? settings.defaultCaptureArtifacts);
    const wantsA11y = !imported && Boolean(test.a11yChecks ?? settings.defaultA11yChecks);
    const wantsLogs = !imported && Boolean(test.recordLogs ?? settings.defaultRecordLogs);
    const wantsSettle = !imported && speed === "crawl";
    // ── Run-time healing (R49) ──────────────────────────────────────────
    //
    // ON, and gated exactly as the app gates it: the user's setting, and a test
    // with at least one locator to heal. Without it a run fails on a stale
    // locator the app would have healed past, which is the false red that
    // teaches a team to distrust CI.
    //
    // It was ON here once before and healed NOTHING — see the R49 entry in
    // DECISIONS. The reason was never the switch: the heal fixture rethrows
    // untouched for a locator it has no MAP ENTRY for, and the map holds a probe
    // script per step built from the recorder's locator engine, which was
    // compiled TypeScript this plain-.mjs server could not import. R51 moved the
    // engine to shared/ and the probe builder followed it; the map is buildable
    // here now, and `check:ci-fixtures` asserts a switch that is not "0" implies
    // both a map named through shared/heal-artifacts.mjs AND a writer for it.
    const wantsHeal =
      !imported && Boolean(settings.autoHealEnabled) && (test.steps ?? []).some((st) => st?.locator);
    // ── The WRITEBACK, which stays off ─────────────────────────────────
    //
    // "Suggest, never apply", and it holds by construction rather than by a
    // flag: nothing in this process reads a heal back into a test. It could not
    // usefully — the tests.json it would edit dies with the container, so the
    // fix would be lost and the run would still report a heal it did not keep.
    // `check:ci-fixtures` asserts the absence directly.
    const wantsUserPage =
      !imported && Boolean(settings.userStylesheet || settings.userInitScript);
    // Standing overlay rules, armed by HOST from the test's own starting URL —
    // the same rule the app applies, through the same `armedRulesFor`. There is
    // no setting: a run against a host with no rules arms nothing and pays
    // nothing, which is what makes this safe to have on by default.
    //
    // It could not be on before R51. The fixture's watcher embeds the recorder's
    // locator engine, so a rule taught in the trainer and a rule enforced in a
    // run resolve through ONE `matchesFor` — and until that engine reached
    // shared/, this process could not hold it. A second resolver would have been
    // the worse answer: two implementations of "does this rule match" agree
    // right up until the page they disagree on, and the symptom is a run
    // clicking something nobody chose.
    const armedRules = imported ? [] : armedRulesFor(overlayRules, test.url ?? "");
    const wantsDismiss = armedRules.length > 0;
    const anyCapability =
      wantsScreenshots ||
      wantsA11y ||
      wantsLogs ||
      wantsSettle ||
      wantsHeal ||
      wantsUserPage ||
      wantsDismiss;

    // ── The fixture gates (R8) ─────────────────────────────────────────────
    //
    // Set AFTER runEnv rather than inside it, because runEnv is shared with the
    // app's runner, which computes these from Electron-side state this process
    // does not have. The names are the fixtures' own — they are read by source
    // that Playwright loads, so a rename here is a feature that silently stops
    // firing, which is why `check:ci-fixtures` pins each one.
    const artifactDir = path.join(dataDir, "recorder", "artifacts", test.id, runId);
    if (anyCapability) {
      env.GLAZE_TEST_ID = test.id;
      env.GLAZE_RUN_ID = runId;
      env.GLAZE_CAPTURE_ARTIFACTS = wantsScreenshots ? "1" : "0";
      env.GLAZE_A11Y = wantsA11y ? "1" : "0";
      env.GLAZE_RECORD_LOGS = wantsLogs ? "1" : "0";
      env.GLAZE_SETTLE = wantsSettle ? "1" : "0";
      // Healing, and it is ONE decision: the switch, the map and the directory
      // are set together or not at all. R49 is what a half-set gate looks like —
      // the switch said "1" and the map named a file nothing writes, so the
      // fixture installed itself, patched every locator factory and healed
      // nothing, on every unattended run, with no error anywhere.
      env.GLAZE_HEAL = wantsHeal ? "1" : "0";
      if (wantsScreenshots || wantsA11y || wantsLogs || wantsHeal) {
        fs.mkdirSync(artifactDir, { recursive: true });
        env.GLAZE_ARTIFACT_DIR = artifactDir;
      }
      if (wantsHeal) {
        // The map IS the feature: the fixture rethrows untouched for a key it
        // cannot find. Built through the shared builder so the key matches what
        // the fixture derives from Playwright's factory arguments and the probe
        // ranks candidates the way the trainer does — one implementation of
        // each, which is what R51 made possible.
        //
        // No `describeStep`: it is still app-side, next to its own renderer
        // mirror. Entries carry an empty label and the fixture falls back to the
        // step id, which is a visible difference in an artifact rather than a
        // silent one in the ranking.
        env.GLAZE_HEAL_MAP = path.join(scriptsDir, healMapFileName(runId));
        // The fixture's scratch dir, converted into the two run artifacts below
        // and then removed — the same shape the app's collector has. Nothing
        // here reads a heal back INTO the test: that is the "suggest, never
        // apply" half of the policy, and it holds by construction rather than
        // by a flag, since a writeback would edit a tests.json that dies with
        // the container.
        env.GLAZE_HEAL_DIR = path.join(scriptsDir, healDirName(runId));
        // Seeds: pending cross-test proposals for this test, read from the
        // app's store the same read-only way everything else here reads app
        // data ("suggest, never apply" holds — a seed heals in memory and
        // writes evidence; nothing reads a heal back into a test). A file
        // that is absent, unreadable or hostile yields no seeds, never a
        // failed run: seedsForTest re-derives eligibility per step and the
        // fixture rebuilds every seed through its own factories.
        let seedsByKey = {};
        try {
          const raw = JSON.parse(
            fs.readFileSync(path.join(dataDir, "recorder", "propagations.json"), "utf-8"),
          );
          if (Array.isArray(raw)) {
            seedsByKey = seedsForTest({ test, proposals: raw });
          }
        } catch {
          seedsByKey = {};
        }
        try {
          fs.writeFileSync(
            env.GLAZE_HEAL_MAP,
            JSON.stringify(buildHealMap(test.steps, { seedsByKey })),
            "utf-8",
          );
        } catch {
          // A map that could not be written is a run that does not heal, which
          // is the state this path was already in. It must never take the run
          // down with it.
          delete env.GLAZE_HEAL_MAP;
          delete env.GLAZE_HEAL_DIR;
          env.GLAZE_HEAL = "0";
        }
      }
      if (wantsUserPage) {
        Object.assign(env, userPageEnv(settings));
      }
      // ALWAYS, armed or not: `dismissEnv([])` sets the count to 0, and the
      // capture fixture reads that count to decide whether to install anything.
      // Assigning it only when armed would leave the variable absent, which the
      // fixture reads the same way — but "absent" and "zero" being the same
      // answer by luck is how the heal gate came to be half-set (R49).
      Object.assign(env, dismissEnv(armedRules));
    }

    // ALWAYS, capabilities or not: a generated spec importing a helper needs
    // glaze-runtime.mjs on disk to load at all.
    ensureRunFixtures(scriptsDir, { capabilities: anyCapability });

    // WHERE THE SPEC IS ON THIS MACHINE (R10), which is not necessarily where
    // it was when the test was recorded. `scriptPath` is absolute and from the
    // authoring machine, so a library copied to a CI runner used to resolve
    // through `path.relative` into a `../../../../..`-prefixed path back up to
    // the AUTHOR's home directory — outside the runner's scripts dir, and not a
    // file that exists on it. Playwright reported
    // "no tests found", which reads as broken tests rather than a library that
    // did not arrive.
    const specPath = resolveScriptPath(scriptsDir, test);
    if (!specPath) {
      // Refused rather than guessed: a record whose id cannot name a file is
      // one this process should not invent a path for. Reported as a run that
      // could not start, which is what it is.
      return {
        runId,
        status: "failed",
        exitCode: 1,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
        output:
          `Could not work out where "${test.name ?? test.id}" keeps its spec. Its stored path ` +
          `is outside this library's scripts directory and its id cannot name a file here.\n`,
        timeoutMs: 0,
        timeoutRaised: false,
        ran: {},
        speed,
      };
    }
    // Relative to the scripts root, so a sandboxed spec resolves as
    // `imported/<id>/tests/foo.spec.ts` rather than a bare basename that only
    // matches when the spec sits flat.
    let specFile = path.relative(scriptsDir, specPath);

    // The capture fixture reaches a spec by REDIRECTING its `@playwright/test`
    // import in a temp copy — the stored spec stays pristine, and only the
    // module specifier changes, so line numbers (and therefore every step's
    // screenshot attribution) survive.
    let tempSpecPath = null;
    if (anyCapability) {
      let original = null;
      try {
        original = fs.readFileSync(specPath, "utf-8");
      } catch {
        // Unreadable — run the original path and let Playwright report it.
      }
      const redirected = original === null ? null : redirectToCaptureFixture(original);
      if (redirected !== null) {
        tempSpecPath = path.join(scriptsDir, `${runId}.capture.spec.ts`);
        fs.writeFileSync(tempSpecPath, redirected, "utf-8");
        specFile = path.relative(scriptsDir, tempSpecPath);
      }
    }

    const startedAt = Date.now();
    const { exitCode, output, failedLine, maxAttempt } = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        runArgs({
          cliPath: playwright.cliPath,
          specFile,
          configPath,
          browser,
          testTimeoutMs,
          // Written by `ensureRunFixtures` on every run, capabilities or not —
          // and, until this change, loaded by nothing.
          reporterPath: path.join(scriptsDir, STEP_REPORTER_FILE),
          retries,
        }),
        { cwd: scriptsDir, env },
      );
      let out = "";
      // The step reporter's markers, taken back out of the stream.
      //
      // Two things happen here and they are ONE change. The reporter is loaded
      // now (`--reporter` in runArgs), so `__GLAZE_STEP__:` lines appear on
      // stdout — and every one of them has to be removed before the output is
      // stored or returned, or `get_run_log` reads them straight into an
      // agent's context as junk. Turning the reporter on without stripping is
      // strictly worse than leaving it off, which is why neither half of this
      // ships alone.
      //
      // `buffered` carries the trailing partial line between chunks: a marker
      // can straddle a chunk boundary, and half a marker is neither strippable
      // nor parseable.
      let buffered = "";
      // The last step the reporter said BEGAN. When the run fails, this is the
      // step it failed on — the reporter files a failure against the same line,
      // and `ok: false` is the confirmation rather than the source.
      let lastLine = null;
      let failedLine = null;
      // The highest attempt any marker reported, which is how this path knows a
      // retry happened at all. Playwright says "1 flaky" in its summary line;
      // that is prose, and these markers are already parsed.
      let maxAttempt = 0;
      const take = (chunk) => {
        const split = splitStepMarkers(buffered, chunk);
        buffered = split.rest;
        for (const marker of split.markers) {
          if (marker.event === "begin") lastLine = marker.line;
          if (!marker.ok) failedLine = marker.line;
          if (marker.attempt > maxAttempt) maxAttempt = marker.attempt;
        }
        out += split.visible;
      };
      const timer = setTimeout(() => {
        out += `\n[Timed out after ${Math.round(processTimeoutMs / 60000)} minutes — stopping.]\n`;
        child.kill("SIGKILL");
      }, processTimeoutMs);
      child.stdout.on("data", (d) => take(d.toString()));
      // stderr carries no markers — the reporter writes to stdout — but it is
      // the same stream to the reader, so it is appended without being parsed.
      child.stderr.on("data", (d) => {
        out += d.toString();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // Whatever is left in `buffered` is a line with no newline yet. It is
        // visible output unless it is a marker, and a truncated marker is junk
        // either way — so it goes through the same split with a closing
        // newline rather than being appended raw.
        if (buffered) out += splitStepMarkers(buffered, "\n").visible;
        resolve({
          exitCode: code ?? 1,
          output: out,
          failedLine: failedLine ?? lastLine,
          maxAttempt,
        });
      });
    });
    const finishedAt = Date.now();
    const status = exitCode === 0 ? "passed" : "failed";
    // A reported LINE becomes a step index through the same fallback scan the
    // app uses for a hand-edited spec. Read off the spec this run ACTUALLY ran:
    // a capture run executes a redirected copy, and only the module specifier
    // changes, so the line numbers are the stored spec's — but reading the file
    // that ran is what keeps that true if the redirect ever stops preserving
    // them. Null on any failure, because "we could not say which step" is an
    // honest answer and a wrong index is not.
    let failedStepIndex = null;
    // COUNTED FROM THE SAME MAP as the index, and that is the whole point of
    // carrying it separately from `test.steps.length`. The index is a position
    // among the spec's `await` lines; a disabled step is emitted as a COMMENT
    // and so is not one of them. Pairing a map index with a step-list length
    // therefore reports two different scales as one — a 12-step test with two
    // disabled steps failing on its last emitted step reads "step 10 of 12",
    // which is wrong, plausible, and points the reader at the wrong step. Both
    // numbers come from the spec that actually ran.
    let failedStepCount = null;
    if (status === "failed" && failedLine !== null) {
      try {
        // `specPath`, not `test.scriptPath`: R10 exists because the stored path is
        // the AUTHORING machine's and points nowhere on a runner. Reading the raw
        // field here would throw on a copied library, leave `failedStepIndex` null,
        // and lose the failing step again — silently, and only on the machines this
        // whole feature is for.
        const map = buildStepLineMapFromSource(fs.readFileSync(specPath, "utf-8"));
        const index = map?.get(failedLine);
        if (typeof index === "number") {
          failedStepIndex = index;
          failedStepCount = map.size;
        }
      } catch {
        // Unreadable spec, or a line the map does not cover. Either way the run
        // reports no step rather than a guessed one.
      }
    }
    // Per-run scratch (traces, failure shots). Nothing here reads it, and leaving
    // it would grow one directory per run forever.
    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    // The redirected copy, if this run made one. Named by the run id, so a
    // concurrent run of the same spec is never the one being deleted.
    if (tempSpecPath) {
      try {
        fs.rmSync(tempSpecPath, { force: true });
      } catch {
        // ignore
      }
    }
    // What Auto-Heal did, turned into the two artifacts every reader asks for.
    // Without this the fixture writes its evidence into a scratch directory
    // nothing opens, which is "healed and recorded no evidence of having tried"
    // — the second half of the R49 sentence, and no better than the first.
    const healed = collectHealEvidence(env, artifactDir, test.id, runId);
    const logFile = path.join(dataDir, "recorder", "logs", `${runId}.log`);
    const record = {
      id: runId,
      testId: test.id,
      testName: test.name,
      url: test.url,
      status,
      exitCode,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      logFile,
      captureArtifacts: false,
      // WHICH STEP FAILED, as an INDEX rather than a label.
      //
      // The reporter reports a spec LINE and carries no title, so a label would
      // have to be built from the test's steps — and `describeStep` lives in
      // main/services/script-generator.ts beside its own renderer mirror, which
      // this process cannot import. A second phrasing of it here is the drift
      // this codebase keeps paying for, so the run stores the FACT and each side
      // renders it: `shared/emitters.mjs` falls back to the index, and the app
      // can say the phrase because it has the steps.
      ...(failedStepIndex !== null
        ? { failedStepIndex, stepCount: failedStepCount }
        : {}),
      // These runs are always headless — there's no user at a screen watching
      // an MCP-driven run.
      runHeadless: true,
      runBrowser: browser,
      // Recorded so the app's run history can attribute an MCP-driven run to a
      // speed like any other. Without it these runs show a blank speed and
      // read as "recorded before the field existed".
      speed,
      // WHERE THIS RUN POINTED (R5). Written only when there was one, so a run
      // with no base URL is absent rather than empty — the same shape every
      // other optional field on this record has.
      //
      // The plan asks for it explicitly: an override that is not recorded makes
      // the history misleading, because two runs of one test against two
      // different environments are indistinguishable afterwards and the failing
      // one looks like a regression.
      ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
      // The budget this run actually got. Stored per run rather than read back
      // from the test later: the test's value is the CURRENT one, so a timeout
      // raised since would make every older run's step-vs-budget comparison
      // wrong while still looking like a plausible number.
      testTimeoutMs,
      // WHO started this. Same argument as `speed` above and a stronger one:
      // without it an unattended run is written into the app's history looking
      // exactly like a person pressing Run, and the app has no other way to
      // tell — this path writes run-history.json directly and shares no line of
      // the app's runner.
      //
      // IT WAS THE LITERAL `"mcp"` UNTIL R6, and that is the whole reason it is
      // a parameter now: this module became the run path for TWO entry points
      // when `cli/run.mjs` imported it, and a literal cannot be right for both.
      // Every CLI run, GitHub Action included, was filed as "Started by an MCP
      // client" — wrong in the one surface the field was added to feed, and
      // wrong silently, because a plausible value is exactly what nothing
      // checks. Narrowed at construction, so a caller's typo writes nothing
      // rather than an unvalidated string; absent stays absent.
      ...(runTrigger ? { trigger: runTrigger } : {}),
      // WHERE it came from, when the environment said. Absent on a laptop, and
      // absent is honestly unknown — see shared/run-provenance.mjs.
      ...(runProvenance ? { provenance: runProvenance } : {}),
      // How many attempts this took, and whether the pass came from one. Same
      // rule as the app's runner and the same module, so a run that recovered
      // reads identically wherever it happened — see shared/run-attempts.mjs.
      ...retryFields({ status, maxAttempt }),
      ...(batchId ? { batchId } : {}),
      // Both stored, like the app: the id joins back to the row, and the name
      // survives the row being renamed or deleted. A sweep whose history can't
      // say WHICH row failed is a sweep that answered nothing.
      ...(datasetId ? { datasetId } : {}),
      ...(datasetName ? { datasetName } : {}),
    };

    // ONE choke point for everything written or returned, mirroring the app's
    // `emitOutput`.
    // With THIS run's secret values — see sanitizeOutput.
    //
    // The heal SUMMARY is appended BEFORE this rather than after it. It is
    // counts only and carries nothing to redact today — the point is that it
    // does not become a second exit from this function. Everything returned
    // leaves through one call; a string appended after it is a second path that
    // is safe exactly until somebody makes the summary name the steps, which is
    // the obvious next edit.
    //
    // The fixture already narrates each event to stderr. This is the count,
    // which is what makes "this run healed nothing" distinguishable from "this
    // run was not healing" without reading the whole log.
    const healNote =
      healed.healed || healed.failed
        ? `\n[Auto-Heal] ${healed.healed} healed, ${healed.failed} could not be healed` +
          `${healed.matched ? `, ${healed.matched} step(s) recorded what their locator matched` : ""}\n`
        : "";
    const safeOutput = sanitizeOutput(output + healNote, secrets.values);

    saveRunRecord(
      { ...record, logBytes: Buffer.byteLength(safeOutput, "utf-8") },
      safeOutput,
    );

    // Third of the plan's three ingest points. Best-effort by contract: the run
    // has already happened and is already in run-history.json, so a metrics
    // failure must not reach the caller. Awaited rather than fired and forgotten
    // — this server can exit as soon as the tool returns.
    await recordRun(
      dataDir,
      { ...record, logBytes: Buffer.byteLength(safeOutput, "utf-8") },
      readJsonFile(dataDir, "recorder/heal-journal.json", []),
      safeOutput,
    );

    return {
      runId,
      status,
      exitCode,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      output: safeOutput,
      timeoutMs: testTimeoutMs,
      timeoutRaised,
      // What this run ACTUALLY got (R8), so `describeRun` reports the run that
      // happened rather than the one this server used to be unable to do.
      // Reported off the run for the same reason `speed` is: a caller deriving
      // it a second time is a second chance to derive it differently.
      ran: {
        screenshots: wantsScreenshots,
        accessibility: wantsA11y,
        consoleAndNetwork: wantsLogs,
        // What the run actually installed, which is `wantsHeal` AND a map that
        // was written — the two are set together above, and a map that could
        // not be written turns the switch back off. Reporting the preference
        // instead is what made `ran.autoHeal` claim a capability the run did not
        // have (R49).
        autoHeal: env.GLAZE_HEAL === "1",
        pageSettling: wantsSettle,
        // The rules this run actually armed, by label — not a boolean. A caveat
        // that says "overlay rules did not run" when they did is the same lie as
        // `ran.autoHeal` was, and the labels are what let `describeRun` say
        // WHICH rules instead of whether.
        overlayRules: armedRules.map((r) => r.label || r.host),
      },
      // CARRIED OUT of the run, not left only on the record. `--junit` builds
      // its report from THIS INVOCATION'S results and never reads run history:
      // a report scoped by anything wider could pull in a run the APP produced,
      // whose secrets came from an encrypted store this process cannot read —
      // so it could not be redacted, and would look exactly like a file that
      // had been. Keeping the numbers on the result is what makes that scoping
      // structural rather than a filter someone can widen.
      ...(failedStepIndex !== null
        ? { failedStepIndex, stepCount: failedStepCount }
        : {}),
      // REPORTED, not re-derived by the caller. run_test describes the run it
      // just did (`describeRun` prints the pace and the step delay, and gates
      // `pageSettling` on crawl), and a caller resolving the speed a second time
      // is a second chance to resolve it differently — which is precisely how
      // this drifted. The run says what it went at.
      speed,
    };
  }
  /**
   * Select, plan, run and summarise — everything `run_batch` did except decide
   * how to say it.
   *
   * Returns a RESULT, never MCP content. The four refusals are discriminated by
   * `reason` so each caller can answer in its own vocabulary: the MCP tool
   * renders the same sentences it always did, and the CLI maps them onto its
   * exit codes (2 for a selector that matched nothing, 3 for anything that
   * stopped the run starting). `how` travels with the empty selection because
   * naming the selector that ACTUALLY applied is the whole value of that
   * message — "the library" for an empty folder sends someone to look at the
   * wrong thing.
   */
  async function runSelection({
    testIds,
    tag,
    group,
    browser,
    datasetIds,
    allDatasets,
    parallel,
    retries,
    speed,
    baseUrl,
    vars: varOverrides,
    dryRun,
  }) {
    const engine = browser ?? "chromium";
    if (!RUN_BROWSERS.includes(engine)) {
      return { ok: false, reason: "unknown-browser", browser: engine };
    }

    const { tests: selected, missing } = selectTests(listTests(), { testIds, tag, group });
    if (selected.length === 0) {
      // The selector that actually applied, in the order `selectTests` resolves
      // them.
      const how = testIds
        ? "those ids"
        : group === UNGROUPED
          ? "the tests in no group"
          : group
            ? `group "${group}"`
            : tag
              ? `tag "${tag}"`
              : "the library";
      return { ok: false, reason: "no-match", how };
    }

    // A DRY RUN answers before either of the checks below, deliberately.
    // "What would this run?" is the question someone asks while debugging a
    // runner that has no browser on it yet — refusing to answer it until the
    // environment is complete would make the flag useless exactly when it is
    // wanted. The browser's state is REPORTED instead, as a fact rather than a
    // refusal. An unknown ENGINE still refuses above: that is a bad argument,
    // not an incomplete environment.
    //
    // Placed before `findPlaywrightCli` for the same reason, and after the
    // selection so that an empty selection is still exit 2 — a dry run that
    // matches nothing has found the bug it was run to look for.
    if (dryRun) {
      const byIdDry = new Map(selected.map((t) => [t.id, t]));
      // THE SAME expansion the real run uses, not a description of it. A dry
      // run computed by different code answers a different question, which is
      // worse than not answering: it would be trusted.
      const plannedQueue = buildQueue(
        { testIds: selected.map((t) => t.id), datasetIds, allDatasets },
        (id) => byIdDry.get(id)?.datasets ?? [],
      );
      const dryDefaultSpeed = readSettings().defaultRunSpeed;
      return {
        ok: true,
        dryRun: true,
        browser: engine,
        browserInstalled: isBrowserInstalled(engine),
        parallel: clampParallel(parallel, plannedQueue.length),
        missing,
        plan: plannedQueue.map((entry) => {
          const t = byIdDry.get(entry.testId);
          return {
            testId: entry.testId,
            testName: t?.name ?? entry.testId,
            // Resolved, not read: what it WOULD run at, through the same rule
            // the run resolves. Reporting `t.speed` here would print nothing
            // for every test recorded since R18.
            speed: resolveRunSpeed(speed, t?.speed, dryDefaultSpeed),
            // Named so a sweep's row count is visible; the row's VALUES are not
            // here, for the reason the persisted batch record does not carry
            // them either.
            ...(entry.datasetId ? { datasetId: entry.datasetId } : {}),
            ...(entry.datasetName ? { datasetName: entry.datasetName } : {}),
            // What a run of this test would REFUSE to do. Surfacing it in the
            // dry run is the point: finding out a suite skips half its tests
            // for secrets should not require running it.
            //
            // Resolved through the SAME function the run uses (R7), not the
            // blanket "declares a secret" rule it replaced — otherwise a dry
            // run tells a pipeline that a test will be skipped and then the
            // real run executes it, which is worse than saying nothing.
            ...(() => {
              const unresolved = t
                ? resolveCiSecrets(t, { env: secretEnv, fileValues: secretFile }).missing
                : [];
              return unresolved.length > 0
                ? { wouldSkip: `no value here for secret variable(s): ${unresolved.join(", ")}` }
                : {};
            })(),
          };
        }),
      };
    }

    const playwright = findPlaywrightCli();
    if (!playwright) {
      return { ok: false, reason: "no-playwright", projectRoot: PROJECT_ROOT };
    }
    if (!isBrowserInstalled(engine)) {
      return { ok: false, reason: "no-browser", browser: engine };
    }

    // Expand the selection into the queue actually executed, through the SAME
    // function the app's Batch view uses. Without dataset options the queue is
    // exactly the selection, so an ordinary batch is unchanged.
    const byId = new Map(selected.map((t) => [t.id, t]));
    const queue = buildQueue(
      { testIds: selected.map((t) => t.id), datasetIds, allDatasets },
      (id) => byId.get(id)?.datasets ?? [],
    );

    const batchId = randomUUID();
    const startedAt = Date.now();
    const results = queue.map((entry) => ({
      testId: entry.testId,
      testName: byId.get(entry.testId)?.name ?? entry.testId,
      status: "pending",
      // The row's ID and NAME, never its values: this record is written to
      // batch-history.json, and a dataset row's values have no business on disk
      // in a file the app reads back for display.
      ...(entry.datasetId ? { datasetId: entry.datasetId } : {}),
      ...(entry.datasetName ? { datasetName: entry.datasetName } : {}),
    }));

    // Write-through, matching the app: a crash mid-batch still leaves the
    // results collected so far, and the app's Batch view can watch progress.
    //
    // `currentIndex` is DERIVED rather than passed in: with several tests in
    // flight there's no single current one, and the app reads this field back
    // out of batch-history.json. The lowest running index is the closest honest
    // answer and degrades to the old meaning when only one runs. -1 when idle.
    const persist = (running) => {
      saveBatchRecord({
        batchId,
        running,
        startedAt,
        ...(running ? {} : { finishedAt: Date.now() }),
        currentIndex: results.findIndex((r) => r.status === "running"),
        results,
        stopped: false,
        summary: summarizeResults(results, Date.now() - startedAt),
      });
    };
    persist(true);

    // Over the QUEUE, not the selection: a dataset sweep expands one test into
    // one entry per row, and the pool has to see all of them or a sweep runs
    // one row and reports the rest as pending forever.
    //
    // Running the same test's rows concurrently is safe for exactly the reason
    // run-pool.mjs gives for having no lanes: executeTest mints a fresh uuid per
    // run and each gets its own PW_OUTPUT_DIR, so two runs of one spec never
    // share Playwright's scratch directory.
    const limit = clampParallel(parallel, queue.length);
    await runPool(queue, limit, async (entry, i) => {
      const test = byId.get(entry.testId);
      // Skipped, not failed, and the batch carries on — a suite that aborts, or
      // reports red, because one of its tests happens to log in would make this
      // useless against any real library.
      //
      // R7 narrowed WHEN this fires. It used to fire for any test declaring a
      // secret, because there was no way to supply one. Now it fires only for
      // the names that actually resolved to nothing, so a pipeline that sets
      // its credentials runs the test — and one that sets some of them is told
      // exactly which are missing rather than that "secrets are unavailable".
      const unresolved = test
        ? resolveCiSecrets(test, { env: secretEnv, fileValues: secretFile }).missing
        : [];
      if (unresolved.length > 0) {
        results[i].status = "skipped";
        // The message names the variables to SET. It never echoes a value, and
        // it cannot: `missing` is a list of declared names, and a name that
        // resolved is not in it.
        results[i].note = describeMissingSecrets(test, unresolved);
        results[i].finishedAt = Date.now();
        results[i].durationMs = 0;
        persist(true);
        return;
      }

      results[i].status = "running";
      results[i].startedAt = Date.now();
      persist(true);

      // One test failing must not abort the batch — that's the whole point of
      // running a suite. runPool swallows a throw as a backstop, but the record
      // has to be written here or the entry would sit at "running" forever.
      try {
        const r = await executeTest(test, {
          playwright,
          browser: engine,
          batchId,
          // Read from the QUEUE entry, not from `results`: the values belong in
          // the child process's env and nowhere near the persisted batch record.
          // The dataset row's values, with any `--var` LAYERED OVER them.
          // Explicit beats stored, which is the same precedence `--speed` has
          // over the test's own pin: a value typed at the command line is a
          // decision about this run, and a row that also names it is the
          // default it is overriding.
          vars:
            varOverrides && Object.keys(varOverrides).length > 0
              ? { ...entry.vars, ...varOverrides }
              : entry.vars,
          datasetId: entry.datasetId,
          datasetName: entry.datasetName,
          // Undefined for an MCP batch, which has no override; `resolveRunSpeed`
          // skips it and the test's own layers decide, exactly as before.
          speed,
          // Same shape, same reason: the CLI's `--base-url`, absent everywhere
          // else, and the test's own record decides when it is.
          baseUrl,
          // The CLI's `--retries`. Absent for an MCP call and for the app, both
          // of which run each test once; `runArgs` omits the flag entirely
          // rather than passing 0, so a spec that configures its own retries
          // still gets them.
          retries,
        });
        results[i].status = r.status;
        results[i].exitCode = r.exitCode;
        results[i].runRecordId = r.runId;
        results[i].finishedAt = r.finishedAt;
        results[i].durationMs = r.durationMs;
        // Only when the run said which step. `undefined` is what a reader turns
        // into "no step recorded", and a zero would name the first one.
        if (r.failedStepIndex !== undefined) {
          results[i].failedStepIndex = r.failedStepIndex;
          results[i].stepCount = r.stepCount;
        }
      } catch (err) {
        results[i].status = "failed";
        results[i].note = String(err);
        results[i].finishedAt = Date.now();
        results[i].durationMs = Math.max(
          0,
          results[i].finishedAt - (results[i].startedAt ?? results[i].finishedAt),
        );
      }
      persist(true);
    });

    const finishedAt = Date.now();
    const summary = summarizeResults(results, finishedAt - startedAt);
    persist(false);

    // Said once for the batch rather than per result: every run in it went
    // through the same fixture-free path, and repeating that per row would
    // bury the results. Reported against the tests actually queued, so a suite
    // that wanted none of it is told nothing.
    const settings = readSettings();
    const signatures = readSignatures();
    // One read for the whole batch, threaded into both the `ran` below and
    // `describeRun`'s own `overlayRules`. Reading it twice is two answers.
    const allOverlayRules = readOverlayRules();
    const fixturesSkipped = [
      ...new Set(
        [...byId.values()].flatMap(
          (t) =>
            describeRun(t, settings, {
              // Resolved, not read: `pageSettling` below is `speed === "crawl"`,
              // so a test inheriting crawl from the default would be REPORTED as
              // not settling while the run it describes actually does. Same rule
              // as executeTest, for the same reason.
              speed: resolveRunSpeed(speed, t.speed, settings.defaultRunSpeed),
              // What the batch's runs got. Keyed off the same conditions
              // `executeTest` applies, and an IMPORTED spec gets none of it —
              // redirecting someone else's `@playwright/test` import would
              // rewrite their project rather than instrument ours.
              ran: t.sourceDir
                ? {}
                : {
                    screenshots: Boolean(t.captureArtifacts ?? settings.defaultCaptureArtifacts),
                    accessibility: Boolean(t.a11yChecks ?? settings.defaultA11yChecks),
                    consoleAndNetwork: Boolean(t.recordLogs ?? settings.defaultRecordLogs),
                    // Keyed off the same conditions executeTest applies. A
                    // batch that claimed healing its runs did not do is the R49
                    // shape one caller over, so this tracks the gate rather
                    // than being written by hand.
                    autoHeal:
                      Boolean(settings.autoHealEnabled) &&
                      (t.steps ?? []).some((st) => st?.locator),
                    pageSettling:
                      resolveRunSpeed(speed, t.speed, settings.defaultRunSpeed) === "crawl",
                    // Armed per test by host, exactly as executeTest arms them.
                    overlayRules: armedRulesFor(allOverlayRules, t.url ?? "").map(
                      (r) => r.label || r.host,
                    ),
                  },
              timeoutMs: 0,
              timeoutRaised: false,
              signatures,
              overlayRules: allOverlayRules,
            }).skipped ?? [],
        ),
      ),
    ];

    // ── An override that could not apply says so, and names the remedy ──
    //
    // THIS IS THE HALF THAT MATTERS, because the limitation is already a
    // measured finding on this tree rather than a guess. See DECISIONS,
    // 2026-08-22: `use.baseURL` resolves RELATIVE navigations only, the
    // generator emits a recorded `goto` as the absolute URL the recorder
    // watched, and against two real servers "the absolute spec still landed on
    // origin A while the relative spec followed to B". A per-run PW_BASE_URL
    // "moves imported suites and nothing else".
    //
    // So this override is real for an IMPORTED spec — `page.goto("/")`, which
    // is how a hand-written suite is idiomatically written — and inert for a
    // recorded one. A flag that changes nothing is not a bug; a flag that
    // changes nothing WITHOUT SAYING SO is how an operator points a pipeline at
    // a PR preview, watches it go green, and reads results from production.
    //
    // The message NAMES THE THING THAT DOES WORK. "Nothing resolves against it"
    // is half an answer: the app already ships the other half — declare the
    // site address as a variable (`origin-variable.ts`, Variables panel), which
    // rewrites every URL in the test onto `${name}` and takes a value per run
    // through GLAZE_VARS. Sending someone away with a diagnosis and no
    // treatment is the same disservice as saying nothing.
    //
    // Counted rather than named: a suite of sixty would otherwise print sixty
    // lines of one fact.
    if (normalizeBaseUrl(baseUrl)) {
      const unaffected = [...byId.values()].filter((t) => !t.sourceDir).length;
      if (unaffected > 0) {
        fixturesSkipped.push(
          `Base URL override on ${unaffected} recorded test${unaffected === 1 ? "" : "s"} — ` +
            `their navigations are absolute, so nothing resolves against it. ` +
            `To re-point a recorded test, make its site address a variable ` +
            `(Variables panel) and pass the value with --var`,
        );
      }
    }

    // ── A variable nobody declared is almost always a typo ─────────────
    //
    // The generator substitutes DECLARED names only, so an unknown one is inert
    // rather than dangerous — which is exactly why it has to be said out loud.
    // `--var sight=https://pr-42.test` runs the whole suite against production
    // and exits 0, and nothing about the output looks wrong. Same family as the
    // base-URL caveat above and as exit code 2: the failure mode here is never
    // a wrong answer, it is a confident one about nothing.
    if (varOverrides) {
      const declared = new Set(
        [...byId.values()].flatMap((t) => (t.variables ?? []).map((v) => v?.name)),
      );
      const unknown = Object.keys(varOverrides).filter((n) => !declared.has(n));
      if (unknown.length > 0) {
        fixturesSkipped.push(
          `--var ${unknown.join(", ")} — no selected test declares ` +
            `${unknown.length === 1 ? "that variable" : "those variables"}, so ` +
            `${unknown.length === 1 ? "it is" : "they are"} substituted nowhere`,
        );
      }
    }

    return {
      ok: true,
      batchId,
      browser: engine,
      parallel: limit,
      missing,
      summary,
      fixturesSkipped,
      results,
    };
  }

  return { findPlaywrightCli, isBrowserInstalled, installBrowser, executeTest, runSelection };
}
