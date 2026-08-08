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
import { PLAYWRIGHT_CONFIG_SOURCE } from "./playwright-config.mjs";
import { listSessions, readShots, requestCapture } from "./debug-shots.mjs";

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MCP_DIR, "..");
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RUN_RECORDS = 1000;
const MAX_BATCH_RECORDS = 50; // mirrors main/services/batch-history-store.ts
const RUN_BROWSERS = ["chromium", "firefox", "webkit"];
/**
 * Mirrors SLOW_MO_MS in main/services/run-pacing.ts. Pinned against it by
 * `npm run check:crawl-speed` — a speed missing here reads as `undefined`, and
 * the `?? 0` below turns that into a FULL-SPEED run of a test the user
 * deliberately slowed down, with nothing in the output to say so.
 *
 * The step delay is all this server applies. "crawl" also waits for each page
 * to settle, and that lives in a Playwright fixture the app injects by
 * redirecting the spec's import — the same mechanism screenshot capture,
 * accessibility checks and Auto-Heal use, none of which this server does
 * either. An MCP-driven crawl run is therefore paced like a crawl run but does
 * not settle; see `run_test`'s response note.
 */
const SLOW_MO_MS = { fast: 0, medium: 400, slow: 1200, crawl: 2500 };
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

function ensurePlaywrightConfig(scriptsDir) {
  const configPath = path.join(scriptsDir, "playwright.config.ts");
  // Write-if-different rather than write-if-absent: this file gained fields
  // over time, and skipping on existence left an older config in place forever.
  // Comparing also means concurrent runs don't rewrite a file each other's
  // Playwright process is reading.
  try {
    if (fs.readFileSync(configPath, "utf-8") === PLAYWRIGHT_CONFIG_SOURCE) return;
  } catch {
    // Missing or unreadable — fall through and write it.
  }
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, PLAYWRIGHT_CONFIG_SOURCE, "utf-8");
  fs.renameSync(tmp, configPath);
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
 * @returns {{ runId, status, exitCode, startedAt, finishedAt, durationMs, output }}
 */
async function executeTest(test, { playwright, browser, batchId, timeoutMs }) {
  // The scripts ROOT, not the spec's own directory. An imported test's spec
  // lives in a sandbox subdirectory beside the sibling modules it imports, so
  // deriving the root from the spec would drop a config and a node_modules
  // link into that sandbox — and resolve the spec against the wrong base.
  const scriptsDir = path.join(dataDir, "recorder", "scripts");
  ensureModuleResolution(scriptsDir, playwright.nodeModules);
  ensurePlaywrightConfig(scriptsDir);

  // Minted before the spawn, not after, because it names this run's Playwright
  // output directory. Playwright derives that directory from the SPEC's path by
  // default, so with run_batch running several tests at once, two runs of one
  // spec would write to — and clean — the same folder mid-flight.
  const runId = randomUUID();
  const outputDir = path.join(scriptsDir, "test-results", runId);

  const browsersPath = path.join(dataDir, "recorder", "browsers");
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath,
    NODE_PATH: playwright.nodeModules,
    PW_SLOWMO_MS: String(SLOW_MO_MS[test.speed ?? "fast"] ?? 0),
    PW_OUTPUT_DIR: outputDir,
  };
  // Relative to the scripts root, so a sandboxed spec resolves as
  // `imported/<id>/tests/foo.spec.ts` rather than a bare basename that only
  // matches when the spec sits flat.
  const specFile = path.relative(scriptsDir, test.scriptPath);

  const startedAt = Date.now();
  const { exitCode, output } = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [playwright.cliPath, "test", specFile, `--browser=${browser}`],
      { cwd: scriptsDir, env },
    );
    let out = "";
    const timer = setTimeout(() => {
      out += `\n[Timed out after ${Math.round(timeoutMs / 60000)} minutes — stopping.]\n`;
      child.kill("SIGKILL");
    }, timeoutMs);
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
      logBytes: Buffer.byteLength(output, "utf-8"),
      captureArtifacts: false,
      // These runs are always headless — there's no user at a screen watching
      // an MCP-driven run.
      runHeadless: true,
      runBrowser: browser,
      // Recorded so the app's run history can attribute an MCP-driven run to a
      // speed like any other. Without it these runs show a blank speed and
      // read as "recorded before the field existed".
      speed: test.speed ?? "fast",
      ...(batchId ? { batchId } : {}),
    },
    output,
  );

  return {
    runId,
    status,
    exitCode,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    output,
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
      "Return one recorded test's full step list and its generated Playwright spec source, by test id (see list_tests).",
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
      log = fs.readFileSync(run.logFile, "utf-8");
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
      "Run one recorded test locally with the bundled Playwright and report pass/fail. Runs headless. The chosen browser must already be installed (run the test once from the app, which installs it on first use). Records the run in the app's run history so it shows up in Stats too.",
    inputSchema: {
      testId: z.string(),
      browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
    },
  },
  async ({ testId, browser }) => {
    const test = listTests().find((t) => t.id === testId);
    if (!test) {
      return { content: [{ type: "text", text: `No test found with id ${testId}` }], isError: true };
    }
    const engine = browser ?? test.runBrowser ?? "chromium";

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
      timeoutMs: RUN_TIMEOUT_MS,
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
      `Run several recorded tests and report an aggregate pass/fail summary. Select them by explicit testIds, by tag (see list_tests; pass "${UNTAGGED}" for tests with no tags), or omit both to run every visible test. Tests run headless, one at a time by default — set "parallel" to run that many at once (1-${MAX_PARALLEL}), which is much faster for a large suite at the cost of CPU. A failing test does not stop the batch. Each test is recorded in the app's run history, and the batch itself appears in the app's Batch view.`,
    inputSchema: {
      testIds: z.array(z.string()).optional(),
      tag: z.string().optional(),
      browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
      parallel: z.number().int().min(1).max(MAX_PARALLEL).optional(),
    },
  },
  async ({ testIds, tag, browser, parallel }) => {
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

    const batchId = randomUUID();
    const startedAt = Date.now();
    const results = selected.map((t) => ({
      testId: t.id,
      testName: t.name,
      status: "pending",
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

    const limit = clampParallel(parallel, selected.length);
    await runPool(selected, limit, async (test, i) => {
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
          timeoutMs: RUN_TIMEOUT_MS,
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
              results: results.map((r) => ({
                testId: r.testId,
                testName: r.testName,
                status: r.status,
                durationMs: r.durationMs,
                runId: r.runRecordId,
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
