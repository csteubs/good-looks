// HTTP basic auth, both halves, against a REAL 401 wall.
//
// The feature's whole claim is "the trainer and the run get past the wall
// identically", and each half only exists in its real environment:
//
//   • The RUN half is `test.use({ httpCredentials })` in generated source,
//     honoured only by the Playwright test runner — a manually-built page
//     ignores it — so the proof hands the REAL generated spec to the REAL CLI
//     (the runtime-boot pattern: temp dir, real config, node_modules symlink)
//     with the password in `GLAZE_SECRET_<name>`, exactly as `variableEnv`
//     delivers it.
//   • The TRAINER half is a webContents `login` handler in the Electron main
//     process, reachable only through a live recording session.
//
// Both run against the same wall: a server that 401s until it sees the one
// Authorization header the credentials produce. The negative cases matter as
// much — without the env var the run must FAIL (empty password), and without
// `basicAuth` on the record the trainer must be stopped by the wall, or the
// positive cases prove nothing.
//
// VERIFIED TO FAIL: removing the generator's `test.use` emission fails "a run
// answers the wall"; removing the `wc.on("login")` handler fails "the trainer
// answers the wall".

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { expect, test, type AppFixtures } from "./fixtures.js";
import { generateSpec } from "../main/services/script-generator.js";
import {
  PLAYWRIGHT_CONFIG_FILE,
  playwrightConfigSource,
} from "../shared/playwright-config-source.mjs";
import type { Step, TestVariable } from "../main/recorder/types.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "node_modules", ".bin", "playwright");

const USER = "admin";
const PASSWORD = "s3cret-wall";

async function startWall(): Promise<{
  url: string;
  authed: () => number;
  denied: () => number;
  close: () => Promise<void>;
}> {
  let authed = 0;
  let denied = 0;
  const expected = "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64");
  const server = http.createServer((req, res) => {
    if (req.headers.authorization === expected) {
      authed++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>secret</title><h1>Secret area</h1>");
      return;
    }
    denied++;
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="wall"',
      "content-type": "text/html; charset=utf-8",
    });
    res.end("<!doctype html><title>denied</title><h1>Denied</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    authed: () => authed,
    denied: () => denied,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ── The run half: the real generated spec through the real CLI ─────────────

function wallSpec(url: string): string {
  const steps: Step[] = [
    { id: "g", timestamp: 0, type: "goto", url },
    {
      id: "a",
      timestamp: 0,
      type: "assert",
      assert: "text",
      locator: { k: "role", role: "heading" },
      text: "Secret area",
    } as Step,
  ];
  const variables: TestVariable[] = [{ name: "wallPw", kind: "secret" }];
  return generateSpec({
    name: "behind the wall",
    url,
    steps,
    variables,
    basicAuth: { username: USER, passwordVar: "wallPw" },
  });
}

// Async spawn, NEVER spawnSync: the wall server lives in THIS process, and a
// synchronous child would block the event loop — the inner chromium then
// cannot connect at all and every request times out with the server having
// seen nothing. Found the hard way; step-progress.spec.ts spawns async for
// the same reason.
function runCli(dir: string, env: Record<string, string>): Promise<{ status: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, ["test", "wall.spec.ts"], {
      cwd: dir,
      env: {
        ...process.env,
        ...env,
        PW_OUTPUT_DIR: path.join(dir, "test-results"),
        FORCE_COLOR: "0",
      },
      timeout: 90_000,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    child.on("close", (code) => resolve({ status: code ?? 1, out }));
  });
}

test("a run answers the wall with the secret's credentials", async () => {
  const wall = await startWall();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-basic-auth-"));
  try {
    fs.writeFileSync(path.join(dir, PLAYWRIGHT_CONFIG_FILE), playwrightConfigSource);
    fs.writeFileSync(path.join(dir, "wall.spec.ts"), wallSpec(wall.url));
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));

    const pass = await runCli(dir, { GLAZE_SECRET_wallPw: PASSWORD });
    expect(pass.status, `CLI output:\n${pass.out.slice(-1500)}`).toBe(0);
    expect(wall.authed(), "the server really saw the credentials").toBeGreaterThan(0);

    // The negative half: no env var → empty password → the wall holds and the
    // run FAILS. Without this, a wall that silently stopped checking would
    // leave the positive case proving nothing.
    const fail = await runCli(dir, {});
    expect(fail.status, "an empty password must not pass the wall").not.toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await wall.close();
  }
});

// ── The trainer half: a live session answers the same wall ─────────────────

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

function invoke<T>(window: AppFixtures["window"], channel: string, params?: unknown): Promise<T> {
  return window.evaluate(
    async (args) =>
      (window as unknown as { glazeAPI: Invoke }).glazeAPI.glaze.ipc.invoke(
        args.channel,
        args.params,
      ) as Promise<T>,
    { channel, params },
  ) as Promise<T>;
}

function trainingPage(app: AppFixtures["app"]) {
  return app.windows().find((p) => p.url().startsWith("http://127.0.0.1"));
}

async function waitForPageReady(window: AppFixtures["window"]): Promise<void> {
  await expect
    .poll(
      async () => (await invoke<{ pageReady: boolean }>(window, "recorder:getState")).pageReady,
      { timeout: 20_000 },
    )
    .toBe(true);
}

async function stopRecording(window: AppFixtures["window"]): Promise<void> {
  await invoke(window, "recorder:stop");
  await expect
    .poll(
      async () => (await invoke<{ recording: boolean }>(window, "recorder:getState")).recording,
      { timeout: 20_000 },
    )
    .toBe(false);
}

test("the trainer answers the wall — and is honestly stopped by it without credentials", async ({
  app,
  window,
}) => {
  const wall = await startWall();
  try {
    // ── Control: no basicAuth on the record → the wall stops the trainer ──
    // Electron's default with no answered `login` event is to cancel the
    // authentication, so the 401 body is what loads. This is the "recording a
    // walled site is impossible today" state the feature exists to fix.
    await invoke(window, "recorder:start", { url: wall.url, name: "walled site" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");
    await expect(browser.locator("h1")).toHaveText("Denied");
    const testId = (await invoke<{ testId: string }>(window, "recorder:getState")).testId;
    await stopRecording(window);

    // ── Arm the record: a secret variable, its value, and basicAuth ──
    await invoke(window, "tests:setVariables", {
      id: testId,
      variables: [{ name: "wallPw", kind: "secret" }],
    });
    await invoke(window, "tests:setSecret", { id: testId, name: "wallPw", value: PASSWORD });
    await invoke(window, "tests:setBasicAuth", {
      id: testId,
      basicAuth: { username: USER, passwordVar: "wallPw" },
    });

    // ── The same wall, answered ──
    await invoke(window, "recorder:start", { url: wall.url, name: "walled site", testId });
    await waitForPageReady(window);
    const authed = trainingPage(app)!;
    await authed.waitForLoadState("domcontentloaded");
    await expect(authed.locator("h1")).toHaveText("Secret area");
    expect(wall.authed(), "the server saw the trainer's credentials").toBeGreaterThan(0);
    await stopRecording(window);
  } finally {
    await stopRecording(window).catch(() => {});
    await wall.close();
  }
});
