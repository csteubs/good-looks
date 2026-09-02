// THE APP RUNNER'S SIDE of Handle pop-ups: the per-test switch, read by
// main/services/playwright-runner.ts, decides whether a run arms the built-in
// handlers — and says so, in the run log, either way.
//
// e2e/popup-dismissal.spec.ts is the authority on what the handlers DO,
// through the real CLI and the real fixtures; it cannot reach the gate,
// because the gate is the app resolving `TestRecord.handlePopups` against the
// global default and turning it into `dismissEnv` — or into nothing. Nothing
// short of the real app proves that a test which turned pop-ups off in the
// run options actually keeps its pop-up, and that one which left them on gets
// the "Handling pop-ups:" line and the fixture's own `armed:` report in the
// log it will be read from later. record-then-run.spec.ts's fourth test is the
// shape: a run-time fixture is proven fired by asserting its stderr line in the
// persisted log.
//
// Two tests, and the OFF one is the control for the ON one: the same test
// against the same site fails under the Klaviyo-shaped modal (the click is
// intercepted by its backdrop) and the log names the switch as the reason —
// so a green ON run cannot mean the modal never covered anything.
//
// The record is created through `tests:createFromPrompt` with a generated
// spec rather than recorded through the trainer: the subject is the RUNNER's
// gate, and a live recording session against a site that injects a modal
// mid-session would be a second feature under test (the trainer's own
// watcher) inside a test about the first.
//
// TO VERIFY IT CAN FAIL (this spec needs `npm run build` first, so the
// mutations below have NOT yet been run against it — the plain-browser
// sibling's two mutations have): hard-code `handlePopups = true` past
// `resolveHandlePopups` in the runner and the OFF test must go red — the run
// passes, the log carries "Handling pop-ups:" and no "is off for this test"
// line. Make `armedPopupRulesFor` return only user rules and the ON test must
// go red on the intercepted click.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { test, expect, type AppFixtures } from "./fixtures.js";
import { popupSiteHtml } from "../main/recorder/__fixtures__/vendor-popups.js";
import { generateSpecDetailed } from "../main/services/script-generator.js";
import type { Step } from "../main/recorder/types.js";

interface Invoke {
  glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } };
}

interface TestRecord {
  id: string;
  name: string;
  scriptPath: string;
  handlePopups?: boolean;
}

interface RunResult {
  runId?: string;
  ok?: boolean;
}

/** See popup-dismissal.spec.ts: the modal lands 1500ms after load and its
 *  backdrop is gone 600ms after the close click, so 3000ms is "arrived and
 *  handled" with headroom — and, with handling off, "arrived and in the way". */
const SETTLE_MS = 3000;

/** Bounded so the OFF run fails in seconds with Playwright's "intercepts
 *  pointer events" call log rather than at the test timeout. */
const CLICK_TIMEOUT_MS = 5000;

async function serveSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(popupSiteHtml());
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

/** A test against the synthetic site: land, let the modal arrive, buy under
 *  it, prove the buy landed. Created from a generated spec so the run
 *  executes exactly what a recording of these steps would. */
async function createTest(
  window: AppFixtures["window"],
  siteUrl: string,
  name: string,
): Promise<TestRecord> {
  const steps = [
    { id: "s0", type: "goto", url: siteUrl },
    { id: "s1", type: "wait", waitMs: SETTLE_MS },
    { id: "s2", type: "click", locator: { k: "testid", v: "buy" }, timeoutMs: CLICK_TIMEOUT_MS },
    { id: "s3", type: "assert", assert: "title", value: "bought" },
  ] as Step[];
  const { source } = generateSpecDetailed({ name, url: siteUrl, steps }, {});
  const rec = await invoke<TestRecord>(window, "tests:createFromPrompt", { name, url: siteUrl, source });
  expect(rec.id, "the test should have been created").toBeTruthy();
  return rec;
}

test("Handle pop-ups OFF: the run fails under the modal and the log names the switch", async ({ window, userDataDir }) => {
  test.skip(!seedBrowsers(userDataDir), "no local Chromium matching this Playwright — run `npx playwright install chromium`");
  const site = await serveSite();
  try {
    const rec = await createTest(window, site.url, "popups-off");
    // Auto-Heal OFF for this row. With it on (the shipped default) the
    // intercepted click was "healed" onto the modal's own container — a heal
    // that succeeds and clicks the wrong thing, the exact shape Settings →
    // Auto-Heal warns about — so the run still failed, one step later on the
    // title, and the intercept never reached the log. This row is about the
    // pop-up switch, so the other run-time repair is held still.
    await invoke(window, "recorder:setSettings", { autoHealEnabled: false });
    const updated = await invoke<TestRecord>(window, "tests:setHandlePopups", {
      id: rec.id,
      handlePopups: false,
    });
    expect(updated.handlePopups, "the switch is stored on the record").toBe(false);

    const { status, output } = await runTest(window, rec.id);
    // Asserted first, because every negative match below is vacuous against "".
    expect(output.length, "the run should have produced console output").toBeGreaterThan(0);
    expect(status, `with handling off the modal stays and the buy is intercepted. Output:\n${output}`).toBe("failed");
    // Playwright's own reason, and the phrase the runner's hint keys off.
    expect(output).toContain("intercepts pointer events");
    // The runner's hint, persisted with the rest of the log: the failure is
    // named as a setting, in the run options' words.
    expect(output).toContain(
      "A click was intercepted by another element and Handle pop-ups is off for this test.",
    );
    // The app said why, in the run options' words, BEFORE the run — a failure
    // under a banner the test chose to keep must not read as a broken locator.
    expect(output).toContain(
      "Handle pop-ups is off for this test — the built-in pop-up handlers were not armed.",
    );
    // And the fixture was not told about any rule: nothing armed, nothing
    // dismissed, no "Handling pop-ups:" line.
    expect(output).not.toContain("[glaze-dismiss] armed:");
    expect(output).not.toContain("[glaze-dismiss] dismissed:");
    expect(output).not.toContain("Handling pop-ups:");
  } finally {
    await site.close();
  }
});

test("Handle pop-ups ON: the run passes, and the log says what was armed and dismissed", async ({ window, userDataDir }) => {
  test.skip(!seedBrowsers(userDataDir), "no local Chromium matching this Playwright — run `npx playwright install chromium`");
  const site = await serveSite();
  try {
    const rec = await createTest(window, site.url, "popups-on");
    // Pinned on the record rather than left to the global default, so this
    // test reads the switch and not whatever Settings happens to hold.
    const updated = await invoke<TestRecord>(window, "tests:setHandlePopups", {
      id: rec.id,
      handlePopups: true,
    });
    expect(updated.handlePopups).toBe(true);

    const { status, output } = await runTest(window, rec.id);
    expect(output.length, "the run should have produced console output").toBeGreaterThan(0);
    expect(status, `with handling on the modal is clicked away and the buy lands. Output:\n${output}`).toBe("passed");
    // The app-side half: the system line, in the words the run options use,
    // naming both built-in handlers in the order they are armed.
    expect(output).toContain("Handling pop-ups: Klaviyo form — Close, DataGrail consent banner — Close.");
    // The fixture-side half: what it armed, and that something was dismissed —
    // the run only passed because the Klaviyo close was clicked, so a report
    // of nothing here would mean the pass came from somewhere else.
    expect(output).toContain("[glaze-dismiss] armed: Klaviyo form — Close, DataGrail consent banner — Close");
    expect(output).toContain("[glaze-dismiss] dismissed:");
    expect(output).not.toContain("Handle pop-ups is off for this test");
  } finally {
    await site.close();
  }
});
