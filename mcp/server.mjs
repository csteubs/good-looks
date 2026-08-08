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
import { listSessions, readShots, requestCapture } from "./debug-shots.mjs";
import {
  datasetRow,
  describeRun,
  runArgs,
  runEnv,
  sanitizeOutput,
  secretVariableNames,
} from "./run-plan.mjs";
import { buildQueue } from "../shared/batch-queue.mjs";
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
  fs.writeFileSync(configPath, playwrightConfigSource, "utf-8");
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
  const runId = randomUUID();
  const logFile = path.join(dataDir, "recorder", "logs", `${runId}.log`);

  // ONE choke point for everything written or returned, mirroring the app's
  // `emitOutput`.
  const safeOutput = sanitizeOutput(output);

  saveRunRecord(
    {
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
      logBytes: Buffer.byteLength(safeOutput, "utf-8"),
      captureArtifacts: false,
      // These runs are always headless — there's no user at a screen watching
      // an MCP-driven run.
      runHeadless: true,
      runBrowser: browser,
      // Recorded so the app's run history can attribute an MCP-driven run to a
      // speed like any other. Without it these runs show a blank speed and
      // read as "recorded before the field existed".
      speed,
      ...(batchId ? { batchId } : {}),
      // Both stored, like the app: the id joins back to the row, and the name
      // survives the row being renamed or deleted. A sweep whose history can't
      // say WHICH row failed is a sweep that answered nothing.
      ...(datasetId ? { datasetId } : {}),
      ...(datasetName ? { datasetName } : {}),
    },
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
      `Run several recorded tests back to back and report an aggregate pass/fail summary. Select them by explicit testIds, by tag (see list_tests; pass "${UNTAGGED}" for tests with no tags), or omit both to run every visible test. Pass allDatasets (or datasetIds) to sweep each selected test once per dataset row instead of once. Tests run one at a time, headless. A failing test does not stop the batch, and a test declaring secret variables is skipped with a note rather than failing the suite. Each test is recorded in the app's run history, and the batch itself appears in the app's Batch view.`,
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
    },
  },
  async ({ testIds, tag, browser, datasetIds, allDatasets }) => {
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
    const persist = (running, index) => {
      saveBatchRecord({
        batchId,
        running,
        startedAt,
        ...(running ? {} : { finishedAt: Date.now() }),
        currentIndex: index,
        results,
        stopped: false,
        summary: summarizeResults(results, Date.now() - startedAt),
      });
    };
    persist(true, -1);

    for (let i = 0; i < queue.length; i++) {
      const test = byId.get(queue[i].testId);
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
        persist(true, i);
        continue;
      }

      results[i].status = "running";
      results[i].startedAt = Date.now();
      persist(true, i);

      // One test failing must not abort the batch — that's the whole point of
      // running a suite.
      try {
        const r = await executeTest(test, {
          playwright,
          browser: engine,
          batchId,
          // Read from the QUEUE, not from `results`: the values belong in the
          // child process's env and nowhere near the persisted batch record.
          vars: queue[i].vars,
          datasetId: queue[i].datasetId,
          datasetName: queue[i].datasetName,
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
      persist(true, i);
    }

    const finishedAt = Date.now();
    const summary = summarizeResults(results, finishedAt - startedAt);
    persist(false, -1);

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
