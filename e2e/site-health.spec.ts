// The Site Health probe meeting a REAL BROWSER, through the real CLI.
//
// Everything below the page boundary has a laptop-speed test: the in-page
// reader against jsdom (site-health-fixture.dom.test.ts), the worker half
// against a stubbed page (check:site-health), the scorer against fixed
// readings (site-health.test.ts). What none of them can say is whether a real
// Chromium hands the init script its PerformanceObserver entries, whether a
// document id minted before the page's own code survives to the read, and
// whether the artifact lands where the runner expects it — which is the
// whole feature, end to end, and the one place it can be shown to work.
//
// Two rows: a run with the switch ON against a local page with planted
// defects, asserting the artifact, its scores and its timings; and a CONTROL
// with the switch off that must write nothing.

import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import type { AddressInfo } from "net";

import { captureFixtureSource } from "../shared/capture-fixture-source.mjs";
import { glazeRuntimeSource, GLAZE_RUNTIME_FILE } from "../shared/glaze-runtime-source.mjs";
import { healFixtureSource, HEAL_FIXTURE_FILE } from "../shared/heal-fixture-source.mjs";
import { generateSpecDetailed } from "../main/services/script-generator.js";
import { dismissFixtureSource, DISMISS_FIXTURE_FILE } from "../shared/dismiss-fixture-source.mjs";
import { userPageFixtureSource, USER_PAGE_FIXTURE_FILE } from "../shared/user-page-fixture-source.mjs";
import { tabsFixtureSource, TABS_FIXTURE_FILE } from "../shared/tabs-fixture-source.mjs";
import { siteHealthFixtureSource, SITE_HEALTH_FIXTURE_FILE } from "../shared/site-health-fixture-source.mjs";
import { settleFixtureSource, SETTLE_FIXTURE_FILE } from "../shared/settle-fixture-source.mjs";
import { signatureFixtureSource, SIGNATURE_FIXTURE_FILE } from "../shared/signature-fixture-source.mjs";
import { stepReporterSource } from "../shared/step-reporter-source.mjs";
import { playwrightConfigSource, PLAYWRIGHT_CONFIG_FILE } from "../shared/playwright-config-source.mjs";
import {
  normalizeSiteHealthArtifact,
  scoreReading,
  SITE_HEALTH_ENV,
  SITE_HEALTH_FILE,
  summariseSiteHealth,
} from "../shared/site-health.mjs";
import type { Step } from "../main/recorder/types.js";

/** A well-formed home page — every weighted audit passes — with one link the
 *  generic-text audit flags, into a cart page with three planted defects: no
 *  description, two H1s, an image without alt. */
const HOME = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Acme Store — Everything for the workshop</title>
<meta name="description" content="Acme sells tools, fixings and workshop supplies with next-day delivery across the country.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="__BASE__/">
<meta property="og:title" content="Acme Store"><meta property="og:description" content="Tools and supplies"><meta property="og:image" content="__BASE__/logo.png">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
</head><body>
<h1>Acme Store</h1>
<img src="/logo.png" alt="Acme logo" width="40" height="40">
<p>Welcome. <a href="/cart" data-testid="to-cart">click here</a> to see your cart.</p>
<p data-testid="out">home</p>
</body></html>`;

const CART = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Cart</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
<h1>Your cart</h1>
<h1>Items</h1>
<img src="/logo.png" width="40" height="40">
<p data-testid="out">cart</p>
</body></html>`;

// A 1×1 PNG, so the image request is a real resource with a transfer size.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let server: http.Server;
let base: string;
let dir: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/logo.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return;
    }
    const body = req.url?.startsWith("/cart") ? CART : HOME.replace(/__BASE__/g, base);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-site-health-"));
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

/** Home, a pause, then the cart through a real link click: two documents. */
function steps(): Step[] {
  return [
    { id: "s0", type: "goto", url: base },
    { id: "s1", type: "assert", assert: "text", locator: { k: "testid", v: "out" }, text: "home" },
    // Long enough for the home page's first paint to be observed before the
    // click leaves it — a real recording spends far longer than this on a
    // page, and the reading taken right before the click is the one kept.
    { id: "s2", type: "wait", waitMs: 1500 },
    { id: "s3", type: "click", locator: { k: "testid", v: "to-cart" } },
    { id: "s4", type: "assert", assert: "text", locator: { k: "testid", v: "out" }, text: "cart" },
  ] as Step[];
}

async function run(name: string, siteHealthOn: boolean): Promise<{ artifactDir: string; code: number | null; output: string }> {
  const { source } = generateSpecDetailed({ name, url: base, steps: steps() }, {});
  const specPath = path.join(dir, `${name}.spec.ts`);
  fs.writeFileSync(specPath, source.replace(/from\s+["']@playwright\/test["']/, 'from "./glaze-capture.mjs"'));
  const artifactDir = path.join(dir, `${name}-artifacts`);
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
      "--timeout=30000",
      "--browser=chromium",
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PW_EXPECT_TIMEOUT_MS: "5000",
        PW_OUTPUT_DIR: path.join(dir, `${name}-out`),
        GLAZE_CAPTURE_ARTIFACTS: "0",
        GLAZE_ARTIFACT_DIR: artifactDir,
        GLAZE_TEST_ID: "t-site-health",
        GLAZE_RUN_ID: name,
        [SITE_HEALTH_ENV]: siteHealthOn ? "1" : "0",
      },
    },
  );
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const code = await new Promise<number | null>((r) => child.on("close", (c) => r(c)));
  return { artifactDir, code, output };
}

test("a run with the switch on reads every document and writes a scorable artifact", async () => {
  const { artifactDir, code, output } = await run("on", true);
  expect(code, output).toBe(0);

  const file = path.join(artifactDir, SITE_HEALTH_FILE);
  expect(fs.existsSync(file), `artifact written beside the manifest (${output})`).toBe(true);
  const artifact = normalizeSiteHealthArtifact(JSON.parse(fs.readFileSync(file, "utf8")));
  expect(artifact, "the artifact passes the app's own normaliser").not.toBeNull();
  expect(artifact!.testId).toBe("t-site-health");
  expect(artifact!.runId).toBe("on");

  // Two documents — the home page and the cart — each read ONCE, whatever
  // number of reads happened (after the goto, after the settle, after the
  // click, at teardown): latest-reading-wins is keyed on the document.
  const paths = artifact!.pages.map((p) => p.path).sort();
  expect(paths).toEqual(["/", "/cart"]);
  for (const page of artifact!.pages) {
    expect(page.host).toBe("127.0.0.1");
    expect(page.engine).toBe("chromium");
    expect(page.status).toBe(200);
    expect(page.url.startsWith(base)).toBe(true);
    expect(page.id.length).toBeGreaterThan(8);
    // Real Chromium delivers the timings the init script buffered: a paint
    // and a navigation, at least. LCP and CLS come from observers the page
    // had before its own code ran — the whole point of a CONTEXT init script.
    expect(page.metrics.fcp, `${page.path} has an FCP`).not.toBeNull();
    expect(page.metrics.ttfb, `${page.path} has a TTFB`).not.toBeNull();
    expect(page.metrics.dcl, `${page.path} has a DOMContentLoaded`).not.toBeNull();
    expect(page.metrics.requests ?? 0).toBeGreaterThanOrEqual(2);
    expect(page.metrics.transferBytes ?? 0).toBeGreaterThan(0);
    expect(page.metrics.coverage).toContain("fcp");
  }
  const home = artifact!.pages.find((p) => p.path === "/")!;
  const cart = artifact!.pages.find((p) => p.path === "/cart")!;
  expect(home.cold).toBe(true);
  expect(cart.cold).toBe(false);
  expect(home.metrics.lcp, "Chromium reports LCP through the buffered observer").not.toBeNull();
  expect(home.metrics.cls, "…and CLS, which is zero on a page that does not shift").not.toBeNull();

  // The scores: the facts crossed the boundary and the SHARED scorer reads
  // them the way the app will.
  const homeScored = scoreReading(home);
  const cartScored = scoreReading(cart);
  expect(homeScored.seo).not.toBeNull();
  expect(cartScored.seo).not.toBeNull();
  expect(cartScored.seo!).toBeLessThan(homeScored.seo!);
  const failing = (s: ReturnType<typeof scoreReading>) => s.audits.filter((a) => a.status === "fail").map((a) => a.id).sort();
  expect(failing(cartScored)).toEqual(["image-alt", "meta-description"]);
  // Two H1s is a warning in the shared rule (Lighthouse's own audit only fails
  // on zero), so it is reported and never costs the score.
  expect(cartScored.audits.find((a) => a.id === "single-h1")?.status).toBe("warn");
  expect(failing(homeScored)).toEqual(["link-text"]);
  expect(homeScored.perf, "a performance score from real timings").not.toBeNull();

  const summary = summariseSiteHealth(artifact!);
  expect(summary.pages).toBe(2);
  expect(summary.hosts).toHaveLength(1);
  expect(summary.hosts[0].host).toBe("127.0.0.1");
  expect(summary.hosts[0].seo).not.toBeNull();
  expect(summary.ms).toBeGreaterThan(0);
});

test("the control: with the switch off, nothing is written and the run is untouched", async () => {
  const { artifactDir, code, output } = await run("off", false);
  expect(code, output).toBe(0);
  expect(fs.existsSync(path.join(artifactDir, SITE_HEALTH_FILE))).toBe(false);
  expect(output).not.toContain("[glaze-site-health]");
});
