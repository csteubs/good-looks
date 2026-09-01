// THE AUTHORITY on what "Continue on Failure" MEANS at run time: a wrapped
// step's failure is swallowed and the test proceeds — proven by the real CLI
// running a real generated spec against a page missing the wrapped step's
// target, because only real Playwright can answer whether the emitted
// try/catch is ever reached.
//
// It was not. The emitted config sets no actionTimeout, so an action's
// effective patience is UNLIMITED: a click on an element that is not there
// never threw — it retried until the TEST timeout killed the whole run, an
// abort no catch can swallow (the test is already marked failed), with the
// report pinning "Test timeout exceeded" ON the continue-on-failure step.
// Every step after it never ran, the run failed, and the flag read as simply
// ignored. Reported from the field on 2026-09-01 with the arithmetic intact:
// goto 14s + click 7.6s + 7.7s into the wrapped step ≈ the 30s test budget.
//
// The fix is the generator's timeout bracket: `page.setDefaultTimeout(10000)`
// before the wrapper, restore to 0 (the config's own posture) after it — the
// wrapped step's failure THROWS while the test still has budget, and the
// catch finally does its job. The emission shape is pinned in
// script-generator.test.ts; the parser's consume-without-counting rule in
// spec-parser-positions.test.ts. What only THIS file can pin is the runtime
// behavior of the emitted source — CLAUDE.md's "anything that ships as source
// we do not execute has the same blind spot", the check:runtime-boot lesson.
//
// Deliberately not an Electron test, like retry-evidence and step-progress:
// the subject is what real Playwright does with the emitted spec, not a
// window.
//
// VERIFIED TO FAIL: drop the setDefaultTimeout bracket from the generator's
// wrapper arm and the first test dies at the test timeout again; the second
// test is the premise stated out loud — the SAME failure unwrapped still
// fails the run, so a regression here cannot hide behind a passing suite.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { generateSpecDetailed } from "../main/services/script-generator.js";
import {
  playwrightConfigSource,
  PLAYWRIGHT_CONFIG_FILE,
} from "../shared/playwright-config-source.mjs";
import type { Step } from "../main/recorder/types.js";

const PAGE = `<!doctype html>
<html><head><title>CoF | Acme</title></head>
<body>
  <button id="after" onclick="document.title='after-clicked'">After</button>
</body></html>`;

let server: http.Server;
let base: string;
let dir: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-continue-on-failure-"));
  fs.writeFileSync(path.join(dir, PLAYWRIGHT_CONFIG_FILE), playwrightConfigSource);
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(dir, "node_modules"));
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The failing shape from the report: a click whose target does not exist,
 *  followed by steps that prove whether the run continued. */
function stepsFor(wrapped: boolean): Step[] {
  return [
    { id: "s0", type: "goto", url: base },
    {
      id: "s1",
      type: "click",
      locator: { k: "role", role: "button", name: "Stay on Ritual.com" },
      ...(wrapped ? { continueOnFailure: true } : {}),
    },
    { id: "s2", type: "click", locator: { k: "css", v: "#after" } },
    { id: "s3", type: "assert", assert: "title", value: "after-clicked" },
  ] as Step[];
}

async function run(name: string, wrapped: boolean): Promise<{ exitCode: number; out: string }> {
  const { source } = generateSpecDetailed({ name, url: base, steps: stepsFor(wrapped) }, {});
  const specPath = path.join(dir, `${name}.spec.ts`);
  fs.writeFileSync(specPath, source);
  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "@playwright", "test", "cli.js"),
      "test",
      specPath,
      "--config",
      path.join(dir, PLAYWRIGHT_CONFIG_FILE),
      "--reporter=line",
      "--workers=1",
      // Wide enough for the wrapped step's 10s bound plus the rest of the
      // spec, and narrow enough that the negative control does not dawdle.
      "--timeout=20000",
      "--browser=chromium",
    ],
    { cwd: dir, env: { ...process.env, PW_OUTPUT_DIR: path.join(dir, `${name}-out`), FORCE_COLOR: "0" } },
  );
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  const exitCode = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
  return { exitCode, out };
}

test("a continue-on-failure step that cannot run is skipped past, and the run PASSES", async () => {
  const res = await run("wrapped", true);
  // The whole contract in one exit code: the wrapped click threw inside its
  // 10s bound, the catch swallowed it, the #after click ran against the same
  // page, and the title assertion proved the run reached the end.
  expect(res.out).not.toContain("Test timeout");
  expect(res.exitCode, res.out).toBe(0);
});

test("the SAME failure unwrapped still fails the run — the flag, not the failure, is what changed", async () => {
  const res = await run("unwrapped", false);
  expect(res.exitCode).not.toBe(0);
  // And it fails the way the field report described: the unbounded action
  // eats the test budget, so the abort is the test timeout, not the click's
  // own. This is the premise the bracket exists against — if Playwright ever
  // bounds actions by default, this line is the notice.
  expect(res.out).toContain("Test timeout");
});
