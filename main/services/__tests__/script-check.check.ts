// Does the pre-save script check get the right answer from the REAL Playwright
// CLI?
//
//   npm run check:script-check
//
// `tests:checkScript` hands a draft of a spec to `playwright test --list` and
// reads back a reporter's file. Everything about that exchange — the reporter
// source string, the file filter, the env, what a Babel SyntaxError looks like,
// whether a module-scope throw is reported, whether a draft's own stdout
// output corrupts the report — is decided by the CLI, not by this repo, and a
// unit test with a fake process can only restate what this file assumes. So
// this one runs the real thing, the way `check:runtime-boot` does: a temp
// directory with the real config source, the real emitted runtime, the real
// reporter, and the CLI from node_modules. No browser is launched.
//
// Each row is a draft the editor could be handed, and the verdict the editor
// must show for it — in particular the LINE, which is the whole point of
// checking before saving rather than finding out on the next run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LIST_REPORTER_FILE,
  listReporterSource,
  runListCheck,
  type ScriptCheckResult,
} from "../script-check.js";
import { GLAZE_RUNTIME_FILE, glazeRuntimeSource } from "../glaze-runtime-source.js";
import {
  PLAYWRIGHT_CONFIG_FILE,
  playwrightConfigSource,
} from "../../../shared/playwright-config-source.mjs";

// Bundled by esbuild into node_modules/.cache, so `import.meta.url` is not the
// source file's location. `npm run` sets cwd to the package root.
const REPO = process.cwd();
const NODE_MODULES = path.join(REPO, "node_modules");
const CLI = path.join(NODE_MODULES, "@playwright", "test", "cli.js");

let failures = 0;
function assert(ok: boolean, label: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

if (!fs.existsSync(CLI)) {
  console.error(`FAIL no Playwright CLI at ${CLI} — run npm install --include=dev`);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-script-check-"));
fs.symlinkSync(NODE_MODULES, path.join(dir, "node_modules"), "dir");
fs.writeFileSync(path.join(dir, PLAYWRIGHT_CONFIG_FILE), playwrightConfigSource);
fs.writeFileSync(path.join(dir, GLAZE_RUNTIME_FILE), glazeRuntimeSource);
fs.writeFileSync(path.join(dir, LIST_REPORTER_FILE), listReporterSource);
// A sibling module an imported spec might import.
fs.writeFileSync(path.join(dir, "helpers.mjs"), "export const helper = () => 1;\n");

const SPEC = path.join(dir, "t-one.spec.ts");

function check(source: string): Promise<ScriptCheckResult> {
  return runListCheck({
    specPath: SPEC,
    source,
    cliPath: CLI,
    configPath: path.join(dir, PLAYWRIGHT_CONFIG_FILE),
    reporterPath: path.join(dir, LIST_REPORTER_FILE),
    cwd: dir,
    env: { ...process.env, NODE_PATH: NODE_MODULES },
    execPath: process.execPath,
  });
}

const HEAD = 'import { test, expect } from "@playwright/test";\n';

interface Row {
  label: string;
  source: string;
  expect: (r: ScriptCheckResult) => void;
}

const ROWS: Row[] = [
  {
    label: "a loadable spec passes and reports its test with its line",
    source: HEAD + 'test("ok", async ({ page }) => {\n  await page.goto("https://example.com");\n});\n',
    expect: (r) => {
      assert(r.ok, "  ok");
      assert(r.errors.length === 0, "  no errors");
      assert(
        r.tests.length === 1 && r.tests[0].title === "ok" && r.tests[0].line === 2,
        `  collected [ok @ line 2] (got ${JSON.stringify(r.tests)})`,
      );
      assert(r.durationMs < 15_000, `  under 15s (${r.durationMs}ms)`);
    },
  },
  {
    label: "a missing bracket is reported on its line and column, naming the real spec",
    source:
      HEAD +
      'test("broken", async ({ page }) => {\n' +
      '  await page.goto("https://example.com";\n' +
      "  await expect(page).toHaveTitle(/Example/);\n" +
      "});\n",
    expect: (r) => {
      assert(!r.ok, "  not ok");
      assert(r.errors.length === 1, `  exactly one error (got ${r.errors.length})`);
      const e = r.errors[0];
      assert(e?.line === 3 && e?.column === 39, `  at 3:39 (got ${e?.line}:${e?.column})`);
      assert(/^SyntaxError: Unexpected token/.test(e?.message ?? ""), `  headline: ${e?.message}`);
      assert(!/draft-/.test(JSON.stringify(r)), "  the draft's name appears nowhere");
      assert(!JSON.stringify(r).includes(dir), "  the temp path appears nowhere");
      assert(typeof e?.snippet === "string" && e.snippet.includes("> 3 |"), "  carries the code frame");
    },
  },
  {
    label: "a duplicate test title is reported on the second declaration",
    source: HEAD + 'test("a", async () => {});\ntest("a", async () => {});\n',
    expect: (r) => {
      assert(!r.ok, "  not ok");
      assert(r.errors[0]?.line === 3, `  at line 3 (got ${r.errors[0]?.line})`);
      assert(/duplicate test title/.test(r.errors[0]?.message ?? ""), `  names it: ${r.errors[0]?.message}`);
    },
  },
  {
    label: "an import that does not resolve fails, on the import's line",
    source: HEAD + 'import { nope } from "./missing.mjs";\ntest("x", async () => { nope(); });\n',
    expect: (r) => {
      assert(!r.ok, "  not ok");
      assert(/^Error: Cannot find module '\.\/missing\.mjs'$/.test(r.errors[0]?.message ?? ""), `  one-line headline naming the module: ${r.errors[0]?.message}`);
      assert(r.errors[0]?.line === 2, `  at line 2, the import (got ${r.errors[0]?.line})`);
    },
  },
  {
    label: "the emitted runtime and a sibling module both resolve from the draft's directory",
    source:
      HEAD +
      `import { glazeScrollTo } from "./${GLAZE_RUNTIME_FILE}";\n` +
      'import { helper } from "./helpers.mjs";\n' +
      'test("rt", async ({ page }) => {\n  helper();\n  await glazeScrollTo(page, 0, 10);\n});\n',
    expect: (r) => {
      assert(r.ok, `  ok (${r.errors.map((e) => e.message).join(" | ")})`);
    },
  },
  {
    label: "a file with no test() is a failure, said plainly",
    source: HEAD + "export const x = 1;\n",
    expect: (r) => {
      assert(!r.ok, "  not ok");
      assert(/defines no tests/.test(r.errors[0]?.message ?? ""), `  message: ${r.errors[0]?.message}`);
    },
  },
  {
    label: "a throw at module scope is reported with what was thrown",
    source: HEAD + 'throw new Error("TOP-LEVEL-THROW");\ntest("never", async () => {});\n',
    expect: (r) => {
      assert(!r.ok, "  not ok");
      assert(/TOP-LEVEL-THROW/.test(r.errors[0]?.message ?? ""), `  message: ${r.errors[0]?.message}`);
    },
  },
  {
    label: "a draft that prints JSON-looking noise at module scope still reports cleanly",
    // `--reporter=json` shares stdout with the spec's own console output, which
    // is why the report travels through a file. This row is what would break
    // if it ever went back to stdout.
    source: HEAD + 'console.log("{ \\"errors\\": [] } not json");\ntest("noisy", async () => {});\n',
    expect: (r) => {
      assert(r.ok, `  ok (${r.errors.map((e) => e.message).join(" | ")})`);
      assert(r.tests[0]?.title === "noisy", "  collected the test");
    },
  },
  {
    label: "a type error is NOT caught — Playwright strips types, it does not check them",
    // Stated as a row so the limitation is pinned rather than assumed. If this
    // ever starts failing the check has grown a type pass, and the editor's
    // wording ("loads") needs revisiting.
    source: HEAD + 'test("typed", async () => {\n  const n: number = "not a number";\n  void n;\n});\n',
    expect: (r) => {
      assert(r.ok, "  ok — types are not this check's job");
    },
  },
];

(async () => {
  try {
    for (const row of ROWS) {
      console.log(row.label);
      const result = await check(row.source);
      row.expect(result);
    }
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".draft-"));
    assert(leftovers.length === 0, `no draft left behind (${leftovers.join(", ") || "none"})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\ncheck:script-check passed");
})();
