#!/usr/bin/env node
// mcp/server.mjs — exposes Good Looks!'s recorded Playwright tests and run
// history to MCP clients (Claude Code, Codex, etc). Standalone: works whether
// or not the app is open, since it reads/writes the same userData files the
// backend uses.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readJsonFile, resolveDataDir, writeJsonFile } from "./glaze-data.mjs";
import { selectTests, summarizeResults, UNTAGGED } from "./select-tests.mjs";
import { clampParallel, MAX_PARALLEL, runPool } from "./run-pool.mjs";
import { listSessions, readShots, requestCapture } from "./debug-shots.mjs";
import { readReplay, readRunLogs } from "./artifacts.mjs";
import { recordRun } from "./metrics.mjs";
import {
  consoleNetworkWithheldReason,
  datasetRow,
  describeRun,
  runArgs,
  runEnv,
  sanitizeOutput,
  secretVariableNames,
} from "./run-plan.mjs";
import { buildQueue } from "../shared/batch-queue.mjs";
import { compareReplays } from "../shared/run-comparison.mjs";
import {
  PLAYWRIGHT_CONFIG_FILE,
  playwrightConfigSource,
} from "../shared/playwright-config-source.mjs";
import { resolveTestTimeoutMs } from "../shared/run-pacing.mjs";
import { stripAnsi } from "../shared/strip-ansi.mjs";

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
const MAX_RUN_RECORDS = 1000;
const MAX_BATCH_RECORDS = 50; // mirrors main/services/batch-history-store.ts
const RUN_BROWSERS = ["chromium", "firefox", "webkit"];
const OUTPUT_TAIL_CHARS = 4000;
const LOG_TAIL_CHARS = 20000;

const dataDir = resolveDataDir();

if (process.argv.includes("--print-data-dir")) {
  console.log(dataDir);
  process.exit(0);
}

function listTests() {
  return readJsonFile(dataDir, "recorder/tests.json", []);
}

function listRuns() {
  return readJsonFile(dataDir, "recorder/run-history.json", []);
}

function listBatches() {
  return readJsonFile(dataDir, "recorder/batch-history.json", []);
}

/** The app's global preferences. Read fresh per run rather than cached: this
 *  process outlives many app sessions, and a stale `defaultTestTimeoutMs` is
 *  exactly the kind of drift this file is being fixed for. */
function readSettings() {
  return readJsonFile(dataDir, "recorder/recorder-settings.json", {});
}


/** Persist a batch in the SAME file and shape the app's batch-history-store
 *  uses, so a batch run from an MCP client shows up in the app's Batch view. */
function saveBatchRecord(record) {
  const all = listBatches().filter((b) => b.batchId !== record.batchId);
  all.push(record);
  all.sort((a, b) => b.startedAt - a.startedAt);
  writeJsonFile(dataDir, "recorder/batch-history.json", all.slice(0, MAX_BATCH_RECORDS));
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

/** Playwright unpacks each engine as `<engine>-<revision>`. Match the trailing
 *  dash: Chromium also ships a `chromium_headless_shell-*` directory, which is
 *  not a usable browser, so a bare startsWith("chromium") reports a
 *  shell-only install as complete and the run then fails at launch. */
function isBrowserInstalled(browser = "chromium") {
  const dir = path.join(dataDir, "recorder", "browsers");
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.startsWith(`${browser}-`));
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

function saveRunRecord(record, logText) {
  fs.mkdirSync(path.dirname(record.logFile), { recursive: true });
  fs.writeFileSync(record.logFile, logText, "utf-8");

  const runs = listRuns();
  runs.push(record);
  runs.sort((a, b) => a.startedAt - b.startedAt);
  while (runs.length > MAX_RUN_RECORDS) {
    const dropped = runs.shift();
    if (dropped) {
      try {
        fs.rmSync(dropped.logFile, { force: true });
      } catch {
        // ignore
      }
    }
  }
  writeJsonFile(dataDir, "recorder/run-history.json", runs);
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

const server = new McpServer({ name: "good-looks", version: "1.0.0" });

server.registerTool(
  "list_tests",
  {
    title: "List recorded tests",
    description:
      "List the recorded Playwright tests: id, name, target URL, step count, and timestamps. Newest-updated first, capped at 200.",
    inputSchema: {},
  },
  async () => {
    const tests = listTests()
      .filter((t) => !t.hidden)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map((t) => ({
        id: t.id,
        name: t.name,
        url: t.url,
        stepCount: Array.isArray(t.steps) ? t.steps.length : 0,
        tags: t.tags ?? [],
        speed: t.speed ?? "fast",
        runBrowser: t.runBrowser ?? "chromium",
        scriptEdited: Boolean(t.scriptEdited),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
    return { content: [{ type: "text", text: JSON.stringify(tests, null, 2) }] };
  },
);

server.registerTool(
  "get_test",
  {
    title: "Get test detail",
    description:
      "Return one recorded test's full step list and its generated Playwright spec source, by test id (see list_tests). Also reports the variables it declares (secret ones by name only — their values are encrypted to the app), the dataset rows it can be swept over, and the per-test timeout.",
    inputSchema: { testId: z.string() },
  },
  async ({ testId }) => {
    const test = listTests().find((t) => t.id === testId);
    if (!test) {
      return { content: [{ type: "text", text: `No test found with id ${testId}` }], isError: true };
    }
    let specSource = null;
    try {
      specSource = fs.readFileSync(test.scriptPath, "utf-8");
    } catch {
      // generated spec file missing; steps are still returned
    }
    const detail = {
      id: test.id,
      name: test.name,
      url: test.url,
      steps: test.steps,
      speed: test.speed ?? "fast",
      scriptEdited: Boolean(test.scriptEdited),
      createdAt: test.createdAt,
      updatedAt: test.updatedAt,
      // Reported so `run_test`'s datasetId is discoverable at all, and so a
      // secret-bearing test is identifiable BEFORE a run is attempted rather
      // than by reading the refusal. A secret's value is never here — it isn't
      // on the record either, only in the encrypted store.
      variables: (test.variables ?? []).map((v) => ({
        name: v.name,
        kind: v.kind,
        ...(v.kind === "secret" ? {} : { value: v.value ?? "" }),
        ...(v.description ? { description: v.description } : {}),
      })),
      datasets: (test.datasets ?? []).map((d) => ({ id: d.id, name: d.name, values: d.values })),
      tags: test.tags ?? [],
      runBrowser: test.runBrowser ?? "chromium",
      testTimeoutMs: test.testTimeoutMs,
      captureArtifacts: test.captureArtifacts,
      a11yChecks: test.a11yChecks,
      recordLogs: test.recordLogs,
      isFlow: Boolean(test.isFlow),
      imported: Boolean(test.sourceDir),
      specSource,
    };
    return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
  },
);

server.registerTool(
  "list_runs",
  {
    title: "List test runs",
    description:
      "List past test runs (pass/fail, duration, timestamps), newest first. Optionally filter to one test id.",
    inputSchema: {
      testId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ testId, limit }) => {
    let runs = listRuns().sort((a, b) => b.startedAt - a.startedAt);
    if (testId) runs = runs.filter((r) => r.testId === testId);
    runs = runs.slice(0, limit ?? 50).map((r) => ({
      id: r.id,
      testId: r.testId,
      testName: r.testName,
      url: r.url,
      status: r.status,
      exitCode: r.exitCode,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
    }));
    return { content: [{ type: "text", text: JSON.stringify(runs, null, 2) }] };
  },
);

server.registerTool(
  "get_run_log",
  {
    title: "Get run log",
    description:
      "Return the raw console output for one past run, by run id (see list_runs). Truncated to the last " +
      LOG_TAIL_CHARS +
      " characters; the full log stays on disk at the run's logFile path.",
    inputSchema: { runId: z.string() },
  },
  async ({ runId }) => {
    const run = listRuns().find((r) => r.id === runId);
    if (!run) {
      return { content: [{ type: "text", text: `No run found with id ${runId}` }], isError: true };
    }
    let log = "";
    try {
      // Stripped on READ as well as on write. Every log written before the
      // write-side strip existed is still on disk full of cursor-up and
      // erase-line sequences, and this tool is what feeds them to a model —
      // where they are context spent on terminal redraws.
      log = stripAnsi(fs.readFileSync(run.logFile, "utf-8"));
    } catch {
      log = "(log file no longer available)";
    }
    const truncated = log.length > LOG_TAIL_CHARS;
    const text = truncated ? log.slice(-LOG_TAIL_CHARS) : log;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...run, truncated, log: text }, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "run_test",
  {
    title: "Run a test",
    description:
      "Run one recorded test locally with the bundled Playwright and report pass/fail. Runs headless. The chosen browser must already be installed (run the test once from the app, which installs it on first use). Records the run in the app's run history so it shows up in Stats too. Pass `datasetId` to run one row of the test's dataset instead of its declared defaults (see get_test). The response's `fixtures` field reports what the run did and what it skipped — read it before drawing conclusions from a failure. Tests declaring secret variables cannot be run from here; their values are encrypted to the app.",
    inputSchema: {
      testId: z.string(),
      browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
      datasetId: z
        .string()
        .optional()
        .describe("Run this dataset row's variable values instead of the declared defaults."),
    },
  },
  async ({ testId, browser, datasetId }) => {
    const test = listTests().find((t) => t.id === testId);
    if (!test) {
      return { content: [{ type: "text", text: `No test found with id ${testId}` }], isError: true };
    }
    const engine = browser ?? test.runBrowser ?? "chromium";

    // Refuse rather than run a test whose credentials this process cannot read.
    // Running it "works": Playwright starts, the spec types empty strings into
    // the login form, and the run fails on an assertion further down with
    // nothing connecting that to a missing secret. An agent then debugs the
    // site. This is the one case where not running is the more useful answer.
    const secrets = secretVariableNames(test);
    if (secrets.length > 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `"${test.name}" declares secret variable${secrets.length === 1 ? "" : "s"} ` +
              `(${secrets.join(", ")}). Their values are encrypted on this machine through the ` +
              "app's secure storage, which only the app process can decrypt — so a run started " +
              "from here would resolve them to empty strings and fail somewhere that looks " +
              "unrelated. Run this test from the app instead. Everything else about it " +
              "(steps, spec source, past runs and their logs) is readable from here.",
          },
        ],
        isError: true,
      };
    }

    let row = null;
    if (datasetId) {
      row = datasetRow(test, datasetId);
      if (!row) {
        const available = (test.datasets ?? []).map((d) => `${d.id} (${d.name})`);
        return {
          content: [
            {
              type: "text",
              text:
                `"${test.name}" has no dataset row with id ${datasetId}. ` +
                (available.length > 0
                  ? `Available rows: ${available.join(", ")}.`
                  : "This test declares no datasets."),
            },
          ],
          isError: true,
        };
      }
    }

    const playwright = findPlaywrightCli();
    if (!playwright) {
      return {
        content: [{ type: "text", text: `Could not find @playwright/test under ${PROJECT_ROOT}/node_modules.` }],
        isError: true,
      };
    }
    if (!isBrowserInstalled(engine)) {
      return {
        content: [
          {
            type: "text",
            text: `${engine} isn't installed yet. Open this test in the app and run it once from the UI on ${engine} (it installs the browser on first run), then retry.`,
          },
        ],
        isError: true,
      };
    }

    const result = await executeTest(test, {
      playwright,
      browser: engine,
      vars: row?.values,
      datasetId: row?.id,
      datasetName: row?.name,
    });
    const outputTail =
      result.output.length > OUTPUT_TAIL_CHARS ? result.output.slice(-OUTPUT_TAIL_CHARS) : result.output;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              runId: result.runId,
              status: result.status,
              exitCode: result.exitCode,
              browser: engine,
              durationMs: result.durationMs,
              ...(row ? { datasetId: row.id, datasetName: row.name } : {}),
              fixtures: describeRun(test, readSettings(), {
                speed: test.speed ?? "fast",
                timeoutMs: result.timeoutMs,
                timeoutRaised: result.timeoutRaised,
              }),
              outputTail,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "run_batch",
  {
    title: "Run many tests",
    description:
      `Run several recorded tests and report an aggregate pass/fail summary. Select them by explicit testIds, by tag (see list_tests; pass "${UNTAGGED}" for tests with no tags), or omit both to run every visible test. Pass allDatasets (or datasetIds) to sweep each selected test once per dataset row instead of once. Tests run headless, one at a time by default — set "parallel" to run that many at once (1-${MAX_PARALLEL}), which is much faster for a large suite at the cost of CPU. A failing test does not stop the batch, and a test declaring secret variables is skipped with a note rather than failing the suite. Each test is recorded in the app's run history, and the batch itself appears in the app's Batch view.`,
    inputSchema: {
      testIds: z.array(z.string()).optional(),
      tag: z.string().optional(),
      browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
      datasetIds: z
        .array(z.string())
        .optional()
        .describe("Sweep only these dataset rows. A selected test with no matching row still runs once."),
      allDatasets: z
        .boolean()
        .optional()
        .describe("Sweep every dataset row each selected test declares."),
      parallel: z.number().int().min(1).max(MAX_PARALLEL).optional(),
    },
  },
  async ({ testIds, tag, browser, datasetIds, allDatasets, parallel }) => {
    const engine = browser ?? "chromium";
    if (!RUN_BROWSERS.includes(engine)) {
      return { content: [{ type: "text", text: `Unknown browser: ${engine}` }], isError: true };
    }

    const { tests: selected, missing } = selectTests(listTests(), { testIds, tag });
    if (selected.length === 0) {
      const how = tag ? `tag "${tag}"` : testIds ? "those ids" : "the library";
      return {
        content: [{ type: "text", text: `No tests matched ${how}. Nothing to run.` }],
        isError: true,
      };
    }

    const playwright = findPlaywrightCli();
    if (!playwright) {
      return {
        content: [{ type: "text", text: `Could not find @playwright/test under ${PROJECT_ROOT}/node_modules.` }],
        isError: true,
      };
    }
    if (!isBrowserInstalled(engine)) {
      return {
        content: [
          {
            type: "text",
            text: `${engine} isn't installed yet. Run a test once from the app on ${engine} (it installs the browser on first run), then retry.`,
          },
        ],
        isError: true,
      };
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
        results[i].durationMs = Math.max(0, results[i].finishedAt - (results[i].startedAt ?? results[i].finishedAt));
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
    const suiteSkips = [
      ...new Set(
        [...byId.values()].flatMap(
          (t) =>
            describeRun(t, settings, {
              speed: t.speed ?? "fast",
              timeoutMs: 0,
              timeoutRaised: false,
            }).skipped ?? [],
        ),
      ),
    ];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              batchId,
              browser: engine,
              parallel: limit,
              ...(missing.length > 0 ? { missingTestIds: missing } : {}),
              summary,
              ...(suiteSkips.length > 0 ? { fixturesSkipped: suiteSkips } : {}),
              results: results.map((r) => ({
                testId: r.testId,
                testName: r.testName,
                status: r.status,
                durationMs: r.durationMs,
                runId: r.runRecordId,
                ...(r.datasetId ? { datasetId: r.datasetId, datasetName: r.datasetName } : {}),
                ...(r.note ? { note: r.note } : {}),
              })),
            },
            null,
            2,
          ),
        },
      ],
      // Surface a failing suite as an error so an agent doesn't read a red
      // batch as success.
      ...(summary.failed > 0 ? { isError: true } : {}),
    };
  },
);

// ── Evidence already on disk ────────────────────────────────────────────────
//
// The app captures far more per run than pass/fail: per-step visual diffs and
// their ratios, accessibility violations against an accepted baseline, console
// and network with per-request latency, every locator Auto-Heal changed, and
// whole batch histories. Until now none of it was reachable from here, so an
// agent asking "why did this fail?" had one log file to reason from while the
// answer sat in five others.
//
// All read-only. Nothing here writes, accepts a baseline, or changes a setting.

/** Resolve the run and its replay, or the reason there isn't one. Shared by the
 *  three tools that read a run's captured evidence so they explain an absent
 *  artifact the same way — "no artifacts" and "run doesn't exist" are different
 *  answers, and collapsing them sends someone looking in the wrong place. */
function replayFor(runId) {
  const run = listRuns().find((r) => r.id === runId);
  if (!run) return { error: `No run found with id ${runId}.` };
  const replay = readReplay(dataDir, run.testId, runId);
  if (!replay) {
    return {
      run,
      error:
        `Run ${runId} ("${run.testName}") captured no artifacts, so there is nothing to report. ` +
        "A run only captures when the test has capture switched on and the run came from the " +
        "app — MCP-driven runs do not capture yet. Retention also prunes older run directories.",
    };
  }
  return { run, replay };
}

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

server.registerTool(
  "get_visual_report",
  {
    title: "Get a run's visual-diff report",
    description:
      "Per-step visual-diff outcome for one captured run: which steps changed against the pinned " +
      "baseline, by how much (the fraction of pixels), at what threshold, and whether the " +
      "comparison was page-wide or scoped to an element. Use this to answer whether a failure " +
      "was accompanied by the page rendering differently. Run ids come from list_runs.",
    inputSchema: { runId: z.string() },
  },
  async ({ runId }) => {
    const { run, replay, error } = replayFor(runId);
    if (error) return errorResult(error);
    const steps = replay.steps
      .filter((s) => s.diff)
      .map((s) => ({
        index: s.index,
        stepId: s.stepId,
        label: s.label,
        status: s.status,
        state: s.diff.state,
        // Reported as a percentage as well as the raw fraction: 0.0064 and
        // "0.65%" are the same number, and only one of them is comparable by
        // eye against a threshold expressed in percent.
        changedPixelsPercent: typeof s.diff.ratio === "number" ? +(s.diff.ratio * 100).toFixed(4) : undefined,
        ratio: s.diff.ratio,
        thresholdPercent: s.diff.threshold,
        scope: s.diff.scope ?? "page",
        ...(s.diff.maskedCount ? { maskedRegions: s.diff.maskedCount } : {}),
        ...(s.diff.reason ? { reason: s.diff.reason } : {}),
      }));
    return jsonResult({
      runId,
      testId: replay.testId,
      testName: replay.testName,
      status: replay.status,
      startedAt: run.startedAt,
      thresholdPercent: replay.visualThreshold,
      failedIndex: replay.failedIndex,
      changedSteps: steps.filter((s) => s.state === "changed").length,
      // Named rather than left as an empty list: "nothing changed" and "nothing
      // was compared" look identical in a list of zero rows.
      comparedSteps: steps.length,
      steps,
    });
  },
);

server.registerTool(
  "get_a11y_report",
  {
    title: "Get a run's accessibility report",
    description:
      "Accessibility violations found during one captured run, per step, separated into ones " +
      "already accepted for this test and ones that are new. Reported only — a run's pass/fail " +
      "is decided by its assertions, never by these. Run ids come from list_runs.",
    inputSchema: { runId: z.string() },
  },
  async ({ runId }) => {
    const { run, replay, error } = replayFor(runId);
    if (error) return errorResult(error);
    const steps = replay.steps
      .filter((s) => s.a11y)
      .map((s) => {
        const newKeys = new Set(s.a11y.newKeys ?? []);
        return {
          index: s.index,
          stepId: s.stepId,
          label: s.label,
          acceptedCount: s.a11y.acceptedCount ?? 0,
          newCount: newKeys.size,
          violations: (s.a11y.violations ?? []).map((v) => ({
            ...v,
            // The accepted/new split is the whole point: against any real site
            // the first run reports dozens of pre-existing problems, and a
            // report that can't say which are NEW is one nobody reads twice.
            isNew: newKeys.has(v.id ?? v.key ?? ""),
          })),
        };
      });
    return jsonResult({
      runId,
      testId: replay.testId,
      testName: replay.testName,
      status: replay.status,
      startedAt: run.startedAt,
      checkedSteps: steps.length,
      newViolationSteps: steps.filter((s) => s.newCount > 0).length,
      a11yMs: run.a11yMs,
      steps,
    });
  },
);

server.registerTool(
  "get_run_logs",
  {
    title: "Get a run's console and network",
    description:
      "The browser console messages and network requests recorded during one captured run, " +
      "keyed to the step that was running. Network entries carry status and latency, so this is " +
      "what answers 'did the server error, or did we look for the wrong thing?'. Only available " +
      "for runs that recorded logs. Run ids come from list_runs.",
    inputSchema: {
      runId: z.string(),
      failuresOnly: z
        .boolean()
        .optional()
        .describe("Return only page errors and non-2xx/failed requests. Defaults to false."),
    },
  },
  async ({ runId, failuresOnly = false }) => {
    const run = listRuns().find((r) => r.id === runId);
    if (!run) return errorResult(`No run found with id ${runId}.`);

    // THE ONE THING THIS SERVER MUST NOT DO — see consoleNetworkWithheldReason
    // for why these are withheld whenever the library holds a secret at all.
    const withheld = consoleNetworkWithheldReason(listTests());
    if (withheld) return errorResult(withheld);

    const logs = readRunLogs(dataDir, run.testId, runId);
    if (!logs) {
      return errorResult(
        `Run ${runId} ("${run.testName}") recorded no console or network. That is per-test ` +
          '("Record console and network" on the test) and only happens on app-driven runs.',
      );
    }
    const consoleEntries = failuresOnly
      ? logs.console.filter((c) => c.type === "pageerror" || c.type === "error")
      : logs.console;
    const network = failuresOnly ? logs.network.filter((n) => !n.ok) : logs.network;
    return jsonResult({
      runId,
      testId: run.testId,
      testName: run.testName,
      status: run.status,
      failuresOnly,
      counts: {
        console: logs.console.length,
        consoleErrors: logs.console.filter((c) => c.type === "pageerror" || c.type === "error").length,
        network: logs.network.length,
        networkFailures: logs.network.filter((n) => !n.ok).length,
      },
      // Said out loud. Entries past the per-run cap are gone, and a report that
      // stays silent about that invites "no request matched" to be read as
      // "the request was never made".
      ...(logs.consoleDropped || logs.networkDropped
        ? {
            truncated: {
              consoleDropped: logs.consoleDropped,
              networkDropped: logs.networkDropped,
              note: "Entries past this run's per-run cap were never written. Absence here is not evidence of absence.",
            },
          }
        : {}),
      headersFiltered: logs.headersFiltered,
      console: consoleEntries,
      network,
    });
  },
);

server.registerTool(
  "list_heals",
  {
    title: "List Auto-Heal events",
    description:
      "Every locator Auto-Heal has changed, newest first: which step, what the locator was and " +
      "became, whether it was actually applied or only suggested, and which run proposed it. " +
      "A step that heals repeatedly is a decaying locator; a step that healed and passed is a " +
      "run that only passed because something was substituted. Optionally filter to one test.",
    inputSchema: {
      testId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ testId, limit }) => {
    let entries = readJsonFile(dataDir, "recorder/heal-journal.json", []);
    if (!Array.isArray(entries)) entries = [];
    const names = new Map(listTests().map((t) => [t.id, t.name]));
    let filtered = entries.filter((e) => !testId || e.testId === testId);
    filtered = filtered.sort((a, b) => b.at - a.at).slice(0, limit ?? 50);
    // Healed-step COUNTS per step, across everything retained. A single heal is
    // an event; the same step healing four times is the finding, and it is
    // invisible in a list sorted by time.
    const perStep = new Map();
    for (const e of entries) {
      if (testId && e.testId !== testId) continue;
      const key = `${e.testId}:${e.stepId}`;
      perStep.set(key, (perStep.get(key) ?? 0) + 1);
    }
    return jsonResult({
      total: entries.filter((e) => !testId || e.testId === testId).length,
      chronicSteps: [...perStep.entries()]
        .filter(([, n]) => n >= 3)
        .map(([key, n]) => ({ key, heals: n }))
        .sort((a, b) => b.heals - a.heals),
      entries: filtered.map((e) => ({
        id: e.id,
        testId: e.testId,
        testName: names.get(e.testId) ?? null,
        stepId: e.stepId,
        stepIndex: e.stepIndex,
        stepLabel: e.stepLabel,
        source: e.source,
        runId: e.runId,
        originalLocator: e.originalLocator,
        appliedLocator: e.appliedLocator,
        applied: e.applied,
        status: e.status,
        at: e.at,
        healsForThisStep: perStep.get(`${e.testId}:${e.stepId}`) ?? 1,
      })),
    });
  },
);

server.registerTool(
  "list_batches",
  {
    title: "List batch runs",
    description:
      "Past batch (suite) runs, newest first: the aggregate summary and each test's outcome, " +
      "including which dataset row it was when the batch was a sweep. This server has written " +
      "this file since run_batch existed but could never read it back.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
      batchId: z.string().optional().describe("Return just this batch, with every result."),
    },
  },
  async ({ limit, batchId }) => {
    const batches = listBatches().sort((a, b) => b.startedAt - a.startedAt);
    if (batchId) {
      const one = batches.find((b) => b.batchId === batchId);
      if (!one) return errorResult(`No batch found with id ${batchId}.`);
      return jsonResult(one);
    }
    return jsonResult(
      batches.slice(0, limit ?? 20).map((b) => ({
        batchId: b.batchId,
        running: b.running,
        startedAt: b.startedAt,
        finishedAt: b.finishedAt,
        stopped: b.stopped,
        summary: b.summary,
        failedTests: (b.results ?? [])
          .filter((r) => r.status === "failed")
          .map((r) => ({
            testName: r.testName,
            runId: r.runRecordId,
            ...(r.datasetName ? { datasetName: r.datasetName } : {}),
          })),
      })),
    );
  },
);

server.registerTool(
  "compare_runs",
  {
    title: "Compare two runs of a test",
    description:
      "Then-vs-now for two captured runs of the same test, per step: stable, fixed, " +
      "changed-since, or still-failing, with each step's visual outcome in the later run. " +
      "A step that passed before and fails now is reported as 'changed-since' rather than as a " +
      "regression — the run alone cannot tell a real regression from environment drift, and " +
      "saying so is the point. Both runs must have captured artifacts.",
    inputSchema: {
      baseRunId: z.string().describe("The earlier run."),
      runId: z.string().describe("The later run to compare against it."),
    },
  },
  async ({ baseRunId, runId }) => {
    const runs = listRuns();
    const base = runs.find((r) => r.id === baseRunId);
    const later = runs.find((r) => r.id === runId);
    if (!base) return errorResult(`No run found with id ${baseRunId}.`);
    if (!later) return errorResult(`No run found with id ${runId}.`);
    if (base.testId !== later.testId) {
      return errorResult(
        `Those runs are of different tests ("${base.testName}" and "${later.testName}"). ` +
          "A step-by-step comparison only means anything within one test.",
      );
    }
    const comparison = compareReplays(
      readReplay(dataDir, base.testId, baseRunId),
      readReplay(dataDir, later.testId, runId),
    );
    if (!comparison) {
      return errorResult(
        "At least one of those runs captured no artifacts, so there is nothing to compare " +
          "step by step. Only runs with capture switched on produce a replay model, and " +
          "retention prunes older run directories.",
      );
    }
    return jsonResult({
      ...comparison,
      testName: base.testName,
      baseStartedAt: base.startedAt,
      startedAt: later.startedAt,
    });
  },
);

// ── Debug screenshots ───────────────────────────────────────────────────────
//
// The app can be read from here — its tests, its runs, its logs — but not SEEN.
// Every UI change in this project so far has been described rather than shown.
// These two tools close that: one asks the app for a fresh picture of itself,
// the other fetches whatever was captured last.

/** Turn a capture session into MCP content: a short text summary plus one image
 *  block per window, so the images land in the conversation directly. */
function sessionContent(session, note) {
  const shots = readShots(dataDir, session);
  if (shots.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            session.error ??
            "The capture produced no readable images (they may have been pruned since).",
        },
      ],
      isError: true,
    };
  }
  const summary = shots
    .map((s) => `${s.window}${s.width ? ` (${s.width}×${s.height})` : ""}`)
    .join(", ");
  return {
    content: [
      {
        type: "text",
        text: `${note} ${shots.length} window${shots.length === 1 ? "" : "s"}: ${summary}. Captured ${new Date(session.at).toLocaleString()}.`,
      },
      ...shots.map((s) => ({ type: "image", data: s.base64, mimeType: "image/png" })),
    ],
  };
}

server.registerTool(
  "capture_app",
  {
    title: "Screenshot the running app",
    description:
      "Ask the running Good Looks! app to screenshot every one of its open windows right now, " +
      "and return the images. Requires the app to be running with 'Debug screenshots' enabled " +
      "in Settings. Use this to SEE the app's own UI — not the pages under test, which are in " +
      "the Visual tab's run artifacts.",
    inputSchema: {},
  },
  async () => {
    const result = await requestCapture(dataDir);
    if (!result.ok) {
      return { content: [{ type: "text", text: result.reason }], isError: true };
    }
    return sessionContent(result.session, "Captured");
  },
);

server.registerTool(
  "get_screenshot",
  {
    title: "Get the latest app screenshot",
    description:
      "Return the most recent debug screenshot of the app, including ones taken with the in-app " +
      "keyboard shortcut. Use this when the app isn't listening for capture requests, or after " +
      "asking someone to press the shortcut. Pass `index` to reach older captures (0 = newest).",
    inputSchema: {
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Which capture to return, newest first. Defaults to 0."),
    },
  },
  async ({ index = 0 }) => {
    const sessions = listSessions(dataDir);
    if (sessions.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No debug screenshots have been taken. Press the capture shortcut in the app " +
              "(Settings shows the combination), or use capture_app if the app is listening.",
          },
        ],
        isError: true,
      };
    }
    const session = sessions[Math.min(index, sessions.length - 1)];
    const age = Math.round((Date.now() - session.at) / 1000);
    // Say how old it is. A stale screenshot presented as current is how someone
    // ends up debugging a UI state that stopped existing ten minutes ago.
    const note = age < 90 ? "Captured just now —" : `Captured ${Math.round(age / 60)} minutes ago —`;
    return sessionContent(session, note);
  },
);

await server.connect(new StdioServerTransport());
