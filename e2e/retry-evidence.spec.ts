// THE AUTHORITY on what a retried run leaves behind (R24a).
//
// Playwright can run one test more than once in a single invocation. The
// capture fixture is a `page` fixture, so every attempt re-enters it — and
// before R24a it re-entered with the step counter back at 0 and the same fixed
// output directory, so attempt 2 wrote its screenshots, manifest, console and
// network straight over attempt 1's.
//
// A retry only ever follows a failure, so the attempt being destroyed was
// always the one worth reading. The run then reported "passed", pointing at
// evidence of the attempt that worked.
//
// TWO QUESTIONS ONLY REAL PLAYWRIGHT CAN ANSWER, and both are modelled
// elsewhere in this repo:
//
//  • Does a retry actually re-enter the `page` fixture, with `testInfo.retry`
//    set? Everything downstream assumes it does. A unit test can only assert
//    what we believe.
//  • What does Playwright NAME a retried attempt's output directory? The
//    runner reads that name to file each salvaged trace under the attempt it
//    came from, and this repo's own note about the layout was wrong —
//    `<slug>/retryN/`, a nested directory Playwright does not produce. The
//    code now says `<slug>-retry<n>`, read out of the installed
//    `workerProcessEntry.js`; this asserts it against the real thing.
//
// Deliberately not an Electron test, for the same reason as step-progress and
// assert-parity: the subject is what real Playwright does, not a window. It
// spawns the CLI the way playwright-runner does, over the real generated spec,
// the real reporter and the real capture fixture.
//
// The laptop-speed half is `check:retry-evidence`, which executes the shipped
// fixture and reporter strings without a browser.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import {
  attemptArtifactDir,
  attemptFromPlaywrightOutputDir,
} from "../shared/attempt-artifacts.mjs";
import { captureFixtureSource } from "../shared/capture-fixture-source.mjs";
import { dismissFixtureSource, DISMISS_FIXTURE_FILE } from "../shared/dismiss-fixture-source.mjs";
import { glazeRuntimeSource, GLAZE_RUNTIME_FILE } from "../shared/glaze-runtime-source.mjs";
import { healFixtureSource, HEAL_FIXTURE_FILE } from "../shared/heal-fixture-source.mjs";
import { generateSpecDetailed } from "../main/services/script-generator.js";
import {
  playwrightConfigSource,
  PLAYWRIGHT_CONFIG_FILE,
} from "../shared/playwright-config-source.mjs";
import { settleFixtureSource, SETTLE_FIXTURE_FILE } from "../shared/settle-fixture-source.mjs";
import {
  signatureFixtureSource,
  SIGNATURE_FIXTURE_FILE,
} from "../shared/signature-fixture-source.mjs";
import { splitStepMarkers, type StepMarker } from "../shared/step-marker.mjs";
import { stepReporterSource } from "../shared/step-reporter-source.mjs";
import { userPageFixtureSource, USER_PAGE_FIXTURE_FILE } from "../shared/user-page-fixture-source.mjs";
import type { Step } from "../main/recorder/types.js";

/** The page is `not-ready` the first time it is served and `ready` after that,
 *  so one assertion fails on the first attempt and passes on the retry. That
 *  is the shape this whole feature is about: a run that goes green while
 *  having gone red, whose only record of the red is what the first attempt
 *  wrote. */
const page = (text: string) => `<!doctype html>
<html><head><title>Retry | Acme</title></head>
<body>
  <button data-testid="go">Click me</button>
  <p data-testid="out">${text}</p>
</body></html>`;

let server: http.Server;
let base: string;
let dir: string;
let pageLoads = 0;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    // Only the document counts. A favicon or any other incidental request must
    // not consume the one "first load" this fixture has.
    if (req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    pageLoads += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(pageLoads === 1 ? "not-ready" : "ready"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  // The scripts dir the app writes at run time, reproduced exactly.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-retry-evidence-"));
  fs.writeFileSync(path.join(dir, PLAYWRIGHT_CONFIG_FILE), playwrightConfigSource);
  fs.writeFileSync(path.join(dir, "step-reporter.mjs"), stepReporterSource);
  fs.writeFileSync(path.join(dir, "glaze-capture.mjs"), captureFixtureSource);
  fs.writeFileSync(path.join(dir, HEAL_FIXTURE_FILE), healFixtureSource);
  fs.writeFileSync(path.join(dir, SETTLE_FIXTURE_FILE), settleFixtureSource);
  fs.writeFileSync(path.join(dir, SIGNATURE_FIXTURE_FILE), signatureFixtureSource);
  fs.writeFileSync(path.join(dir, DISMISS_FIXTURE_FILE), dismissFixtureSource);
  fs.writeFileSync(path.join(dir, USER_PAGE_FIXTURE_FILE), userPageFixtureSource);
  fs.writeFileSync(path.join(dir, GLAZE_RUNTIME_FILE), glazeRuntimeSource);
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(dir, "node_modules"));
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Manifest {
  attempt?: number;
  status?: string;
  shotCount?: number;
  steps?: unknown[];
}

const readManifest = (at: string): Manifest | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(at, "manifest.json"), "utf-8")) as Manifest;
  } catch {
    return null;
  }
};

test("a retried run leaves both attempts' evidence, and names each one", async () => {
  const steps: Step[] = [
    { id: "s0", type: "goto", url: base },
    { id: "s1", type: "click", locator: { k: "testid", v: "go" } },
    { id: "s2", type: "assert", assert: "text", locator: { k: "testid", v: "out" }, text: "ready" },
  ] as Step[];

  const { source, lineMap } = generateSpecDetailed({ name: "retry", url: base, steps }, {});
  const specPath = path.join(dir, "retry.spec.ts");
  fs.writeFileSync(
    specPath,
    source.replace(/from\s+["']@playwright\/test["']/, 'from "./glaze-capture.mjs"'),
  );

  const artifactDir = path.join(dir, "retry-artifacts");
  const outputDir = path.join(dir, "retry-out");
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
      "--timeout=20000",
      "--browser=chromium",
      // The whole point. Nothing in the app turns retries on yet (that is R24);
      // the evidence layer has to be right before it does, because an attempt's
      // artifacts are written once or never.
      "--retries=1",
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PW_EXPECT_TIMEOUT_MS: "2000",
        PW_OUTPUT_DIR: outputDir,
        GLAZE_CAPTURE_ARTIFACTS: "1",
        GLAZE_ARTIFACT_DIR: artifactDir,
        GLAZE_TEST_ID: "t-retry",
        GLAZE_RUN_ID: "retry",
      },
    },
  );

  const markers: StepMarker[] = [];
  let buffered = "";
  child.stdout.on("data", (d: Buffer) => {
    const split = splitStepMarkers(buffered, d.toString());
    buffered = split.rest;
    markers.push(...split.markers);
  });
  const exitCode = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));

  // The premise. If this run did not fail and then pass, nothing below means
  // what it says — so it is asserted rather than assumed.
  expect(exitCode, "the run passes overall, on its second attempt").toBe(0);
  expect(pageLoads, "the page was served to two attempts").toBeGreaterThanOrEqual(2);

  // ── 1. Two attempts, two sets of evidence ───────────────────────────────
  const first = readManifest(attemptArtifactDir(artifactDir, 0));
  const second = readManifest(attemptArtifactDir(artifactDir, 1));

  expect(first, "the first attempt wrote a manifest").not.toBeNull();
  expect(
    second,
    "the retry wrote its own manifest instead of overwriting the first",
  ).not.toBeNull();

  expect(first!.attempt, "the first attempt says which attempt it was").toBe(0);
  expect(second!.attempt, "and so does the retry").toBe(1);

  // The bug, stated as itself: the FAILING attempt is the one that used to be
  // destroyed, and it is the only one anybody wants.
  expect(first!.status, "the first attempt's evidence records that it failed").toBe("failed");
  expect(second!.status, "the retry's records that it passed").toBe("passed");

  // ── 2. …in different directories ────────────────────────────────────────
  expect(attemptArtifactDir(artifactDir, 1)).not.toBe(attemptArtifactDir(artifactDir, 0));
  expect(
    fs.existsSync(path.join(attemptArtifactDir(artifactDir, 1), "manifest.json")),
    "the retry's manifest is beneath the run directory, not beside it",
  ).toBe(true);

  // ── 3. The marker stream says which attempt each step belonged to ───────
  const attempts = new Set(markers.map((m) => m.attempt));
  expect(
    [...attempts].sort(),
    "steps are reported under both attempts, not folded into one",
  ).toEqual([0, 1]);
  // The assertion that failed the first time is step 2, and it must be
  // reported as failed under attempt 0 and passed under attempt 1 — the exact
  // pair a flat map collapses to "passed".
  const at = (attempt: number, ok: boolean) =>
    markers.some(
      (m) => m.attempt === attempt && m.event === "end" && m.ok === ok && lineMap[m.line] === 2,
    );
  expect(at(0, false), "the assertion is reported failed under attempt 0").toBe(true);
  expect(at(1, true), "and passed under attempt 1").toBe(true);

  // ── 4. Playwright's own directory naming, checked against Playwright ────
  //
  // The runner derives a salvaged trace's attempt from this name. A wrong
  // model files every retry's trace under attempt 0, where it overwrites — or
  // is refused by — the one the app opens.
  const scratch = fs.readdirSync(outputDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const named = new Map(scratch.map((e) => [attemptFromPlaywrightOutputDir(e.name), e.name]));
  expect(
    [...named.keys()].sort(),
    `attempt 0 and attempt 1 each get a scratch directory (saw ${scratch.map((e) => e.name).join(", ")})`,
  ).toEqual([0, 1]);
});
