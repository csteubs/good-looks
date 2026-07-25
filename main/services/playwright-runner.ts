// Runs generated Playwright specs locally using the bundled @playwright/test.
// Browsers are installed on first run into a writable userData folder. Output is
// streamed to the app's main window; each run is tracked by a runId.

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { app, logger } from "@glaze/core/backend";

import { sendToMain } from "./app-window.js";
import { getScriptsDir, testStore } from "./test-store.js";
import type { TestSpeed } from "../recorder/types.js";

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
  sendToMain("runner:output", { runId, stream, chunk });
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

    child.stdout?.on("data", (d: Buffer) => emitOutput(runId, "stdout", d.toString()));
    child.stderr?.on("data", (d: Buffer) => emitOutput(runId, "stderr", d.toString()));
    child.on("error", (err) => {
      emitOutput(runId, "system", "\nFailed to start Playwright: " + String(err) + "\n");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

export const playwrightRunner = {
  isBrowserInstalled(): boolean {
    return isChromiumInstalled();
  },

  /** Start a run. Returns immediately; progress streams over runner:* events. */
  start(params: { testId: string; headed: boolean }): { runId: string } {
    const runId = params.testId;
    if (runs.has(runId)) {
      return { runId };
    }

    const rec = testStore.get(params.testId);
    if (!rec) {
      throw new Error("Test not found: " + params.testId);
    }

    void (async () => {
      let exitCode = -1;
      try {
        const { cliPath, nodeModules } = resolvePlaywright();
        const scriptsDir = getScriptsDir();
        ensureModuleResolution(scriptsDir, nodeModules);
        const configPath = ensureConfig(scriptsDir);
        const env = baseEnv(nodeModules);

        if (!isChromiumInstalled()) {
          emitOutput(runId, "system", "Installing the test browser (first run only)…\n");
          await runCli(runId, ["install", "chromium"], cliPath, scriptsDir, env);
        }

        const slowMo = SLOW_MO_MS[rec.speed ?? "fast"];
        emitOutput(runId, "system", "Running " + path.basename(rec.scriptPath) + "…\n");
        const args = [
          "test",
          rec.scriptPath,
          "--config",
          configPath,
          "--reporter=line",
          "--workers=1",
        ];
        if (params.headed) args.push("--headed");
        exitCode = await runCli(runId, args, cliPath, scriptsDir, {
          ...env,
          PW_SLOWMO_MS: String(slowMo),
        });
      } catch (err) {
        emitOutput(runId, "system", "\nError: " + String(err) + "\n");
      } finally {
        runs.delete(runId);
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
