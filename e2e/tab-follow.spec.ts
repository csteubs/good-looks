// THE RUN FOLLOWS THE NEWEST TAB — the authority.
//
// The trainer records a linear journey: `keepInWindow` rewrites every `_blank`
// target and the window-open handler denies every `window.open`, so a click
// that a real browser opens in a new tab is recorded as a click followed by
// steps on the document it opened. A run has none of that. Real Playwright
// honours the target, a second Page appears, the spec's one `page` stays on
// the opener, and every later step acts on the wrong document while the
// trainer showed the journey green.
//
// `shared/tabs-fixture-source.mjs` makes the run follow: the `page` a spec
// gets is a proxy over the newest open page, locators materialize when they
// act, `expect` resolves its receiver at call time, an in-page signal makes
// the next step wait for a tab the page said is coming, and a step whose page
// closed underneath is retried once. Every one of those was found necessary by
// the spike this file grew from: the anchor case failed without the signal,
// the self-closing popup failed without the lazy locators and the retry.
//
// Nothing short of real Playwright can answer any of it — Playwright's page
// matchers bind their receiver once, inside its own library, which no model of
// them in jsdom can reproduce. So this runs REAL generated specs through the
// REAL CLI with the shipped fixtures, the same harness `step-progress.spec.ts`
// uses, and asserts the exit code, the marker stream and the artifacts.
//
// The last test is the control: with following OFF the anchor journey must go
// RED, or the rows above prove nothing.
//
// Changing what the fixture follows, waits for, or retries? Add a row.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { test, expect } from "@playwright/test";

import { captureFixtureSource } from "../shared/capture-fixture-source.mjs";
import { glazeRuntimeSource, GLAZE_RUNTIME_FILE } from "../shared/glaze-runtime-source.mjs";
import { healFixtureSource, HEAL_FIXTURE_FILE } from "../shared/heal-fixture-source.mjs";
import { generateSpecDetailed } from "../main/services/script-generator.js";
import { dismissFixtureSource, DISMISS_FIXTURE_FILE } from "../shared/dismiss-fixture-source.mjs";
import { userPageFixtureSource, USER_PAGE_FIXTURE_FILE } from "../shared/user-page-fixture-source.mjs";
import {
  FOLLOW_TABS_ENV,
  TAB_OPENED_LINE,
  tabsFixtureSource,
  TABS_FIXTURE_FILE,
} from "../shared/tabs-fixture-source.mjs";
import { settleFixtureSource, SETTLE_FIXTURE_FILE } from "../shared/settle-fixture-source.mjs";
import {
  signatureFixtureSource,
  SIGNATURE_FIXTURE_FILE,
} from "../shared/signature-fixture-source.mjs";
import { splitStepMarkers, type StepMarker, type TabMarker } from "../shared/step-marker.mjs";
import { stepReporterSource } from "../shared/step-reporter-source.mjs";
import { playwrightConfigSource, PLAYWRIGHT_CONFIG_FILE } from "../shared/playwright-config-source.mjs";
import type { Step } from "../main/recorder/types.js";

/** A site with every way a page opens a tab, and a page behind each. */
function pageFor(url: string): { status: number; body: string; headers?: Record<string, string> } {
  const p = new URL(url, "http://x").pathname;
  if (p === "/") {
    return {
      status: 200,
      body: `<!doctype html><html><head><title>Home</title></head><body>
  <h1 data-testid="heading">Home</h1>
  <a data-testid="help-link" href="/help" target="_blank">Help</a>
  <button data-testid="open" onclick="window.open('/help')">Open</button>
  <button data-testid="noopener" onclick="window.open('/help', '_blank', 'noopener')">Noopener</button>
  <form action="/help" target="_blank"><button data-testid="submit">Submit</button></form>
  <button data-testid="closer" onclick="window.open('/closer')">Closer</button>
  <a data-testid="download" href="/report.bin" target="_blank" download>Download</a>
</body></html>`,
    };
  }
  if (p === "/help") {
    return {
      status: 200,
      body: `<!doctype html><html><head><title>Help</title></head><body>
  <h1 data-testid="heading">Help page</h1>
  <button data-testid="ok">OK</button>
  <p data-testid="msg">waiting</p>
  <script>
    console.log("help page ready");
    document.querySelector('[data-testid="ok"]').addEventListener('click', () => {
      document.querySelector('[data-testid="msg"]').textContent = 'clicked';
    });
  </script>
</body></html>`,
    };
  }
  if (p === "/closer") {
    return {
      status: 200,
      body: `<!doctype html><html><head><title>Closer</title></head><body><script>setTimeout(() => window.close(), 300)</script></body></html>`,
    };
  }
  if (p === "/report.bin") {
    return {
      status: 200,
      body: "data",
      headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=report.bin" },
    };
  }
  return { status: 404, body: "nope" };
}

let server: http.Server;
let base: string;
let dir: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const page = pageFor(req.url ?? "/");
    res.writeHead(page.status, page.headers ?? { "content-type": "text/html; charset=utf-8" });
    res.end(page.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The scripts dir the app writes at run time, reproduced from the sources
  // that ship — the same set `run-fixtures.mjs` lists.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-tab-follow-"));
  fs.writeFileSync(path.join(dir, PLAYWRIGHT_CONFIG_FILE), playwrightConfigSource);
  fs.writeFileSync(path.join(dir, "step-reporter.mjs"), stepReporterSource);
  fs.writeFileSync(path.join(dir, "glaze-capture.mjs"), captureFixtureSource);
  fs.writeFileSync(path.join(dir, HEAL_FIXTURE_FILE), healFixtureSource);
  fs.writeFileSync(path.join(dir, SETTLE_FIXTURE_FILE), settleFixtureSource);
  fs.writeFileSync(path.join(dir, SIGNATURE_FIXTURE_FILE), signatureFixtureSource);
  fs.writeFileSync(path.join(dir, DISMISS_FIXTURE_FILE), dismissFixtureSource);
  fs.writeFileSync(path.join(dir, USER_PAGE_FIXTURE_FILE), userPageFixtureSource);
  fs.writeFileSync(path.join(dir, TABS_FIXTURE_FILE), tabsFixtureSource);
  fs.writeFileSync(path.join(dir, GLAZE_RUNTIME_FILE), glazeRuntimeSource);
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(dir, "node_modules"));
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  /** step index → the transitions reported for it, in order. */
  reported: Map<number, StepMarker[]>;
  tabs: TabMarker[];
  /** stdout with the markers taken out, plus stderr — what the log holds. */
  output: string;
  artifactDir: string;
}

let n = 0;

/** Run one recorded journey through the real CLI with the shipped fixtures,
 *  following on unless a row turns it off. */
async function run(
  name: string,
  steps: Step[],
  opts: { follow?: boolean; capture?: boolean; timeoutMs?: number } = {},
): Promise<RunResult> {
  const follow = opts.follow ?? true;
  const capture = opts.capture ?? false;
  const id = `${name}-${++n}`;
  const { source, lineMap } = generateSpecDetailed({ name: id, url: base, steps }, {});
  const specPath = path.join(dir, `${id}.spec.ts`);
  fs.writeFileSync(specPath, source.replace(/from\s+["']@playwright\/test["']/, 'from "./glaze-capture.mjs"'));
  const artifactDir = path.join(dir, `${id}-artifacts`);

  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "@playwright", "test", "cli.js"),
      "test",
      specPath,
      "--config",
      path.join(dir, PLAYWRIGHT_CONFIG_FILE),
      "--reporter",
      `${path.join(dir, "step-reporter.mjs")},line`,
      "--workers=1",
      `--timeout=${opts.timeoutMs ?? 30_000}`,
      "--browser=chromium",
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PW_EXPECT_TIMEOUT_MS: "4000",
        PW_OUTPUT_DIR: path.join(dir, `${id}-out`),
        [FOLLOW_TABS_ENV]: follow ? "1" : "0",
        GLAZE_CAPTURE_ARTIFACTS: capture ? "1" : "0",
        GLAZE_RECORD_LOGS: capture ? "1" : "0",
        GLAZE_ARTIFACT_DIR: capture ? artifactDir : "",
        GLAZE_TEST_ID: "t-tabs",
        GLAZE_RUN_ID: id,
      },
    },
  );

  const reported = new Map<number, StepMarker[]>();
  const tabs: TabMarker[] = [];
  let buffered = "";
  let output = "";
  child.stdout.on("data", (d: Buffer) => {
    const split = splitStepMarkers(buffered, d.toString());
    buffered = split.rest;
    output += split.visible;
    tabs.push(...split.tabs);
    for (const marker of split.markers) {
      const index = lineMap[marker.line];
      if (index === undefined) continue;
      const list = reported.get(index) ?? [];
      list.push(marker);
      reported.set(index, list);
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    output += d.toString();
  });
  const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? 1)));
  return { code, reported, tabs, output, artifactDir };
}

const goto = (): Step => ({ id: "s-goto", type: "goto", url: base }) as Step;
const click = (id: string, testid: string): Step =>
  ({ id, type: "click", locator: { k: "testid", v: testid } }) as Step;
const title = (id: string, value: string): Step =>
  ({ id, type: "assert", assert: "title", value }) as Step;
const urlContains = (id: string, value: string): Step =>
  ({ id, type: "assert", assert: "url", value }) as Step;
const text = (id: string, testid: string, value: string): Step =>
  ({ id, type: "assert", assert: "text", locator: { k: "testid", v: testid }, text: value }) as Step;

/** The journey every row shares: open the help tab, act on it, assert on it. */
function helpJourney(opener: Step): Step[] {
  return [
    goto(),
    opener,
    urlContains("s-url", "/help"),
    title("s-title", "Help"),
    click("s-ok", "ok"),
    text("s-msg", "msg", "clicked"),
  ];
}

test("a link with target=_blank: the run follows the tab it opened", async () => {
  const res = await run("anchor", helpJourney(click("s-open", "help-link")));
  expect(res.code, res.output).toBe(0);
  // Announced on the marker channel, once, with the count of open tabs.
  expect(res.tabs.map((t) => t.count)).toEqual([2]);
  // And in the log, where the Output tab and the saved run show it.
  expect(res.output).toContain(`${TAB_OPENED_LINE} (#2)`);
});

test("window.open: followed the same way", async () => {
  const res = await run("open", helpJourney(click("s-open", "open")));
  expect(res.code, res.output).toBe(0);
  expect(res.tabs.map((t) => t.count)).toEqual([2]);
});

test("a noopener popup and a form target=_blank are followed too", async () => {
  const res = await run("noopener-form", [
    goto(),
    click("s-noop", "noopener"),
    title("s-t1", "Help"),
    goto(),
    click("s-submit", "submit"),
    title("s-t2", "Help"),
  ]);
  expect(res.code, res.output).toBe(0);
  // The second goto navigates the HELP tab (the active one) home again, so
  // the form opens a third tab: the count is what the browser had open.
  expect(res.tabs.map((t) => t.count)).toEqual([2, 3]);
});

test("a popup that closes itself: the next step lands on the opener", async () => {
  // The run reaches the assertion in milliseconds; the popup takes 300ms to
  // close. The assertion binds the popup, fails when it goes, and is retried
  // once on the page that replaced it — which is where the recording's next
  // step was taken.
  const res = await run("closer", [
    goto(),
    click("s-closer", "closer"),
    title("s-home", "Home"),
    text("s-heading", "heading", "Home"),
  ]);
  expect(res.code, res.output).toBe(0);
  expect(res.tabs.map((t) => t.count)).toEqual([2]);
});

test("a _blank link that downloads opens no tab, and the download step still works", async () => {
  const res = await run("download", [
    goto(),
    click("s-dl", "download"),
    { id: "s-expect", type: "download", value: "report.bin", downloadMatch: "exact" } as Step,
  ]);
  expect(res.code, res.output).toBe(0);
  expect(res.tabs).toEqual([]);
});

test("the anchor race, ten times in one run", async () => {
  // The signal that makes the anchor case work is a race the spike measured
  // as lost every time without it. Ten rounds in one spec is the cheapest
  // way to keep asking.
  const steps: Step[] = [];
  for (let i = 0; i < 10; i++) {
    steps.push(
      { id: `s-goto-${i}`, type: "goto", url: base } as Step,
      click(`s-open-${i}`, "help-link"),
      title(`s-title-${i}`, "Help"),
      text(`s-heading-${i}`, "heading", "Help page"),
    );
  }
  const res = await run("race", steps, { timeoutMs: 90_000 });
  expect(res.code, res.output).toBe(0);
  // Every goto navigates the active (help) tab home, and every click opens
  // one more: the count climbs by one per round.
  expect(res.tabs.map((t) => t.count)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("assertions still report their step while expect goes through the fixture", async () => {
  // The step reporter files an assertion under `expect` with its location —
  // which is now the tabs fixture, so the file guard drops it. The wrapper
  // announces the step itself; without that every assertion in every run
  // would leave the progress bar on the step before it.
  const res = await run("progress", helpJourney(click("s-open", "help-link")));
  expect(res.code, res.output).toBe(0);
  // Steps 2, 3 and 5 are the assertions (url, title, text).
  for (const index of [2, 3, 5]) {
    const events = (res.reported.get(index) ?? []).map((m) => `${m.event}:${m.ok}`);
    expect(events, `assertion step ${index} reports begin and end`).toEqual(["begin:true", "end:true"]);
  }
  // And the actions on the second tab report too (the click on OK is step 4).
  expect((res.reported.get(4) ?? []).map((m) => m.event)).toEqual(["begin", "end"]);
});

test("a capture run's evidence follows the tab: screenshots and console say which one", async () => {
  const res = await run("capture", helpJourney(click("s-open", "help-link")), { capture: true });
  expect(res.code, res.output).toBe(0);
  const manifest = JSON.parse(fs.readFileSync(path.join(res.artifactDir, "manifest.json"), "utf-8")) as {
    steps: { index: number; action: string; page?: number }[];
  };
  // The OK click happened on tab 2, and the manifest entry says so; the
  // opener's steps carry no tab, exactly as a manifest predating tabs would.
  const onTab = manifest.steps.filter((s) => s.page === 1);
  expect(onTab.map((s) => s.action)).toContain("click");
  expect(manifest.steps.filter((s) => s.action === "goto").every((s) => s.page === undefined)).toBe(true);
  // A screenshot exists for a step taken on the second tab.
  for (const s of onTab) expect(fs.existsSync(path.join(res.artifactDir, `${s.index}.png`))).toBe(true);
  // The help page's own console line was recorded, from the second tab.
  const consoleLog = JSON.parse(fs.readFileSync(path.join(res.artifactDir, "console.json"), "utf-8")) as {
    entries: { text: string; page?: number }[];
  };
  const ready = consoleLog.entries.find((e) => e.text.includes("help page ready"));
  expect(ready, "the second tab's console is captured").toBeTruthy();
  expect(ready?.page).toBe(1);
});

test("CONTROL: with following off, the same journey goes red", async () => {
  // A harness that cannot fail is not evidence. Playwright's `page` stays on
  // the opener, the URL assertion polls the wrong document, and the run fails
  // as an assertion — which is the bug this whole feature exists to fix.
  const res = await run("control", helpJourney(click("s-open", "help-link")), { follow: false, timeoutMs: 15_000 });
  expect(res.code, res.output).not.toBe(0);
  expect(res.output).toMatch(/toHaveURL/);
  expect(res.tabs).toEqual([]);
});
