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
// Two rows are about a tab's EVIDENCE rather than about following it, and they
// live here because that is where the tabs are: what a run RECORDS from a tab
// — its console, its page errors, its network — is subscribed once on the
// CONTEXT, because a per-page subscription is not in force until after the
// page it is for has already spoken (DECISIONS 2026-09-03).
//
// The last test is the control: with following OFF the anchor journey must go
// RED, or the rows above prove nothing.
//
// Changing what the fixture follows, waits for, or retries — or where a run's
// console, page errors or network are subscribed? Add a row.

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
import { buildHealMap } from "../shared/heal-map.mjs";
import { HEAL_EVENTS_FILE } from "../shared/heal-artifacts.mjs";
import { generateSpecDetailed } from "../main/services/script-generator.js";
import { dismissFixtureSource, DISMISS_FIXTURE_FILE } from "../shared/dismiss-fixture-source.mjs";
import { userPageFixtureSource, USER_PAGE_FIXTURE_FILE } from "../shared/user-page-fixture-source.mjs";
import {
  FOLLOW_TABS_ENV,
  TAB_OPENED_LINE,
  tabsFixtureSource,
  TABS_FIXTURE_FILE,
} from "../shared/tabs-fixture-source.mjs";
import { siteHealthFixtureSource, SITE_HEALTH_FIXTURE_FILE } from "../shared/site-health-fixture-source.mjs";
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
  <a data-testid="opened-link" href="/opened" target="_blank">Opened</a>
  <button data-testid="slowpop" onclick="(function(){var w=window.open('/slow-help');setTimeout(function(){try{w.console.log('popup pre-commit')}catch(e){}},100)})()">Slow popup</button>
</body></html>`,
    };
  }
  // `/slow-help` is `/help` with its response held back, so the opener can log
  // into the popup while it is still on about:blank — BEFORE the document
  // commits and before Playwright reports the page at all. See the row that
  // asks for "popup pre-commit".
  if (p === "/help" || p === "/slow-help") {
    return {
      status: 200,
      body: `<!doctype html><html><head>
  <script>console.log("help page parsing");</script>
  <title>Help</title></head><body>
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
  if (p === "/opened") {
    // Everything a tab can produce before anyone could attach to it: a console
    // line, a subresource request, and an uncaught error — all from the first
    // script in <head>, while the document is still parsing.
    return {
      status: 200,
      body: `<!doctype html><html><head>
  <script>
    console.log("opened tab parsing");
    fetch("/ping");
    throw new Error("opened tab exploded");
  </script>
  <title>Opened</title></head><body><h1 data-testid="heading">Opened</h1></body></html>`,
    };
  }
  if (p === "/ping") {
    return { status: 200, body: "pong", headers: { "content-type": "text/plain" } };
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
    const send = (): void => {
      res.writeHead(page.status, page.headers ?? { "content-type": "text/html; charset=utf-8" });
      res.end(page.body);
    };
    // The one deliberately slow route: it holds the popup on about:blank long
    // enough for the opener to log into it before the document commits.
    if ((req.url ?? "").startsWith("/slow-help")) setTimeout(send, 500);
    else send();
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
  fs.writeFileSync(path.join(dir, SITE_HEALTH_FIXTURE_FILE), siteHealthFixtureSource);
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
  opts: { follow?: boolean; capture?: boolean; heal?: boolean; timeoutMs?: number } = {},
): Promise<RunResult> {
  const follow = opts.follow ?? true;
  const capture = opts.capture ?? false;
  const heal = opts.heal ?? false;
  const id = `${name}-${++n}`;
  const { source, lineMap } = generateSpecDetailed({ name: id, url: base, steps }, {});
  const specPath = path.join(dir, `${id}.spec.ts`);
  fs.writeFileSync(specPath, source.replace(/from\s+["']@playwright\/test["']/, 'from "./glaze-capture.mjs"'));
  const artifactDir = path.join(dir, `${id}-artifacts`);
  // Run-time Auto-Heal is nothing without its MAP (R49): the fixture rethrows
  // untouched for a key it cannot find. Built through the shared builder, the
  // way both runners build it.
  const healDir = path.join(artifactDir, "heals");
  const healMapPath = path.join(dir, `${id}.heal-map.json`);
  if (heal) {
    fs.mkdirSync(healDir, { recursive: true });
    fs.writeFileSync(healMapPath, JSON.stringify(buildHealMap(steps, {})), "utf-8");
  }

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
        GLAZE_HEAL: heal ? "1" : "0",
        GLAZE_HEAL_MAP: heal ? healMapPath : "",
        GLAZE_HEAL_DIR: heal ? healDir : "",
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
const wait = (id: string, ms: number): Step => ({ id, type: "wait", waitMs: ms }) as Step;

interface ConsoleLog {
  entries: { text: string; type: string; page?: number }[];
}
interface NetworkLog {
  entries: { url: string; page?: number }[];
}
const readConsole = (res: RunResult): ConsoleLog =>
  JSON.parse(fs.readFileSync(path.join(res.artifactDir, "console.json"), "utf-8")) as ConsoleLog;
const readNetwork = (res: RunResult): NetworkLog =>
  JSON.parse(fs.readFileSync(path.join(res.artifactDir, "network.json"), "utf-8")) as NetworkLog;

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

test("a tab's console is captured from the moment it exists, not from when we attach", async () => {
  // THE ROW THAT FAILS WITHOUT THE FIX, and it fails every time rather than
  // sometimes. Console capture used to be subscribed PER PAGE, from inside the
  // tabs fixture's `page` handler — so the earliest it could exist was after
  // the tab's document did, and a document that logs while it parses raced it.
  // On CI that race was lost and the entry was simply absent.
  //
  // Following is OFF here, which turns the race into a certainty: with no tab
  // following there is no `page` handler at all, so nothing is ever attached
  // to the tab and NOTHING it produces is recorded. That is a lab condition
  // in the same spirit as this file's CONTROL row rather than a shipped
  // configuration — both runners gate log recording and tab following on the
  // same "not an imported test", so today a capture run always follows. It
  // removes the timing from the race so the property can be ASSERTED instead
  // of sampled, and it is the shape the bug takes the day those two gates
  // move apart.
  //
  // The journey stays on the opener, so it passes with following off: the tab
  // is opened and left alone, and the only question asked is whether its
  // evidence reached disk.
  const res = await run(
    "orphan-tab",
    [goto(), click("s-open", "opened-link"), wait("s-wait", 1500), title("s-home", "Home")],
    { capture: true, follow: false },
  );
  expect(res.code, res.output).toBe(0);
  expect(res.tabs, "following is off, so no tab marker is emitted").toEqual([]);

  const entries = readConsole(res).entries;
  const parsing = entries.find((e) => e.text.includes("opened tab parsing"));
  expect(parsing, `the opened tab's parse-time console line is captured. Got: ${JSON.stringify(entries.map((e) => e.text))}`).toBeTruthy();
  // An uncaught error from that same script, through the context's `weberror`
  // — the same channel, the same fix, and the entry type readers already match.
  const boom = entries.find((e) => e.text.includes("opened tab exploded"));
  expect(boom, "…and so is the error it threw while parsing").toBeTruthy();
  expect(boom?.type).toBe("pageerror");
  // With following off nothing stamps a tab index, and an entry that cannot
  // name its tab says nothing rather than claiming the first one.
  expect(parsing?.page).toBeUndefined();

  // The other half: network rides the same context subscription, and an entry
  // names its tab from the request's OWN frame rather than from whichever page
  // a listener was attached to.
  const net = readNetwork(res).entries;
  expect(net.find((e) => e.url.includes("/ping")), "the opened tab's subresource request too").toBeTruthy();
  // And the one request that is still absent, on purpose: a tab's own
  // navigation is issued before its frame exists, so nothing can say which tab
  // it belongs to, and it is left out rather than filed under the opener.
  expect(
    net.some((e) => e.url.endsWith("/opened")),
    "a tab's own document has no frame to name it, so it is not recorded",
  ).toBe(false);
});

test("a followed tab's console is captured from before its document commits, and tagged to that tab", async () => {
  // The same property with following ON, where there IS a tab vocabulary — and
  // the shape that loses without the fix EVERY time rather than sometimes.
  //
  // Playwright buffers what a page logs before it marks it initialized and
  // REPLAYS those messages on the context immediately after emitting the
  // `page` event, in the same synchronous stack (`Page._markInitialized` in
  // playwright-core). A per-page listener cannot exist yet — the client has
  // not seen the `page` event, let alone answered it — so the server's
  // dispatch check finds no page subscription and drops them. `/slow-help`
  // holds its response back so the opener can log into the popup while it is
  // still on about:blank, which is exactly that window: measured lost 10 times
  // out of 10 per page, 0 out of 10 on the context.
  //
  // The parse-time line is the reported flake itself — logged after the
  // document commits, so it is a genuine race that a laptop usually wins and a
  // loaded CI runner does not. Both are asserted here, so the row states the
  // whole property and still fails on any machine without the fix.
  const res = await run(
    "parse-tag",
    [goto(), click("s-slow", "slowpop"), title("s-title", "Help"), text("s-heading", "heading", "Help page")],
    { capture: true },
  );
  expect(res.code, res.output).toBe(0);
  expect(res.tabs.map((t) => t.count)).toEqual([2]);
  const entries = readConsole(res).entries;
  const texts = JSON.stringify(entries.map((e) => e.text));

  const preCommit = entries.find((e) => e.text.includes("popup pre-commit"));
  expect(preCommit, `a line logged before the tab's document committed is captured. Got: ${texts}`).toBeTruthy();
  expect(preCommit?.page, "…and it is filed under the tab it was logged into").toBe(1);

  const parsing = entries.find((e) => e.text.includes("help page parsing"));
  expect(parsing, `and so is one logged during its initial parse. Got: ${texts}`).toBeTruthy();
  expect(parsing?.page, "…filed under the same tab").toBe(1);

  // Once, not once per page: a context subscription made twice would double
  // every line in the file.
  expect(entries.filter((e) => e.text.includes("help page parsing")).length).toBe(1);
});

test("Auto-Heal heals a stale locator ON THE SECOND TAB", async () => {
  // The heal fixture tags a page's locator factories per page and runs its
  // probe on the locator's OWN page. Before the tabs work it tagged the
  // fixture page only and probed the closed-over page — so a locator that
  // went stale on a tab the page opened arrived with no key, and even keyed,
  // its probe would have ranked candidates on the opener, where the element
  // never was. Written-but-unwired is R49's shape: healing installed,
  // reporting armed, healing nothing. This row is the one that notices.
  //
  // The recorded locator names a test id the help page no longer has; the
  // fingerprint remembers the button as it was, and the probe finds it under
  // its current id.
  const stale: Step = {
    id: "s-ok-stale",
    type: "click",
    locator: { k: "testid", v: "ok-old" },
    // A short wait for the stale locator, so the failure that triggers the
    // heal costs seconds rather than the test's whole budget.
    timeoutMs: 2000,
    fingerprint: {
      tag: "button",
      description: "button",
      candidates: [{ k: "testid", v: "ok" }, { k: "role", v: "button", role: "button", name: "OK" }],
      attributes: {},
      text: "OK",
      depth: 3,
    },
  } as Step;
  const res = await run(
    "heal",
    [goto(), click("s-open", "help-link"), title("s-title", "Help"), stale, text("s-msg", "msg", "clicked")],
    { heal: true, capture: true },
  );
  expect(res.code, res.output).toBe(0);
  expect(res.output).toMatch(/\[glaze-heal\] healed/);
  const events = JSON.parse(fs.readFileSync(path.join(res.artifactDir, "heals", HEAL_EVENTS_FILE), "utf-8")) as {
    outcome: string;
    url?: string;
    appliedLocator?: { k: string; v: string };
  }[];
  const healed = events.find((e) => e.outcome === "healed");
  expect(healed, `a heal event is recorded. Events: ${JSON.stringify(events)}`).toBeTruthy();
  // On the tab the page opened, under the button's current id.
  expect(healed?.url).toMatch(/\/help$/);
  expect(healed?.appliedLocator).toEqual({ k: "testid", v: "ok" });
  // And the healed click's evidence says which tab it ran on.
  const manifest = JSON.parse(fs.readFileSync(path.join(res.artifactDir, "manifest.json"), "utf-8")) as {
    steps: { action: string; page?: number }[];
  };
  expect(manifest.steps.filter((s) => s.action === "click" && s.page === 1).length).toBeGreaterThan(0);
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
