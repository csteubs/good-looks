// Does `glaze-runtime.mjs` actually LOAD under the real Playwright CLI?
//
//   npm run check:runtime-boot
//
// ── The check that would have caught a dead runtime ────────────────────────
//
// The spec runtime is emitted next to every generated spec, and a spec imports
// it only when a step needs a helper — so a click/fill/assert test never touches
// it. On 2026-08-21 the module failed to load at all: `glazeA11yGate` reached
// for `createRequire(import.meta.url)`, and Playwright 1.53's Babel transform
// converts a `.mjs` containing `import.meta` to CommonJS while Node loads `.mjs`
// as ESM. The emitted `exports` reference then throws at module scope.
//
// The blast radius is the whole file, not the a11y path: EVERY spec importing
// ANY helper — api, dialog, a11y, aiCheck, totp, echo, scroll, capture — died at
// collection with `ReferenceError: exports is not defined in ES module scope`,
// and Playwright reported "No tests found".
//
// Nothing caught it. The unit tests import the emitted module through Node's own
// loader (`import(pathToFileURL(...))`), where `import.meta` is perfectly legal,
// so they were green throughout. `e2e/assert-parity.spec.ts` does the same. And
// `e2e/step-progress.spec.ts` writes the runtime into its scripts dir but its
// generated specs are plain clicks and assertions, so the import is never
// emitted and the file is never loaded.
//
// This is `check:mcp-boot`'s argument applied to the runtime: the only question
// no other check can answer is whether the thing this ships actually boots in
// the environment that loads it. So this one hands the REAL emitted runtime, the
// REAL emitted config and REAL generated specs to the REAL Playwright CLI.
//
// No browser is launched — collection and a fixture-free test are all this
// needs — so it costs about a second and runs anywhere `npm install` ran.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GLAZE_RUNTIME_FILE, glazeRuntimeSource } from "../glaze-runtime-source.js";
import { generateSpec } from "../script-generator.js";
import {
  PLAYWRIGHT_CONFIG_FILE,
  playwrightConfigSource,
} from "../../../shared/playwright-config-source.mjs";
import type { Step, TestVariable } from "../../recorder/types.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(REPO, "node_modules", ".bin", "playwright");

let failures = 0;
function assert(ok: boolean, label: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

/** Every name the emitted runtime exports. Read off the emitted source rather
 *  than listed here, so a helper added tomorrow is covered without anyone
 *  remembering this file — which is the only way a boot check stays honest. */
function runtimeExports(source: string): string[] {
  const names = new Set<string>();
  const re = /^export\s+(?:async\s+)?(?:function|const)\s+(glaze[A-Za-z0-9_]*)/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) names.add(m[1]);
  return [...names].sort();
}

/** The runtime names a generated spec imports, read off the emitted preamble —
 *  the same place `script-generator` derives them from. */
function importedNames(spec: string): string[] {
  const line = spec
    .split("\n")
    .find((l) => l.startsWith("import {") && l.includes(GLAZE_RUNTIME_FILE));
  if (!line) return [];
  return line
    .slice(line.indexOf("{") + 1, line.indexOf("}"))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function run(dir: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(CLI, args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      // Never let a listing or a run scribble into the repo.
      PW_OUTPUT_DIR: path.join(dir, "test-results"),
      // Playwright colourises for a TTY; plain text is what we parse.
      FORCE_COLOR: "0",
    },
  });
  return { status: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// ── The rows: one real generated spec per runtime helper ───────────────────
//
// Each is the step (or variable) that makes the generator emit that import. The
// coverage assertion below fails if a helper has no row, so a new one cannot be
// added without landing here — the missing-import failure this guards against
// is silent everywhere else.
interface Row {
  helper: string;
  steps?: Step[];
  variables?: TestVariable[];
}

const VARS: TestVariable[] = [
  { name: "slug", kind: "plain", value: "cart" },
  { name: "orderId", kind: "plain", value: "A-1" },
  { name: "role", kind: "plain", value: "admin" },
];

const ROWS: Row[] = [
  {
    helper: "glazeCapture",
    steps: [
      { type: "capture", captureVar: "results", captureFrom: "count", locator: { k: "css", v: "li" } },
    ] as Step[],
  },
  { helper: "glazeScrollTo", steps: [{ type: "scroll", scrollX: 0, scrollY: 800 }] as Step[] },
  { helper: "glazeA11yGate", steps: [{ type: "a11y", a11yImpact: "serious" }] as Step[] },
  {
    helper: "glazeGenerate",
    variables: [{ name: "userEmail", kind: "generated", genSpec: "email" }] as TestVariable[],
  },
  { helper: "glazeApiRequest", steps: [{ type: "api", url: "https://x.test/health" }] as Step[] },
  { helper: "glazeTotp", variables: [{ name: "mfa", kind: "secret", totp: true }] as TestVariable[] },
  { helper: "glazeAiCheck", steps: [{ type: "aiCheck", text: "the cart is empty" }] as Step[] },
  {
    helper: "glazeArmDialog",
    steps: [{ type: "dialog", dialogAction: "accept", value: "Jane" }] as Step[],
  },
  { helper: "glazeEcho", steps: [{ type: "echo", text: "hello" }] as Step[] },
  {
    helper: "glazeCompare",
    steps: [
      { type: "if", cond: "variable", captureVar: "role", compareOp: "contains", value: "adm" },
      { type: "endif" },
    ] as Step[],
    variables: VARS,
  },
  {
    helper: "glazeReEscape",
    steps: [{ type: "assert", assert: "url", value: "/${slug}/x" }] as Step[],
    variables: VARS,
  },
  {
    helper: "glazeUrlPathPattern",
    steps: [{ type: "assert", assert: "urlPathIs", value: "/order/${orderId}" }] as Step[],
    variables: VARS,
  },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-runtime-boot-"));
try {
  // The scripts dir as the app writes it: the real runtime, the real config, and
  // a link to this repo's node_modules — the same trick the runner uses, and all
  // Node's resolver needs.
  fs.writeFileSync(path.join(dir, GLAZE_RUNTIME_FILE), glazeRuntimeSource);
  fs.writeFileSync(path.join(dir, PLAYWRIGHT_CONFIG_FILE), playwrightConfigSource);
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));

  const exported = runtimeExports(glazeRuntimeSource);
  assert(exported.length >= 12, `the runtime exports helpers to boot (${exported.length})`);

  // ── 1. Every export is importable AND callable-shaped ────────────────────
  // Run rather than list: a listing proves the module parsed, running it proves
  // the module EXECUTED and every binding arrived. Fixture-free, so no browser.
  const specNames = exported.join(",\n  ");
  fs.writeFileSync(
    path.join(dir, "all-exports.spec.ts"),
    `import { test, expect } from "@playwright/test";\n` +
      `import {\n  ${specNames},\n} from "./${GLAZE_RUNTIME_FILE}";\n\n` +
      `test("every runtime helper loads", async () => {\n` +
      `  for (const [name, fn] of Object.entries({\n  ${specNames},\n  })) {\n` +
      `    expect(typeof fn, name).toBe("function");\n` +
      `  }\n});\n`,
  );

  // ── 2. Real generated specs, one per helper ──────────────────────────────
  const covered = new Set<string>();
  for (const row of ROWS) {
    const spec = generateSpec({
      name: row.helper,
      url: "https://x.test",
      steps: row.steps ?? [],
      variables: row.variables ?? [],
    } as Parameters<typeof generateSpec>[0]);
    const names = importedNames(spec);
    assert(
      names.includes(row.helper),
      `a ${row.helper} spec imports it (got ${names.join(", ") || "no runtime import"})`,
    );
    for (const n of names) covered.add(n);
    fs.writeFileSync(path.join(dir, `${row.helper}.spec.ts`), spec);
  }

  const uncovered = exported.filter((n) => !covered.has(n));
  assert(
    uncovered.length === 0,
    `every exported helper has a row that emits it${uncovered.length ? ` — add one for ${uncovered.join(", ")}` : ""}`,
  );

  // ── 3. The CLI collects every one of them ────────────────────────────────
  // This is the assertion the bug walked through. A module that fails to load
  // takes its importers with it, and Playwright's report for that is the
  // maximally unhelpful "No tests found".
  const expectedTests = ROWS.length + 1;
  const list = run(dir, ["test", "--list"]);
  const total = /Total:\s+(\d+)\s+test/.exec(list.out)?.[1];
  assert(
    !/exports is not defined/.test(list.out),
    "the runtime does not compile to CommonJS — no `exports` at ESM module scope",
  );
  assert(
    list.status === 0,
    `the CLI collects the specs without erroring${list.status === 0 ? "" : ` — said: ${firstError(list.out)}`}`,
  );
  assert(
    total === String(expectedTests),
    `all ${expectedTests} specs importing the runtime are found (got ${total ?? "no total"})`,
  );

  // ── 4. And the module actually executes ──────────────────────────────────
  const ran = run(dir, ["test", "all-exports.spec.ts", "--reporter=line"]);
  assert(
    ran.status === 0 && /1 passed/.test(ran.out),
    `every exported helper imports as a function${ran.status === 0 ? "" : ` — said: ${firstError(ran.out)}`}`,
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The one line worth showing from a CLI failure. A stack out of node_modules
 *  sends the reader to the wrong file; the message names the real problem. */
function firstError(out: string): string {
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /Error|error:/.test(l) && !l.startsWith("at "));
  return line ?? out.split("\n").filter(Boolean).slice(-1)[0] ?? "(no output)";
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll runtime-boot checks passed");
