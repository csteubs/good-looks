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
import { recordRun } from "./metrics.mjs";
import { clampParallel, runPool } from "./run-pool.mjs";
import { selectTests, summarizeResults, UNGROUPED } from "./select-tests.mjs";
import {
  describeRun,
  runArgs,
  runEnv,
  sanitizeOutput,
  secretVariableNames,
} from "./run-plan.mjs";
import { buildQueue } from "../shared/batch-queue.mjs";
import { browserInstalledIn, expectedBrowserDirs } from "../shared/browser-install.mjs";
import {
  PLAYWRIGHT_CONFIG_FILE,
  playwrightConfigSource,
} from "../shared/playwright-config-source.mjs";
import { resolveTestTimeoutMs } from "../shared/run-pacing.mjs";

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
 * @param {{ dataDir: string, store: ReturnType<import("./store.mjs").createStore> }} deps
 */
export function createRunner({ dataDir, store }) {
  const { listTests, readSettings, readSignatures, readOverlayRules, saveRunRecord, saveBatchRecord } =
    store;

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
    const dir = path.join(dataDir, "recorder", "browsers");
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

  function ensureModuleResolution(scriptsDir, nodeModules) {
    const link = path.join(scriptsDir, "node_modules");
    if (fs.existsSync(link)) return;
    try {
      fs.symlinkSync(nodeModules, link, "dir");
    } catch {
      // best-effort; NODE_PATH env still lets Node resolve @playwright/test
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
   * @returns {{ runId, status, exitCode, startedAt, finishedAt, durationMs, output, timeoutMs, timeoutRaised }}
   */
  async function executeTest(test, { playwright, browser, batchId, vars, datasetId, datasetName }) {
    // The scripts ROOT, not the spec's own directory. An imported test's spec
    // lives in a sandbox subdirectory beside the sibling modules it imports, so
    // deriving the root from the spec would drop a config and a node_modules
    // link into that sandbox — and resolve the spec against the wrong base.
    const scriptsDir = path.join(dataDir, "recorder", "scripts");
    ensureModuleResolution(scriptsDir, playwright.nodeModules);
    const configPath = ensurePlaywrightConfig(scriptsDir);

    // Minted before the spawn, not after, because it names this run's Playwright
    // output directory. Playwright derives that directory from the SPEC's path by
    // default, so with run_batch running several tests at once, two runs of one
    // spec would write to — and clean — the same folder mid-flight.
    const runId = randomUUID();
    const outputDir = path.join(scriptsDir, "test-results", runId);

    const speed = test.speed ?? "fast";
    // The per-test timeout, resolved exactly as the app resolves it: explicit
    // per-test value → the app's global default → 1 minute, then raised to the
    // crawl floor. Ignoring it (which this server did) meant an MCP run used
    // Playwright's own default no matter what the test said — so a test given
    // four minutes for a long flow was failed at one, and one deliberately held
    // to thirty seconds was allowed to run for far longer.
    const { timeoutMs: testTimeoutMs, raised: timeoutRaised } = resolveTestTimeoutMs(
      test.testTimeoutMs,
      readSettings().defaultTestTimeoutMs,
      speed,
    );
    // The hard kill must outlive the per-test timeout, or a legitimately long
    // test is killed here before Playwright can report a clean timeout failure.
    const processTimeoutMs = Math.max(RUN_TIMEOUT_MS, testTimeoutMs + PROCESS_TIMEOUT_BUFFER_MS);

    const env = runEnv({
      base: process.env,
      browsersPath: path.join(dataDir, "recorder", "browsers"),
      nodeModules: playwright.nodeModules,
      speed,
      testTimeoutMs,
      outputDir,
      vars,
      // Read straight off the record, exactly as the app reads it. An imported
      // test whose navigations are relative has one; a recorded test does not.
      baseUrl: test.baseUrl,
      // The proxy settings ride the same file as everything else here. The
      // shared rule inside runEnv turns them into PW_PROXY_* — or into nothing,
      // which is most libraries.
      settings: readSettings(),
    });
    // Relative to the scripts root, so a sandboxed spec resolves as
    // `imported/<id>/tests/foo.spec.ts` rather than a bare basename that only
    // matches when the spec sits flat.
    const specFile = path.relative(scriptsDir, test.scriptPath);

    const startedAt = Date.now();
    const { exitCode, output } = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        runArgs({
          cliPath: playwright.cliPath,
          specFile,
          configPath,
          browser,
          testTimeoutMs,
        }),
        { cwd: scriptsDir, env },
      );
      let out = "";
      const timer = setTimeout(() => {
        out += `\n[Timed out after ${Math.round(processTimeoutMs / 60000)} minutes — stopping.]\n`;
        child.kill("SIGKILL");
      }, processTimeoutMs);
      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.stderr.on("data", (d) => {
        out += d.toString();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, output: out });
      });
    });
    const finishedAt = Date.now();
    const status = exitCode === 0 ? "passed" : "failed";
    // Per-run scratch (traces, failure shots). Nothing here reads it, and leaving
    // it would grow one directory per run forever.
    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
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
      // These runs are always headless — there's no user at a screen watching
      // an MCP-driven run.
      runHeadless: true,
      runBrowser: browser,
      // Recorded so the app's run history can attribute an MCP-driven run to a
      // speed like any other. Without it these runs show a blank speed and
      // read as "recorded before the field existed".
      speed,
      // The budget this run actually got. Stored per run rather than read back
      // from the test later: the test's value is the CURRENT one, so a timeout
      // raised since would make every older run's step-vs-budget comparison
      // wrong while still looking like a plausible number.
      testTimeoutMs,
      // WHO started this. Same argument as `speed` above and a stronger one:
      // without it an MCP-driven run is written into the app's history looking
      // exactly like a person pressing Run, and the app has no other way to tell
      // — this server writes run-history.json directly and shares no line of the
      // app's runner. A literal rather than an import because there is one value
      // to write, but it is a literal the APP validates: run-history-store
      // narrows an unrecognised trigger to undefined, so a typo here would not
      // fail, it would silently write MCP runs as unattributed. So check:mcp-parity
      // §14 does not match a string — it runs what this literal says through the
      // app's own normalizeRunTrigger, the function that would have dropped it.
      trigger: "mcp",
      ...(batchId ? { batchId } : {}),
      // Both stored, like the app: the id joins back to the row, and the name
      // survives the row being renamed or deleted. A sweep whose history can't
      // say WHICH row failed is a sweep that answered nothing.
      ...(datasetId ? { datasetId } : {}),
      ...(datasetName ? { datasetName } : {}),
    };

    // ONE choke point for everything written or returned, mirroring the app's
    // `emitOutput`.
    const safeOutput = sanitizeOutput(output);

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
      // Skipped, not failed, and the batch carries on. A suite that aborts —
      // or reports red — because one of its tests happens to log in would make
      // run_batch useless against any real library.
      const secrets = test ? secretVariableNames(test) : [];
      if (secrets.length > 0) {
        results[i].status = "skipped";
        results[i].note =
          `Declares secret variable${secrets.length === 1 ? "" : "s"} (${secrets.join(", ")}), ` +
          "which are encrypted to the app and unreadable from here. Run it from the app.";
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
          vars: entry.vars,
          datasetId: entry.datasetId,
          datasetName: entry.datasetName,
        });
        results[i].status = r.status;
        results[i].exitCode = r.exitCode;
        results[i].runRecordId = r.runId;
        results[i].finishedAt = r.finishedAt;
        results[i].durationMs = r.durationMs;
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
    const fixturesSkipped = [
      ...new Set(
        [...byId.values()].flatMap(
          (t) =>
            describeRun(t, settings, {
              speed: t.speed ?? "fast",
              timeoutMs: 0,
              timeoutRaised: false,
              signatures,
              overlayRules: readOverlayRules(),
            }).skipped ?? [],
        ),
      ),
    ];

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

  return { findPlaywrightCli, isBrowserInstalled, executeTest, runSelection };
}
