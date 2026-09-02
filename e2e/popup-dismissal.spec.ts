// THE AUTHORITY on the built-in pop-up handlers (shared/popup-presets.mjs):
// real Playwright, the real run fixtures and a generated spec, against markup
// shaped like the two vendors the presets ship for.
//
// The presets are DATA — two CSS selectors — and everything else about them is
// already covered without a browser: main/services/popup-presets.test.ts pins
// the switch and the env round trip, and main/recorder/popup-presets.dom.test.ts
// proves the trainer's watcher resolves each target through the app's locator
// engine in jsdom. What neither can answer is the only question a user cares
// about: does a click UNDER the modal succeed in a run? jsdom has no layout, so
// nothing there can be "intercepted by another element" — the one failure this
// feature exists to prevent — and the run's dismissal fixture only exists as a
// string the Playwright CLI loads through its own transform (CLAUDE.md's
// "anything that ships as source we do not execute" blind spot). So this
// spawns the CLI the way playwright-runner does, over ALWAYS_WRITTEN +
// CAPABILITY_FIXTURES from shared/run-fixtures.mjs, with the rules carried in
// the same `dismissEnv` the app and the CLI write.
//
// The site is main/recorder/__fixtures__/vendor-popups.ts — ONE fixture shared
// with the jsdom test, so the two halves cannot describe different markup. A
// DataGrail-shaped banner (open shadow root) on every document; a
// Klaviyo-shaped modal 1.5s after load whose full-viewport backdrop covers the
// Buy button, and whose close control is removed 600ms AFTER the click (the
// measured behaviour that produced seven clicks before the watcher's
// clicked-set existed). Each close counts into an attribute on <html>, so a
// step can assert "clicked once" rather than "clicked".
//
// Four rows:
//  (a) presets on — the buy click succeeds on both documents, the banner is
//      reported dismissed on each, and each close was clicked exactly once;
//  (b) Handle pop-ups off — the SAME spec fails with "intercepts pointer
//      events". The control: without it a green (a) could mean the modal never
//      covered anything;
//  (c) a taught rule for the same control armed ahead of the presets — the
//      node is clicked once, by the taught rule, and the preset behind it
//      reports nothing. "Each node once" is by node identity, not per rule;
//  (d) LIVE, opt-in: GL_LIVE_SITE names a real site (ritual.com is where the
//      selectors were measured) and the presets run against it. Skipped
//      without the variable — CI and the container this was built in cannot
//      reach the site — and skipped again, never vacuously passed, when no
//      vendor overlay appears in the window. See DECISIONS 2026-09-01.
//
// Deliberately not an Electron test, like continue-on-failure and
// retry-evidence: the subject is what real Playwright does with the fixture,
// not a window. The app runner's GATE — the per-test switch and its system
// lines — is e2e/popup-toggle.spec.ts.
//
// VERIFIED TO FAIL, two ways. Deleting the Klaviyo entry from POPUP_PRESETS:
// (a) and (c) go red — the buy click is intercepted by the backdrop, the armed
// line no longer names the form. Deleting `markClicked(el)` from the watcher
// (shared/overlay-rules.mjs): (a) and (c) go red on the `data-klaviyo-closes`
// step — the close is clicked on every sweep in the 600ms before it is removed,
// so the count reads 2 or more where the step asserts "1". Both restored
// byte-for-byte (cp/cmp).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { popupSiteHtml } from "../main/recorder/__fixtures__/vendor-popups.js";
import { generateSpecDetailed } from "../main/services/script-generator.js";
import { dismissEnv } from "../shared/dismiss-fixture-names.mjs";
import type { OverlayRuleLike } from "../shared/overlay-rules.mjs";
import {
  playwrightConfigSource,
  PLAYWRIGHT_CONFIG_FILE,
} from "../shared/playwright-config-source.mjs";
import { armedPopupRulesFor, type ArmedRuleLike } from "../shared/popup-presets.mjs";
import {
  ALWAYS_WRITTEN,
  CAPABILITY_FIXTURES,
  redirectToCaptureFixture,
} from "../shared/run-fixtures.mjs";
import type { Step } from "../main/recorder/types.js";

/** The armed line the fixture prints, in preset order. A literal rather than
 *  a join over POPUP_PRESETS on purpose: these are the words the run log and
 *  the app's "Handling pop-ups:" system line show a user, and a rename should
 *  fail here where somebody will read why. */
const ARMED_PRESETS = "[glaze-dismiss] armed: Klaviyo form — Close, DataGrail consent banner — Close";

/** How long a step waits for the modal to arrive AND be cleared away: the
 *  fixture injects it 1500ms after load and removes it 600ms after the close
 *  click, so 2100ms is the earliest the button underneath is clickable. The
 *  rest is headroom for a loaded CI runner — the wait is the same in the
 *  control row, where it only makes the modal certain to be up. */
const SETTLE_MS = 3000;

/** The buy click's own timeout. Bounded so the CONTROL fails in seconds with
 *  Playwright's own "intercepts pointer events" call log, rather than eating
 *  the whole test budget and reporting a test timeout — the shape
 *  continue-on-failure.spec.ts was written against. */
const CLICK_TIMEOUT_MS = 5000;

let server: http.Server;
let base: string;
let dir: string;

test.beforeAll(async () => {
  // Every path serves the page — the fixture links to /two so the run reaches
  // a SECOND document, which is what "on every document" means.
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(popupSiteHtml());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  // The scripts dir the app and the CLI write at run time, from the ONE table
  // both iterate — a fixture missing here is an import error at load, not a
  // disabled feature (shared/run-fixtures.mjs).
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-popup-dismissal-"));
  fs.writeFileSync(path.join(dir, PLAYWRIGHT_CONFIG_FILE), playwrightConfigSource);
  for (const { file, source } of [...ALWAYS_WRITTEN, ...CAPABILITY_FIXTURES]) {
    fs.writeFileSync(path.join(dir, file), source);
  }
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(dir, "node_modules"));
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The recorded shape: land, let the modal arrive, buy under it, prove the
 *  buy landed, then the same again on a second document. The two attribute
 *  assertions read the fixture's own click counters off <html> — "1" is the
 *  clicked-set doing its job, not merely the overlay being gone. */
function siteSteps(): Step[] {
  const buy = (id: string): Step =>
    ({ id, type: "click", locator: { k: "testid", v: "buy" }, timeoutMs: CLICK_TIMEOUT_MS }) as Step;
  const bought = (id: string): Step => ({ id, type: "assert", assert: "title", value: "bought" }) as Step;
  const closedOnce = (id: string, attr: string): Step =>
    ({ id, type: "assert", assert: "attribute", attr, value: "1", locator: { k: "css", v: "html" } }) as Step;
  return [
    { id: "s0", type: "goto", url: base },
    { id: "s1", type: "wait", waitMs: SETTLE_MS },
    buy("s2"),
    bought("s3"),
    closedOnce("s4", "data-klaviyo-closes"),
    closedOnce("s5", "data-dg-closes"),
    { id: "s6", type: "click", locator: { k: "testid", v: "next" } },
    { id: "s7", type: "wait", waitMs: SETTLE_MS },
    buy("s8"),
    bought("s9"),
    closedOnce("s10", "data-klaviyo-closes"),
    closedOnce("s11", "data-dg-closes"),
  ] as Step[];
}

interface RunResult {
  exitCode: number;
  /** The CLI's stdout — the line reporter, and so every failure's call log. */
  stdout: string;
  /** The fixture's diagnostics. It writes to stderr on purpose (stdout carries
   *  the step markers), so this is where `armed:` and `dismissed:` are. */
  stderr: string;
  /** Both, interleaved as they arrived, for a failure message. */
  out: string;
}

/** Run a generated spec through the real CLI with the given rules armed —
 *  the same fixture files, redirect and environment an app run gets. */
async function run(opts: {
  name: string;
  url: string;
  steps: Step[];
  rules: readonly ArmedRuleLike[];
  timeoutMs?: number;
}): Promise<RunResult> {
  const { source } = generateSpecDetailed({ name: opts.name, url: opts.url, steps: opts.steps }, {});
  const redirected = redirectToCaptureFixture(source);
  expect(redirected, "a generated spec imports @playwright/test, so there is an import to redirect").not.toBeNull();
  const specPath = path.join(dir, `${opts.name}.spec.ts`);
  fs.writeFileSync(specPath, redirected!);

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
      `--timeout=${opts.timeoutMs ?? 20_000}`,
      "--browser=chromium",
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PW_OUTPUT_DIR: path.join(dir, `${opts.name}-out`),
        FORCE_COLOR: "0",
        GLAZE_TEST_ID: "t-popups",
        GLAZE_RUN_ID: opts.name,
        // The whole transport: count plus one label and one target per rule.
        // An empty list writes a count of zero, which is how the fixture is
        // told to stand down — not by leaving the variables out.
        ...dismissEnv(opts.rules),
      },
    },
  );
  let stdout = "";
  let stderr = "";
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
    out += d.toString();
  });
  const exitCode = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
  return { exitCode, stdout, stderr, out };
}

/** The `dismissed:` report, or null when the fixture printed none. */
function dismissedLine(stderr: string): string | null {
  const m = /\[glaze-dismiss\] dismissed: (.*)/.exec(stderr);
  return m ? m[1] : null;
}

test("the built-in handlers click a Klaviyo form and a DataGrail banner away, on every document", async () => {
  const res = await run({
    name: "presets-on",
    url: base,
    steps: siteSteps(),
    rules: armedPopupRulesFor({ rules: [], url: base, handlePopups: true }),
  });

  // The user's question first: the buy under the modal went through, twice,
  // and every assertion after it held — one exit code.
  expect(res.exitCode, res.out).toBe(0);

  // The fixture said what it armed, in the words the app's own system line
  // uses, and in the order the watcher sweeps.
  expect(res.stderr).toContain(ARMED_PRESETS);

  // ...and what it dismissed. (x2) is the point of a STANDING rule: the banner
  // is re-injected on the second document and clicked away again there. The
  // Klaviyo form is (x2) too, because the second wait lets it arrive again.
  const dismissed = dismissedLine(res.stderr);
  expect(dismissed, res.stderr).not.toBeNull();
  expect(dismissed).toMatch(/DataGrail consent banner — Close \(x2\)/);
  expect(dismissed).toMatch(/Klaviyo form — Close \(x2\)/);
});

test("with Handle pop-ups off the click under the modal fails — the control", async () => {
  // `armedPopupRulesFor({ handlePopups: false })` is `[]`; what reaches the
  // fixture is a count of zero, exactly as the app runner writes it.
  const res = await run({ name: "presets-off", url: base, steps: siteSteps(), rules: [] });

  expect(res.exitCode, "the same spec, unhandled, must fail").not.toBe(0);
  // And it fails for THE reason: the modal's backdrop is over the button. This
  // is Playwright's own wording, and the phrase the app runner keys its
  // "turn Handle pop-ups on" hint off.
  expect(res.stdout).toContain("intercepts pointer events");

  // Nothing was armed. Asserted against a stream that is provably non-empty
  // first — the line reporter wrote the failure to stdout, so `out` carries
  // it — because a negative match against "" is a test of nothing.
  expect(res.out.length).toBeGreaterThan(0);
  expect(res.stderr).not.toContain("[glaze-dismiss] armed:");
  expect(res.stderr).not.toContain("[glaze-dismiss] dismissed:");
});

test("a taught rule beside the presets clicks each node once", async () => {
  // A rule the user taught for the SAME control the DataGrail preset targets,
  // on this site's host. User rules are armed first (popup-presets.mjs), so
  // the taught rule is the one that claims the node.
  const taught: OverlayRuleLike = {
    id: "r1",
    host: new URL(base).hostname,
    label: "Cookie banner — Close",
    target: { k: "css", v: ".dg-header-close" },
  };
  const rules = armedPopupRulesFor({ rules: [taught], url: base, handlePopups: true });
  expect(rules.map((r) => r.label)).toEqual([
    "Cookie banner — Close",
    "Klaviyo form — Close",
    "DataGrail consent banner — Close",
  ]);

  const res = await run({ name: "taught-and-presets", url: base, steps: siteSteps(), rules });

  // The `data-dg-closes` = "1" steps are inside this exit code: a second click
  // on the same node — by the preset, after the taught rule — would count 2.
  expect(res.exitCode, res.out).toBe(0);
  expect(res.stderr).toContain(
    "[glaze-dismiss] armed: Cookie banner — Close, Klaviyo form — Close, DataGrail consent banner — Close",
  );

  const dismissed = dismissedLine(res.stderr);
  expect(dismissed, res.stderr).not.toBeNull();
  // The taught rule fired on both documents...
  expect(dismissed).toMatch(/Cookie banner — Close \(x2\)/);
  // ...and the preset behind it never did: the node was already in the
  // clicked-set when the sweep reached it. The label is in the ARMED line
  // above, so this is asserted on the dismissed report alone.
  expect(dismissed).not.toContain("DataGrail consent banner — Close");
  expect(dismissed).toMatch(/Klaviyo form — Close/);
});

// ── The live row ───────────────────────────────────────────────────────────
//
//   GL_LIVE_SITE=https://www.ritual.com/ npx playwright test --config e2e/playwright.config.ts popup-dismissal -g live
//
// Three outcomes and each is honest: red when the run itself fails (the site
// could not be reached, or the fixture failed to install), green when an
// overlay appeared and a preset dismissed it, SKIPPED when none appeared in the
// window — a marketing modal is on the vendor's timer and a consent banner may
// remember a decision, so "nothing showed" is not evidence either way.
test("LIVE: the presets against a real site (GL_LIVE_SITE)", async () => {
  const site = process.env.GL_LIVE_SITE;
  test.skip(!site, "set GL_LIVE_SITE=https://www.ritual.com/ to run the presets against the real site");
  // Ritual's modal was measured at ~8s; 30s is generous without being a
  // budget nobody waits out.
  const LIVE_WAIT_MS = 30_000;
  const res = await run({
    name: "live",
    url: site!,
    steps: [
      { id: "s0", type: "goto", url: site! },
      { id: "s1", type: "wait", waitMs: LIVE_WAIT_MS },
    ] as Step[],
    rules: armedPopupRulesFor({ rules: [], url: site!, handlePopups: true }),
    timeoutMs: 60_000,
  });

  expect(res.exitCode, res.out).toBe(0);
  expect(res.stderr).toContain(ARMED_PRESETS);

  const dismissed = dismissedLine(res.stderr);
  if (dismissed === null) {
    // The fixture reports one way or the other; anything else is a broken
    // fixture, not a quiet site.
    expect(res.stderr).toContain("[glaze-dismiss] no overlay matched a rule this run");
    test.skip(true, `no vendor overlay appeared in ${LIVE_WAIT_MS / 1000}s on ${site}`);
  }
  expect(dismissed).toMatch(/Klaviyo form — Close|DataGrail consent banner — Close/);
});
