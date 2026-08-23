// THE AUTHORITY on which steps a run reports, and therefore which step the app
// can highlight.
//
// The app tells the user where a run is, and where it failed, from one stream:
// `__GLAZE_STEP__:` lines on the Playwright process's stdout. Two writers
// produce them and NEITHER can be exercised anywhere else — the reporter only
// exists as a string written next to the specs at run time and loaded by the
// Playwright CLI, and the capture fixture's wrapper only exists inside a
// Playwright worker. A model of which category Playwright files a call under is
// not evidence; the whole bug this file was written against was a wrong model.
//
// WHAT WAS WRONG, and what each mode below pins:
//
//  • Assertions are category `expect`, not `pw:api`. The reporter skipped them
//    as "noise", so a failing assertion — the commonest way a recorded test
//    fails — was reported by nothing. The step list highlighted nothing and the
//    replay wrote `failedIndex: null` (28 of 110 failed runs on the author's
//    machine, checked on disk).
//  • On any run with capture, Auto-Heal or crawl on, the fixtures wrap the
//    action methods, so Playwright attributes each action's location to the
//    FIXTURE file and the reporter's file guard drops it. Together with the
//    above that is a run which reports NOT ONE STEP: the progress bar sits on
//    "Step 1 of N" from start to finish, however well the test does.
//
// Deliberately NOT an Electron test, for the same reason as assert-parity: the
// subject is what real Playwright reports, not a window. It spawns the CLI the
// way playwright-runner does, over the real generated spec, the real reporter
// and the real fixtures, and reads the result back through the runner's own
// splitter.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { captureFixtureSource } from "../main/services/capture-fixture-source.js";
import { glazeRuntimeSource, GLAZE_RUNTIME_FILE } from "../main/services/glaze-runtime-source.js";
import { healFixtureSource, HEAL_FIXTURE_FILE } from "../main/services/heal-fixture-source.js";
import { generateSpecDetailed, type FlowSource } from "../main/services/script-generator.js";
import { dismissFixtureSource, DISMISS_FIXTURE_FILE } from "../main/services/dismiss-fixture-source.js";
import { userPageFixtureSource, USER_PAGE_FIXTURE_FILE } from "../main/services/user-page-fixture-source.js";
import { settleFixtureSource, SETTLE_FIXTURE_FILE } from "../main/services/settle-fixture-source.js";
import {
  signatureFixtureSource,
  SIGNATURE_FIXTURE_FILE,
} from "../main/services/signature-fixture-source.js";
import { splitStepMarkers, type StepMarker } from "../main/services/step-marker.js";
import { stepReporterSource } from "../main/services/step-reporter-source.js";
import { playwrightConfigSource, PLAYWRIGHT_CONFIG_FILE } from "../shared/playwright-config-source.mjs";
import type { Step } from "../main/recorder/types.js";

const FIXTURE = `<!doctype html>
<html><head><title>Progress | Acme</title></head>
<body>
  <button data-testid="go">Click me</button>
  <input data-testid="name" placeholder="Name" />
  <p data-testid="out">idle</p>
  <script>
    document.querySelector('[data-testid="go"]').addEventListener('click', () => {
      document.querySelector('[data-testid="out"]').textContent = 'clicked';
    });
  </script>
</body></html>`;

let server: http.Server;
let base: string;
let dir: string;

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The scripts dir the app writes at run time, reproduced exactly: same config,
  // same reporter, same fixtures, all from the sources that ship.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-step-progress-"));
  fs.writeFileSync(path.join(dir, PLAYWRIGHT_CONFIG_FILE), playwrightConfigSource);
  fs.writeFileSync(path.join(dir, "step-reporter.mjs"), stepReporterSource);
  fs.writeFileSync(path.join(dir, "glaze-capture.mjs"), captureFixtureSource);
  fs.writeFileSync(path.join(dir, HEAL_FIXTURE_FILE), healFixtureSource);
  fs.writeFileSync(path.join(dir, SETTLE_FIXTURE_FILE), settleFixtureSource);
  fs.writeFileSync(path.join(dir, SIGNATURE_FIXTURE_FILE), signatureFixtureSource);
  fs.writeFileSync(path.join(dir, DISMISS_FIXTURE_FILE), dismissFixtureSource);
  fs.writeFileSync(path.join(dir, USER_PAGE_FIXTURE_FILE), userPageFixtureSource);
  fs.writeFileSync(path.join(dir, GLAZE_RUNTIME_FILE), glazeRuntimeSource);
  // Same trick the runner uses for the temp scripts dir: a link is enough for
  // Node's resolver, which is all the CLI and the fixtures need.
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(dir, "node_modules"));
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The steps a recorder produces: page calls AND assertions, with one assertion
 *  set up to fail. Both kinds matter — they travel by different routes. */
function steps(failingText: string): Step[] {
  return [
    { id: "s0", type: "goto", url: base },
    { id: "s1", type: "click", locator: { k: "testid", v: "go" } },
    { id: "s2", type: "fill", locator: { k: "testid", v: "name" }, value: "chris" },
    { id: "s3", type: "assert", assert: "text", locator: { k: "testid", v: "out" }, text: "clicked" },
    { id: "s4", type: "assert", assert: "text", locator: { k: "testid", v: "out" }, text: failingText },
    { id: "s5", type: "click", locator: { k: "testid", v: "go" } },
  ] as Step[];
}

interface RunResult {
  /** step index → the transitions reported for it, in order. */
  reported: Map<number, StepMarker[]>;
  /** What the user would have seen in the Output panel. */
  visible: string;
}

/**
 * Run one spec through the real CLI and read the marker stream back.
 *
 * `capture` decides whether the spec's `@playwright/test` import is redirected
 * to the fixture — the same one-line rewrite `prepareCaptureSpec` does, which is
 * what puts the action wrapper in the call path.
 */
async function run(
  name: string,
  spec: Step[],
  capture: boolean,
  /** The whole test's budget. A step that is MEANT not to resolve has no
   *  timeout of its own — an action waits until the test's runs out — so a row
   *  built around one sets this rather than spending the default. */
  timeoutMs = 20_000,
  resolveFlow?: (flowId: string) => FlowSource | null,
): Promise<RunResult> {
  const { source, lineMap } = generateSpecDetailed(
    { name, url: base, steps: spec },
    resolveFlow ? { resolveFlow } : {},
  );
  const specPath = path.join(dir, `${name}.spec.ts`);
  fs.writeFileSync(
    specPath,
    capture ? source.replace(/from\s+["']@playwright\/test["']/, 'from "./glaze-capture.mjs"') : source,
  );

  const artifactDir = path.join(dir, `${name}-artifacts`);
  const args = [
    path.join(process.cwd(), "node_modules", "@playwright", "test", "cli.js"),
    "test",
    specPath,
    "--config",
    path.join(dir, PLAYWRIGHT_CONFIG_FILE),
    "--reporter",
    `${path.join(dir, "step-reporter.mjs")},line`,
    "--workers=1",
    `--timeout=${timeoutMs}`,
    "--browser=chromium",
  ];
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: {
      ...process.env,
      PW_EXPECT_TIMEOUT_MS: "2000",
      PW_OUTPUT_DIR: path.join(dir, `${name}-out`),
      GLAZE_CAPTURE_ARTIFACTS: capture ? "1" : "0",
      GLAZE_ARTIFACT_DIR: capture ? artifactDir : "",
      GLAZE_TEST_ID: "t-progress",
      GLAZE_RUN_ID: name,
    },
  });

  const reported = new Map<number, StepMarker[]>();
  let buffered = "";
  let visible = "";
  child.stdout.on("data", (d: Buffer) => {
    const split = splitStepMarkers(buffered, d.toString());
    buffered = split.rest;
    visible += split.visible;
    for (const marker of split.markers) {
      const index = lineMap[marker.line];
      if (index === undefined) continue;
      const list = reported.get(index) ?? [];
      list.push(marker);
      reported.set(index, list);
    }
  });
  await new Promise<void>((r) => child.on("close", () => r()));
  return { reported, visible };
}

for (const capture of [false, true]) {
  const mode = capture ? "a capture run" : "a plain run";

  test(`${mode} reports every step, and reports the failing one as failed`, async () => {
    const result = await run(capture ? "cap" : "plain", steps("NOT-ON-THE-PAGE"), capture);

    // Steps 0-4 all execute. Step 5 is after the failure, so Playwright never
    // runs it and nothing should claim it did.
    const silent = [0, 1, 2, 3, 4].filter((i) => !result.reported.has(i));
    expect(
      silent,
      "every executed step reports — a silent one is a step the app cannot highlight",
    ).toEqual([]);

    for (const index of [0, 1, 2, 3, 4]) {
      const events = result.reported.get(index)!.map((m) => m.event);
      expect(events, `step ${index} opens and closes exactly once`).toEqual(["begin", "end"]);
    }

    // The point of the whole feature: the step the user has to be shown.
    const failed = [...result.reported.entries()]
      .filter(([, markers]) => markers.some((m) => m.event === "end" && !m.ok))
      .map(([index]) => index);
    expect(failed, "the failing assertion is the step reported as failed").toEqual([4]);

    for (const index of [0, 1, 2, 3]) {
      const end = result.reported.get(index)!.find((m) => m.event === "end")!;
      expect(end.ok, `step ${index} passed and is reported as passing`).toBe(true);
    }
    expect(result.reported.has(5), "a step that never ran reports nothing").toBe(false);

    // The markers are an implementation detail of the app, not something to
    // print at somebody.
    expect(result.visible).not.toContain("__GLAZE_STEP__");
  });

  test(`${mode} reports a passing run all the way to the last step`, async () => {
    // The second half of the reported bug: the progress bar never moved off the
    // first step EVEN WHEN THE TEST PASSED. Nothing about a pass is special —
    // it was simply that no step reported at all.
    const result = await run(capture ? "cap-pass" : "plain-pass", steps("clicked"), capture);

    for (const index of [0, 1, 2, 3, 4, 5]) {
      const markers = result.reported.get(index);
      expect(markers?.map((m) => m.event), `step ${index} of a passing run reports`).toEqual([
        "begin",
        "end",
      ]);
      expect(markers!.find((m) => m.event === "end")!.ok).toBe(true);
    }
  });
}

test("a repeated flow call reports each iteration against the visible call row", async () => {
  // The loop emitter wraps the inlined block in a real `for`, so the same spec
  // LINES execute N times. The line map attributes those lines to the runFlow
  // row the user can see — which means the row must report begin/end once per
  // iteration, and nothing may report against an index that does not exist in
  // the caller's step list. A wrong shape here is the progress bar sticking or
  // skipping while a loop runs.
  const flow: FlowSource = {
    id: "f-loop",
    name: "Poke",
    flowParams: [],
    steps: [{ id: "fl1", type: "click", locator: { k: "testid", v: "go" }, timestamp: 0 } as Step],
  };
  const spec = [
    { id: "s0", type: "goto", url: base },
    { id: "s1", type: "runFlow", flowId: "f-loop", label: "Poke", repeat: 3 },
    { id: "s2", type: "assert", assert: "text", locator: { k: "testid", v: "out" }, text: "clicked" },
  ] as Step[];
  const result = await run("looped", spec, false, 20_000, (id) =>
    id === "f-loop" ? flow : null,
  );

  const callRow = result.reported.get(1);
  expect(callRow, "the call row reports").toBeTruthy();
  const events = callRow!.map((m) => m.event);
  expect(events, "one begin/end pair per iteration").toEqual([
    "begin", "end", "begin", "end", "begin", "end",
  ]);
  expect(callRow!.filter((m) => m.event === "end").every((m) => m.ok)).toBe(true);
  // The assertion after the loop still lands on its own row.
  expect(result.reported.get(2)?.map((m) => m.event)).toEqual(["begin", "end"]);
  // And nothing reported against an index the caller's list does not have.
  for (const index of result.reported.keys()) {
    expect(index).toBeLessThanOrEqual(2);
  }
});

test("a failing action, not an assertion, is reported as the failing step", async () => {
  // The other half of "which step failed": an action that throws. It travels by
  // the fixture's wrapper rather than the reporter, so its failure path is a
  // different piece of code from the assertion's.
  const spec = [
    { id: "s0", type: "goto", url: base },
    { id: "s1", type: "click", locator: { k: "testid", v: "go" } },
    { id: "s2", type: "click", locator: { k: "testid", v: "not-here" } },
    { id: "s3", type: "assert", assert: "text", locator: { k: "testid", v: "out" }, text: "clicked" },
  ] as Step[];
  const result = await run("badaction", spec, true, 6_000);

  const failed = [...result.reported.entries()]
    .filter(([, markers]) => markers.some((m) => m.event === "end" && !m.ok))
    .map(([index]) => index);
  expect(failed, "the click that could not resolve is the step reported as failed").toEqual([2]);
  expect(result.reported.has(3), "the step after the failure never ran").toBe(false);
});
