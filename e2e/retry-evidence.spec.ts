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
// THREE QUESTIONS ONLY REAL PLAYWRIGHT CAN ANSWER, each modelled elsewhere in
// this repo and each load-bearing:
//
//  • Does a retry actually re-enter the `page` fixture with `testInfo.retry`
//    set? Everything downstream assumes it does. A unit test can only assert
//    what we believe.
//  • Does `retain-on-failure` keep the FAILING attempt's trace when the run as
//    a whole exits 0? That is the entire premise of moving the runner's
//    salvage gate off the exit code.
//  • What does Playwright NAME a retried attempt's output directory? The
//    runner reads that name to file each salvaged trace under the attempt it
//    came from, and this repo's own note about the layout was wrong — it
//    described a `retryN/` directory NESTED inside the test's own, which
//    Playwright does not produce. The code now reads a `-retry<n>` SUFFIX, out
//    of the installed `workerProcessEntry.js`; this asserts it against the
//    real thing.
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
import { retryFields } from "../shared/run-attempts.mjs";
import { splitStepMarkers, type StepMarker } from "../shared/step-marker.mjs";
import { stepReporterSource } from "../shared/step-reporter-source.mjs";
import { userPageFixtureSource, USER_PAGE_FIXTURE_FILE } from "../shared/user-page-fixture-source.mjs";
import type { Step } from "../main/recorder/types.js";

const pageHtml = (text: string) => `<!doctype html>
<html><head><title>Retry | Acme</title></head>
<body>
  <button data-testid="go">Click me</button>
  <p data-testid="out">${text}</p>
</body></html>`;

/**
 * `flip` serves `pending` once and `ready` after that, so the test fails on
 * its first attempt and passes on the retry. `stuck` never becomes ready, so
 * both attempts fail.
 *
 * The two words are DISJOINT on purpose. An `assert: "text"` step emits
 * `toContainText`, a SUBSTRING match — the first draft of this file served
 * `not-ready`, which contains `ready`, so the assertion passed on the first
 * attempt, no retry ever happened, and the whole test measured nothing. The
 * `loads` assertion below is what caught it, and is why each test states its
 * premise rather than assuming it.
 */
let mode: "flip" | "stuck" = "flip";
let loads = 0;

let server: http.Server;
let base: string;
let dir: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    // Only the document counts. A favicon or any other incidental request must
    // not consume the one "first load" this fixture has.
    if (req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    loads += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageHtml(mode === "stuck" || loads === 1 ? "pending" : "ready"));
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

interface RunResult {
  exitCode: number;
  markers: StepMarker[];
  /** line → step index, for reading a marker back as a step. */
  lineMap: Record<number, number>;
  artifactDir: string;
  outputDir: string;
  loads: number;
}

/** Run the three-step spec through the real CLI with one retry allowed. */
async function run(name: string, serverMode: "flip" | "stuck"): Promise<RunResult> {
  mode = serverMode;
  loads = 0;

  const steps: Step[] = [
    { id: "s0", type: "goto", url: base },
    { id: "s1", type: "click", locator: { k: "testid", v: "go" } },
    { id: "s2", type: "assert", assert: "text", locator: { k: "testid", v: "out" }, text: "ready" },
  ] as Step[];

  const { source, lineMap } = generateSpecDetailed({ name, url: base, steps }, {});
  const specPath = path.join(dir, `${name}.spec.ts`);
  fs.writeFileSync(
    specPath,
    source.replace(/from\s+["']@playwright\/test["']/, 'from "./glaze-capture.mjs"'),
  );

  const artifactDir = path.join(dir, `${name}-artifacts`);
  const outputDir = path.join(dir, `${name}-out`);
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
        GLAZE_RUN_ID: name,
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
  return { exitCode, markers, lineMap, artifactDir, outputDir, loads };
}

/** Every `trace.zip` under a scratch dir, with the attempt its directory names
 *  — the same walk `findTraceZips` does in the runner, which cannot be
 *  imported here (it pulls in `@shell/backend`). */
function tracesByAttempt(root: string): Map<number, string> {
  const found = new Map<number, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const zip = path.join(root, e.name, "trace.zip");
    if (fs.existsSync(zip)) found.set(attemptFromPlaywrightOutputDir(e.name), zip);
  }
  return found;
}

test("a retried run leaves both attempts' evidence, and each says which it is", async () => {
  const result = await run("flip", "flip");

  // The premise. If this run did not fail and then pass, nothing below means
  // what it says.
  expect(result.exitCode, "the run passes overall, on its second attempt").toBe(0);
  expect(
    result.loads,
    "the page was served to two attempts — one load means the first attempt PASSED and there was no retry to measure",
  ).toBeGreaterThanOrEqual(2);

  // ── 1. Two attempts, two sets of evidence ───────────────────────────────
  const first = readManifest(attemptArtifactDir(result.artifactDir, 0));
  const second = readManifest(attemptArtifactDir(result.artifactDir, 1));

  expect(first, "the first attempt wrote a manifest").not.toBeNull();
  expect(second, "the retry wrote its own instead of overwriting the first").not.toBeNull();

  expect(first!.attempt, "the first attempt says which attempt it was").toBe(0);
  expect(second!.attempt, "and so does the retry").toBe(1);

  // The bug, stated as itself: the FAILING attempt is the one that used to be
  // destroyed, and it is the only one anybody wants.
  expect(first!.status, "the first attempt's evidence records that it failed").toBe("failed");
  expect(second!.status, "the retry's records that it passed").toBe("passed");

  // ── 2. …in different directories ────────────────────────────────────────
  expect(attemptArtifactDir(result.artifactDir, 1)).not.toBe(
    attemptArtifactDir(result.artifactDir, 0),
  );
  expect(
    fs.existsSync(path.join(attemptArtifactDir(result.artifactDir, 1), "manifest.json")),
    "the retry's manifest is beneath the run directory, not beside it",
  ).toBe(true);

  // ── 3. The marker stream says which attempt each step belonged to ───────
  expect(
    [...new Set(result.markers.map((m) => m.attempt))].sort(),
    "steps are reported under both attempts, not folded into one",
  ).toEqual([0, 1]);
  // The assertion that failed the first time is step 2. It must be reported
  // failed under attempt 0 and passed under attempt 1 — the exact pair a flat
  // status map collapses to "passed".
  const reported = (attempt: number, ok: boolean) =>
    result.markers.some(
      (m) =>
        m.attempt === attempt && m.event === "end" && m.ok === ok && result.lineMap[m.line] === 2,
    );
  expect(reported(0, false), "the assertion is reported failed under attempt 0").toBe(true);
  expect(reported(1, true), "and passed under attempt 1").toBe(true);

  // ── 4. The marker stream is enough to MARK THE RECORD (R24) ────────────
  //
  // Both runners derive `attempt` and `passedOnRetry` from exactly this stream
  // — no Playwright summary line is parsed anywhere. So the honest test of
  // that derivation is to run it over markers real Playwright produced, which
  // is the one thing a unit test cannot supply.
  const maxAttempt = result.markers.reduce((n, m) => Math.max(n, m.attempt), 0);
  expect(maxAttempt, "the stream carries a second attempt").toBe(1);
  expect(
    retryFields({ status: "passed", maxAttempt }),
    "a real retried run marks the record as a recovery",
  ).toEqual({ attempt: 1, passedOnRetry: true });

  // ── 5. The failing attempt's trace survives a run that exits 0 ──────────
  //
  // The whole reason the runner's salvage gate moved off the exit code. If
  // `retain-on-failure` did not keep this, there would be nothing to salvage
  // and the old gate would have been harmless.
  expect(
    tracesByAttempt(result.outputDir).has(0),
    "the failing attempt's trace is on disk even though the run exited 0",
  ).toBe(true);
});

test("Playwright names a retried attempt's directory with a -retry suffix", async () => {
  // Both attempts fail here, so `retain-on-failure` keeps BOTH traces and both
  // scratch directories exist to be named. (In the flip case above the passing
  // retry's trace is discarded, so there is nothing to read its name from.)
  const result = await run("stuck", "stuck");

  expect(result.exitCode, "both attempts failed, so the run fails").not.toBe(0);
  expect(result.loads, "the page was served to two attempts").toBeGreaterThanOrEqual(2);

  const traces = tracesByAttempt(result.outputDir);
  const names = fs
    .readdirSync(result.outputDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  expect(
    [...traces.keys()].sort(),
    `each attempt's trace is filed under its own attempt (scratch dirs: ${names.join(", ")})`,
  ).toEqual([0, 1]);

  // Stated positively too, so a failure names the thing that changed rather
  // than only the consequence.
  expect(
    names.some((n) => /-retry1$/.test(n)),
    `a retried attempt's directory carries a "-retry" SUFFIX, not a nested retryN/ directory (saw: ${names.join(", ")})`,
  ).toBe(true);
});
