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

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MCP_DIR, "..");
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RUN_RECORDS = 1000;
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

function findPlaywrightCli() {
  const nodeModules = path.join(PROJECT_ROOT, "node_modules");
  const candidates = [
    path.join(nodeModules, "@playwright", "test", "cli.js"),
    path.join(nodeModules, "playwright", "cli.js"),
  ];
  const cliPath = candidates.find((c) => fs.existsSync(c));
  return cliPath ? { cliPath, nodeModules } : null;
}

function isChromiumInstalled() {
  const dir = path.join(dataDir, "recorder", "browsers");
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.startsWith("chromium"));
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
  if (fs.existsSync(configPath)) return;
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
        speed: t.speed ?? "fast",
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
      "Run a recorded test locally with the bundled Playwright and report pass/fail. Requires Chromium to already be installed (open the test once in the app and run it there first if this fails with a missing-browser error). Records the run in the app's run history so it shows up in Stats too.",
    inputSchema: { testId: z.string() },
  },
  async ({ testId }) => {
    const test = listTests().find((t) => t.id === testId);
    if (!test) {
      return { content: [{ type: "text", text: `No test found with id ${testId}` }], isError: true };
    }

    const playwright = findPlaywrightCli();
    if (!playwright) {
      return {
        content: [{ type: "text", text: `Could not find @playwright/test under ${PROJECT_ROOT}/node_modules.` }],
        isError: true,
      };
    }
    if (!isChromiumInstalled()) {
      return {
        content: [
          {
            type: "text",
            text: "Chromium isn't installed yet. Open this test in the app and run it once from the UI (it installs the browser on first run), then retry.",
          },
        ],
        isError: true,
      };
    }

    const scriptsDir = path.dirname(test.scriptPath);
    ensureModuleResolution(scriptsDir, playwright.nodeModules);
    ensurePlaywrightConfig(scriptsDir);

    const browsersPath = path.join(dataDir, "recorder", "browsers");
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath, NODE_PATH: playwright.nodeModules };
    const specFile = path.basename(test.scriptPath);

    const startedAt = Date.now();
    const { exitCode, output } = await new Promise((resolve) => {
      const child = spawn(process.execPath, [playwright.cliPath, "test", specFile], {
        cwd: scriptsDir,
        env,
      });
      let out = "";
      const timer = setTimeout(() => {
        out += "\n[Timed out after 5 minutes — stopping.]\n";
        child.kill("SIGKILL");
      }, RUN_TIMEOUT_MS);
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
    const id = randomUUID();
    const logFile = path.join(dataDir, "recorder", "logs", `${id}.log`);

    saveRunRecord(
      {
        id,
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
        runHeadless: test.runHeadless ?? false,
      },
      output,
    );

    const outputTail = output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { runId: id, status, exitCode, durationMs: finishedAt - startedAt, outputTail },
            null,
            2,
          ),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
