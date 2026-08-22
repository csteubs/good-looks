// Does a script the user is about to save still LOAD under the real Playwright
// CLI?
//
// The Script tab's Save used to write whatever was in the textarea straight to
// disk. A missing bracket was found on the next run, as "No tests found" in the
// run console, with the editor already closed and nothing pointing at the line.
//
// This asks the one oracle whose answer is not a model of anything: the same
// CLI a run spawns, loading the draft through the same Babel transform, in
// `--list` mode — so the file is parsed, its top-level code runs, its imports
// resolve and its `test()` calls are collected, and no browser is launched.
// About half a second.
//
// What it catches: syntax errors (with line and column), an import that does
// not resolve, a duplicate test title, a file that defines no tests, anything
// thrown at module scope. What it does NOT catch: type errors. Playwright
// strips types rather than checking them, so `const n: number = "x"` loads
// fine here and runs fine later. A type-aware check is the Script IDE's job.
//
// One thing to know about it: `--list` EXECUTES the draft's top-level code. A
// spec is the user's own program and every run executes all of it, so the
// trust level is unchanged — but it means the check is not a passive parse,
// which is why it runs in a child process under the same env as a run and
// never in the main process.
//
// The draft is written NEXT TO the real spec (same directory, so
// `./glaze-runtime.mjs` and an imported test's sibling modules resolve exactly
// as they will at run time) under a name the test store never indexes, and
// removed again whatever happens. The JSON comes back through a file, not
// stdout: the draft's own `console.log` at module scope lands on stdout too,
// and the CLI's `--reporter=json` shares that stream.

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { logger } from "@shell/backend";

import type { TestRecord } from "../recorder/types.js";
import {
  baseEnv,
  ensureConfig,
  ensureModuleResolution,
  ensureRuntime,
  resolvePlaywright,
  writeIfChanged,
} from "./playwright-runner.js";
import { getScriptsDir } from "./test-store.js";

export interface ScriptCheckError {
  /** One line, shown in the editor. The file path is already replaced with the
   *  spec's own name and the Babel snippet stripped. */
  message: string;
  /** 1-based, when the CLI located the error: a parse error, an import that
   *  does not resolve (the import's line), a duplicate title. Absent when it
   *  could not — a throw at module scope reports its message alone. */
  line?: number;
  column?: number;
  /** The CLI's own code frame, when it gave one. */
  snippet?: string;
}

export interface ScriptCheckTest {
  title: string;
  line: number;
}

export interface ScriptCheckResult {
  ok: boolean;
  errors: ScriptCheckError[];
  /** The tests the CLI collected — what a run of this file would execute. */
  tests: ScriptCheckTest[];
  durationMs: number;
}

export const LIST_REPORTER_FILE = "glaze-list-reporter.mjs";

/** A reporter that writes the collection outcome to the file named by
 *  GLAZE_LIST_OUT. `onError` is where a load failure arrives (a SyntaxError
 *  from the transform, a missing module, a duplicate title); `onBegin` sees the
 *  collected tests. Both fire in `--list` mode. */
export const listReporterSource =
  'import fs from "node:fs";\n' +
  "\n" +
  "export default class GlazeListReporter {\n" +
  "  constructor() {\n" +
  "    this.errors = [];\n" +
  "    this.tests = [];\n" +
  "  }\n" +
  "  onBegin(_config, suite) {\n" +
  "    for (const t of suite.allTests()) {\n" +
  "      this.tests.push({ title: t.title, file: t.location.file, line: t.location.line, column: t.location.column });\n" +
  "    }\n" +
  "  }\n" +
  "  onError(error) {\n" +
  "    this.errors.push({ message: error.message, location: error.location, snippet: error.snippet });\n" +
  "  }\n" +
  "  onEnd() {\n" +
  "    const out = process.env.GLAZE_LIST_OUT;\n" +
  "    if (out) fs.writeFileSync(out, JSON.stringify({ errors: this.errors, tests: this.tests }));\n" +
  "  }\n" +
  "  printsToStdio() {\n" +
  "    return false;\n" +
  "  }\n" +
  "}\n";

/** Raw shape the reporter writes. Every field is optional because the file is
 *  produced by a child process and read back — treat it as input. */
interface RawReport {
  errors?: { message?: unknown; location?: { line?: unknown; column?: unknown }; snippet?: unknown }[];
  tests?: { title?: unknown; file?: unknown; line?: unknown; column?: unknown }[];
}

let draftSeq = 0;

/** Where a draft of `specPath` is written for checking: the same directory,
 *  so every relative import resolves as it will at run time, under a name that
 *  still matches Playwright's default `testMatch` (it must, or the CLI finds
 *  nothing) but that no record ever points at. The serial keeps two checks of
 *  one test from sharing a file. */
export function draftPathFor(specPath: string, seq: number = draftSeq++): string {
  const dir = path.dirname(specPath);
  const base = path.basename(specPath).replace(/\.(spec|test)\.[cm]?[jt]sx?$/, "");
  return path.join(dir, `${base}.draft-${process.pid}-${seq}.spec.ts`);
}

const NO_TESTS_RE = /^Error: No tests found\./;

/** Turn the reporter's file into the result the editor shows.
 *
 *  `draftPath` is replaced with `displayName` everywhere it appears, because
 *  the user never chose the draft's name and an error naming
 *  `t-login.draft-4242-3.spec.ts` reads as a different file. Babel's message
 *  carries its own code frame after the first line; that frame is kept in
 *  `snippet` and the message cut to its headline. "No tests found" is the
 *  CLI's way of saying a load error left nothing to collect — when there IS a
 *  load error it is noise and dropped; on its own it is the finding. */
export function parseListReport(
  raw: string,
  draftPath: string,
  displayName: string,
): { errors: ScriptCheckError[]; tests: ScriptCheckTest[] } {
  let report: RawReport;
  try {
    report = JSON.parse(raw) as RawReport;
  } catch {
    return { errors: [{ message: "The check produced no readable report." }], tests: [] };
  }
  // The CLI spells the draft's path three ways — absolute, realpath'd (macOS
  // keeps the temp dir behind a symlink, and `/var/...` becomes
  // `/private/var/...`), and relative to its root dir — so the rename keys on
  // the draft's BASENAME and eats whatever path precedes it.
  const draftName = path.basename(draftPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const draftRe = new RegExp("(?:[^\\s\"'(]*[\\\\/])?" + draftName, "g");
  const rename = (s: string) => s.replace(draftRe, displayName);
  const errors: ScriptCheckError[] = [];
  for (const e of Array.isArray(report.errors) ? report.errors : []) {
    const full = typeof e?.message === "string" ? rename(e.message) : "";
    const headline = full.split("\n")[0]?.trim() || "Playwright could not load this script.";
    const line = asLine(e?.location?.line);
    const column = asLine(e?.location?.column);
    const snippet =
      typeof e?.snippet === "string" && e.snippet.trim()
        ? rename(e.snippet)
        : full.includes("\n")
          ? full.slice(full.indexOf("\n") + 1).replace(/^\n+/, "")
          : undefined;
    errors.push({
      message: NO_TESTS_RE.test(headline)
        ? "This script defines no tests — Playwright found nothing to run."
        : headline.replace(/^SyntaxError: [^:]*: /, "SyntaxError: "),
      ...(line ? { line } : {}),
      ...(line && column ? { column } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  const real = errors.filter((e) => !e.message.startsWith("This script defines no tests"));
  const tests: ScriptCheckTest[] = [];
  for (const t of Array.isArray(report.tests) ? report.tests : []) {
    const line = asLine(t?.line);
    if (typeof t?.title === "string" && line) tests.push({ title: t.title, line });
  }
  return { errors: real.length > 0 ? real : errors, tests };
}

function asLine(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Regex-escape a path for the CLI's file filter, which is a regular
 *  expression matched against the spec path, not a literal. */
export function fileFilterFor(specPath: string): string {
  return specPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How long the child gets. Collection takes about half a second; a spec
 *  whose module scope blocks (an `await` on a server that never answers) is
 *  the case this bounds. */
export const CHECK_TIMEOUT_MS = 20_000;

export interface ListCheckOptions {
  /** The real spec's path. The draft is written beside it. */
  specPath: string;
  source: string;
  cliPath: string;
  configPath: string;
  reporterPath: string;
  /** Working directory for the CLI — the scripts dir, where the config is. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  execPath?: string;
  timeoutMs?: number;
  spawnImpl?: typeof nodeSpawn;
}

/** Write the draft, run `playwright test --list` over it, read the report,
 *  remove the draft. The pure half of the feature: nothing here knows about
 *  the test store or Electron, so `check:script-check` can drive it against
 *  the real CLI with a temp dir. */
export function runListCheck(opts: ListCheckOptions): Promise<ScriptCheckResult> {
  const started = Date.now();
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const draftPath = draftPathFor(opts.specPath);
  const outPath = `${draftPath}.report.json`;
  const displayName = path.basename(opts.specPath);
  const cleanup = () => {
    for (const p of [draftPath, outPath]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  };
  return new Promise<ScriptCheckResult>((resolve) => {
    const finish = (result: Omit<ScriptCheckResult, "durationMs">) => {
      cleanup();
      resolve({ ...result, durationMs: Date.now() - started });
    };
    try {
      fs.writeFileSync(draftPath, opts.source, "utf-8");
    } catch (err) {
      finish({
        ok: false,
        errors: [{ message: "Couldn't write the draft to check it: " + String(err) }],
        tests: [],
      });
      return;
    }
    const args = [
      "test",
      fileFilterFor(draftPath),
      "--list",
      "--config",
      opts.configPath,
      "--reporter",
      opts.reporterPath,
    ];
    const stderr: string[] = [];
    let settled = false;
    const child = spawnImpl(opts.execPath ?? process.execPath, [opts.cliPath, ...args], {
      cwd: opts.cwd,
      env: {
        ...opts.env,
        ELECTRON_RUN_AS_NODE: "1",
        GLAZE_LIST_OUT: outPath,
        // The config reads this for its outputDir. Nothing is written in
        // --list mode, but a draft must never point a real run's directory
        // at itself either.
        PW_OUTPUT_DIR: path.join(opts.cwd, "test-results", "script-check"),
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        errors: [
          {
            message:
              "The check timed out after " +
              Math.round((opts.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000) +
              "s — something at the top of this script never finished.",
          },
        ],
        tests: [],
      });
    }, opts.timeoutMs ?? CHECK_TIMEOUT_MS);
    child.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
    child.stdout?.on("data", () => {
      /* the report comes through the file; the stream is the draft's own output */
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({
        ok: false,
        errors: [{ message: "Couldn't start Playwright to check the script: " + String(err) }],
        tests: [],
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let raw = "";
      try {
        raw = fs.readFileSync(outPath, "utf-8");
      } catch {
        // No report at all: the CLI died before the reporter ran (a broken
        // config, a missing CLI). Whatever it printed is the only evidence.
        const tail = stderr.join("").trim().split("\n").slice(-6).join("\n");
        finish({
          ok: false,
          errors: [
            {
              message:
                "Playwright exited (code " +
                String(code) +
                ") before it could report on the script." +
                (tail ? "\n" + tail : ""),
            },
          ],
          tests: [],
        });
        return;
      }
      const { errors, tests } = parseListReport(raw, draftPath, displayName);
      // A non-zero exit with nothing reported would otherwise read as a pass.
      if (errors.length === 0 && code !== 0) {
        errors.push({
          message: "Playwright exited with code " + String(code) + " while listing the tests.",
        });
      }
      finish({ ok: errors.length === 0, errors, tests });
    });
  });
}

/** The app-facing entry: resolve the CLI, the config and the fixtures the way
 *  a run does, then check `source` as a draft of `rec`'s script. */
export async function checkTestScript(rec: TestRecord, source: string): Promise<ScriptCheckResult> {
  const { cliPath, nodeModules } = resolvePlaywright();
  const scriptsDir = getScriptsDir();
  ensureModuleResolution(scriptsDir, nodeModules);
  const configPath = ensureConfig(scriptsDir);
  // A spec that imports `./glaze-runtime.mjs` on a test that has never been
  // run would otherwise fail the check on a module the first run writes.
  ensureRuntime(scriptsDir);
  const reporterPath = path.join(scriptsDir, LIST_REPORTER_FILE);
  writeIfChanged(reporterPath, listReporterSource);
  const specPath = rec.scriptPath && path.isAbsolute(rec.scriptPath)
    ? rec.scriptPath
    : path.join(scriptsDir, rec.id + ".spec.ts");
  const result = await runListCheck({
    specPath,
    source,
    cliPath,
    configPath,
    reporterPath,
    cwd: scriptsDir,
    env: baseEnv(nodeModules),
  });
  if (!result.ok) {
    logger.info("script-check", "Script failed to load", {
      id: rec.id,
      errors: result.errors.map((e) => e.message),
      ms: result.durationMs,
    });
  }
  return result;
}
