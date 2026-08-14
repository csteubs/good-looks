// THE PRODUCT'S OWN CLAIM, TESTED: record a session, run what it generated,
// and the run passes.
//
// Nothing checked this. The suite covered capture (does a click become a step),
// generation (does a step become a line) and the runner (does a spec execute) —
// each in isolation, each green — while the thing the product actually promises,
// that a recording becomes a test which PASSES, went unasserted from end to end.
// That is how "assert URL contains" shipped an assertion that could not pass on
// any page: every stage did its job, and the composition was never run.
//
// Zero heals is part of the assertion, not a bonus. A run that only goes green
// because Auto-Heal rewrote a locator is a run whose recording was wrong, and
// counting it as a pass is what lets the recorder's output rot while the
// dashboard stays green — the exact complaint this work started from.
//
// The second test is the control. A harness that cannot fail is not evidence, so
// a deliberately false assertion must produce a RED run, for the stated reason.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { test, expect, type AppFixtures } from "./fixtures.js";

interface Invoke {
  glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } };
}

interface Step {
  id: string;
  type: string;
  assert?: string;
  value?: string;
  locator?: { k?: string; v?: string; name?: string };
}

interface TestRecord {
  id: string;
  name: string;
  scriptPath: string;
}

interface RunResult {
  runId?: string;
  ok?: boolean;
}

const PAGE = `<!doctype html>
<html><head><title>Shop | Acme</title></head>
<body>
  <h1 data-testid="heading">Products</h1>
  <label for="q">Search products</label>
  <input id="q" data-testid="q" />
  <button id="go" data-testid="go">Search</button>
  <p data-testid="result" hidden>Found 3 items</p>
  <script>
    document.getElementById("go").addEventListener("click", function () {
      document.querySelector('[data-testid="result"]').hidden = false;
    });
  </script>
</body></html>`;

async function serveSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

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

/** The training browser's own page — a WebContentsView target, found by URL. */
function trainingPage(app: AppFixtures["app"]) {
  return app.windows().find((p) => p.url().startsWith("http://127.0.0.1"));
}

/**
 * Point the app's browser store at one that already exists.
 *
 * The app installs Playwright browsers into `<userData>/recorder/browsers`, and
 * the `app` fixture hands every test a FRESH userData dir — so without this,
 * each test in this file downloads Chromium from scratch before it can run
 * anything. That is ~140MB per test of network flakiness bolted onto a test
 * about assertion semantics, and it is what made this spec fail intermittently
 * for reasons that had nothing to do with the app.
 *
 * A symlink rather than a copy: the store is only ever read.
 *
 * Returns false when no local install can be found, so the caller can skip with
 * a real explanation instead of timing out sixty seconds later.
 */
function seedBrowsers(userDataDir: string): boolean {
  const sources = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter((p): p is string => !!p && fs.existsSync(p));
  // The engine must match the Playwright the APP will spawn, so a build number
  // from a different Playwright is worse than nothing — it launches and fails.
  const wanted = `chromium-${chromiumBuild()}`;
  const src = sources.find((dir) => fs.existsSync(path.join(dir, wanted)));
  if (!src) return false;
  const dest = path.join(userDataDir, "recorder", "browsers");
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (!name.startsWith("chromium")) continue;
    const link = path.join(dest, name);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(src, name), link, "dir");
  }
  return true;
}

/** The Chromium build the installed Playwright expects, read from its own
 *  browser registry rather than hard-coded — it changes with every bump. */
function chromiumBuild(): string {
  const json = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "node_modules", "playwright-core", "browsers.json"),
      "utf-8",
    ),
  ) as { browsers: { name: string; revision: string }[] };
  return json.browsers.find((b) => b.name === "chromium")?.revision ?? "";
}

async function waitForPageReady(window: AppFixtures["window"]): Promise<void> {
  await expect
    .poll(async () => (await invoke<{ pageReady: boolean }>(window, "recorder:getState")).pageReady, {
      timeout: 20_000,
    })
    .toBe(true);
}

/** Record one short session against the fixture site and save it. Returns the
 *  saved record, so the caller can run exactly what the recorder produced. */
async function recordSession(
  app: AppFixtures["app"],
  window: AppFixtures["window"],
  siteUrl: string,
  name: string,
  extraSteps: Partial<Step>[],
): Promise<TestRecord> {
  await invoke(window, "recorder:start", { url: siteUrl, name });
  await waitForPageReady(window);
  const browser = trainingPage(app)!;
  await browser.waitForLoadState("domcontentloaded");

  // Real interactions, captured by the real capture script — not steps posted
  // over IPC. The point is to exercise the recorder's own locator choices.
  await browser.fill("#q", "shoes");
  await browser.click("#go");
  await expect.poll(async () => (await invoke<Step[]>(window, "recorder:getSteps")).length, {
    timeout: 15_000,
  }).toBeGreaterThanOrEqual(3);

  // The assertions are added the way the UI adds them: as steps at the cursor.
  for (const step of extraSteps) {
    await invoke(window, "recorder:insertStep", { step });
  }

  await invoke(window, "recorder:stop");
  const records = await expect
    .poll(async () => await invoke<TestRecord[]>(window, "tests:list"), { timeout: 20_000 })
    .not.toHaveLength(0)
    .then(() => invoke<TestRecord[]>(window, "tests:list"));
  const saved = records.find((r) => r.name === name);
  expect(saved, "the recording should have been saved as a test").toBeTruthy();
  return saved!;
}

/**
 * Run a saved test and report what the runner concluded.
 *
 * The run's console output is read with `runs:getLog`, NOT off the `RunRecord`
 * — the record carries a `logFile` PATH, not the text, so reading `.log` off it
 * yields `undefined`. That matters more than it looks: the heal assertion below
 * is a NEGATIVE one, and a negative match against an empty string passes
 * vacuously forever. This function returning "" for a real run is the shape of
 * a test that proves nothing, so the caller asserts the log is non-empty.
 */
async function runTest(
  window: AppFixtures["window"],
  id: string,
): Promise<{ status: string; output: string }> {
  await invoke<RunResult>(window, "runner:run", { id, runHeadless: true });
  // The runner is fire-and-forget; the run's outcome lands in run history.
  await expect
    .poll(
      async () => {
        const runs = await invoke<{ testId: string; status: string }[]>(window, "runs:list");
        return runs.filter((r) => r.testId === id).length;
      },
      { timeout: 180_000, intervals: [1000] },
    )
    .toBeGreaterThan(0);
  const runs = await invoke<{ id: string; testId: string; status: string }[]>(window, "runs:list");
  const mine = runs.filter((r) => r.testId === id)[0];
  const output = await invoke<string>(window, "runs:getLog", { id: mine.id });
  return { status: mine.status, output: output ?? "" };
}

test("a recording becomes a test that passes, with no healing", async ({ app, window, userDataDir }) => {
  test.skip(!seedBrowsers(userDataDir), "no local Chromium matching this Playwright — run `npx playwright install chromium`");
  const site = await serveSite();
  try {
    const record = await recordSession(app, window, site.url, "record-then-run", [
      // The assertion this whole effort started from. On this page it is TRUE,
      // so a failure here is the generator or the runner disagreeing with the
      // trainer — not the fixture.
      { type: "assert", assert: "url", value: "127.0.0.1" },
      { type: "assert", assert: "titleContains", value: "Shop" },
      { type: "assert", assert: "text", text: "Found 3", locator: { k: "testid", v: "result" } },
    ] as Partial<Step>[]);

    // What the recorder wrote, before running it. If this contains the old
    // bare-string form, the run below fails for a reason worth naming here.
    const script = await invoke<string>(window, "tests:getScript", { id: record.id });
    expect(script, "'URL contains' must not emit an exact whole-URL match").not.toMatch(
      /toHaveURL\("[^)]*"\)\s*;/,
    );

    const { status, output } = await runTest(window, record.id);
    expect(status, `the generated test should pass. Output:\n${output}`).toBe("passed");

    // The negative assertion below can only mean something against a real log.
    // Asserted first, because "no heals appear in an empty string" is exactly
    // the kind of vacuous pass this whole change exists to stop shipping.
    expect(output.length, "the run should have produced console output").toBeGreaterThan(0);
    // Zero heals. A green run that needed healing is a recording that was wrong,
    // and counting it as a pass is how a recorder's output rots while the
    // dashboard stays green.
    expect(output).not.toMatch(/\[glaze-heal\] healed/);
  } finally {
    await site.close();
  }
});

test("a recording with a false assertion produces a RED run", async ({ app, window, userDataDir }) => {
  test.skip(!seedBrowsers(userDataDir), "no local Chromium matching this Playwright — run `npx playwright install chromium`");
  // The control. Without this, "the run passed" could mean the harness never
  // asserted anything — which is precisely the failure mode being fixed, one
  // level up.
  const site = await serveSite();
  try {
    const record = await recordSession(app, window, site.url, "record-then-fail", [
      { type: "assert", assert: "url", value: "/definitely-not-this-path" },
    ] as Partial<Step>[]);

    const { status, output } = await runTest(window, record.id);
    expect(status, `a false assertion must fail the run. Output:\n${output}`).toBe("failed");
    // And it must fail as an ASSERTION, not as a timeout or a syntax error —
    // the URL assertion's whole history is failing for the wrong reason.
    expect(output).toMatch(/toHaveURL|expect/i);
  } finally {
    await site.close();
  }
});

test("the generated spec is on disk and is what the runner executed", async ({ app, window }) => {
  const site = await serveSite();
  try {
    const record = await recordSession(app, window, site.url, "record-then-read", []);
    const onDisk = fs.readFileSync(record.scriptPath, "utf-8");
    // The recorder's own locator choices, in the file. Asserted on the ACTIONS
    // and not merely on the `goto`, because a session that captured nothing
    // still writes a spec with a `goto` in it — which would make this test pass
    // while proving the opposite of what it claims.
    expect(onDisk).toContain("await page.goto(");
    expect(onDisk).toMatch(/\.fill\(/);
    expect(onDisk).toMatch(/\.click\(/);
    // Recorded against a page whose controls are labelled and test-idded, so the
    // recorder should never have needed a positional fallback here. A `.nth(` is
    // not a failure in general — it is the documented last resort — but on THIS
    // page it would mean the locator preference order stopped working.
    expect(onDisk).not.toContain(".nth(");
    expect(onDisk).not.toContain("UNGENERATABLE");
  } finally {
    await site.close();
  }
});
