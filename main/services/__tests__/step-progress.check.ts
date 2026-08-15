// The wiring that highlights the step a run is on — pinned at source.
//
//   npm run check:step-progress
//
// ── Why a source-level check ───────────────────────────────────────────────
// Progress is reported by two writers that never meet in a unit test: a
// Playwright reporter that only exists as a string written to disk at run time,
// and the capture fixture's action wrapper, which only exists inside a
// Playwright worker. Both were silently wrong for weeks, in a way nothing on
// screen said out loud — the step list simply never lit up, and a failed run
// named no step at all.
//
// The properties below have no visible symptom when they break:
//
//  • Report only `pw:api` and every ASSERTION is dropped, because Playwright
//    files an assertion under the `expect` category. An assertion is the
//    commonest way a recorded test fails, so the failing step was reported by
//    nothing, the step list highlighted nothing, and the replay wrote
//    `failedIndex: null`.
//  • Leave the announcement out of the capture fixture's wrapper and a run with
//    capture, Auto-Heal or crawl on reports NOTHING for any action: Playwright
//    attributes a wrapped call's location to the wrapper's file, and the
//    reporter's file guard drops it. That is a run where the progress bar never
//    leaves the first step, however well the test does.
//  • Gate that wrapper's install on capture being on and heal-only and
//    crawl-only runs go dark again for exactly the same reason.
//  • Spell the marker prefix twice and the copies drift: the writer's line is
//    printed to the user as junk and reports nothing.
//
// The end-to-end proof lives in e2e/step-progress.spec.ts, which runs real
// Playwright over the real fixture and is not part of the local gate. This is
// what fails on a laptop, in a second.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { captureFixtureSource } from "../capture-fixture-source.js";
import { LOCATOR_ACTIONS, PAGE_ACTIONS } from "../page-actions.js";
import { splitStepMarkers, STEP_MARKER } from "../step-marker.js";
import { stepReporterSource } from "../step-reporter-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", "..", rel), "utf8");

let failures = 0;
function assert(ok: boolean, label: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

const reporterTs = read("services/step-reporter.ts");
const runner = read("services/playwright-runner.ts");

// ── 1. Both categories a generated spec produces are reported ──────────────
// Stated against BOTH copies of the reporter. `step-reporter.ts` is the typed
// reference and `stepReporterSource` is what actually runs, kept in step by
// hand — so "the fix landed in the one nobody executes" is a real way for this
// to come back.
//
// Pinned as the whole guard expression, not as the presence of the word
// "expect": both files EXPLAIN in a comment why assertions are reported, so a
// check for the word alone passes against a reporter that has stopped reporting
// them — which is the shape of vacuous assertion this bug already survived once.
const CATEGORY_GUARD = 'step.category !== "pw:api" && step.category !== "expect"';
for (const [name, src] of [
  ["step-reporter.ts", reporterTs],
  ["stepReporterSource", stepReporterSource],
] as const) {
  assert(
    src.includes(CATEGORY_GUARD),
    `${name} reports pw:api AND expect steps — the calls and the assertions`,
  );
  // The guard that keeps a fixture-located step from being read as a spec line.
  assert(
    src.includes("location.file !== test.location.file"),
    `${name} still drops a step located outside the spec`,
  );
}

// ── 2. The fixture announces the actions the reporter cannot see ───────────
{
  assert(
    captureFixtureSource.includes(STEP_MARKER),
    "the capture fixture writes the shared marker prefix",
  );
  // Inside the wrapper, on both sides of the call: a `begin` with no `end` is a
  // step stuck on "running" forever, and an `end` with no `begin` never lights.
  assert(
    /emitStepMarker\(\{ event: "begin"/.test(captureFixtureSource),
    "the wrapper announces the step before the action",
  );
  assert(
    /emitStepMarker\(\{ event: "end", line: line, title: method, ok: true/.test(
      captureFixtureSource,
    ),
    "the wrapper closes the step when the action resolves",
  );
  // The one that matters most: without it the step that FAILED is the only step
  // in the run with no outcome, which is the bug this whole file is about.
  assert(
    /catch \(err\) \{[\s\S]{0,400}?emitStepMarker\(\{ event: "end"[^}]*ok: false[\s\S]{0,120}?throw err/.test(
      captureFixtureSource,
    ),
    "the wrapper reports the failure before rethrowing it",
  );
  // Unconditional: heal-only and crawl-only runs wrap the same methods, so they
  // need the announcement just as much as a capturing run does.
  assert(
    /specFile = testInfo\.file[\s\S]{0,80}?patchOnce\(page\)/.test(captureFixtureSource),
    "the action patch is installed for every run that loads the fixture",
  );
  assert(
    !/if \((ON \|\| A11Y_ON|A11Y_ON \|\| ON)\) patchOnce/.test(captureFixtureSource),
    "the action patch is no longer gated on screenshots being on",
  );
  // It resolves the spec line by searching the stack, not by taking one frame,
  // so a future patch nesting on either side of it does not silently go dark.
  assert(
    captureFixtureSource.includes("for (const frame of stack.split("),
    "the spec line is found by searching the whole stack",
  );
}

// ── 3. Every wrapped method is a method the fixture can announce ────────────
// The two lists are the set the reporter is guaranteed NOT to see, because
// wrapping them is what moves their location off the spec.
for (const method of [...PAGE_ACTIONS, ...LOCATOR_ACTIONS]) {
  assert(
    captureFixtureSource.includes(`"${method}"`),
    `${method} is in the patched set the fixture announces`,
  );
}

// ── 4. One spelling of the marker, and the runner strips it either way ─────
{
  // Read from DISK, not from the exported strings: the generated sources are
  // SUPPOSED to contain the prefix — they interpolate it — and what is being
  // guarded is a second hand-typed spelling in a source file. `step-marker.ts`
  // is where it is allowed to be spelled, and is not in the list.
  //
  // Quote characters only, so a backtick in prose ("prints a raw ... line")
  // does not read as a transcription.
  const transcribed = new RegExp(`["']${STEP_MARKER}`);
  const writers = [
    "services/capture-fixture-source.ts",
    "services/step-reporter-source.ts",
    "services/step-reporter.ts",
    "services/playwright-runner.ts",
  ];
  for (const rel of writers) {
    assert(!transcribed.test(read(rel)), `${rel} imports the marker prefix rather than typing it`);
  }
  assert(
    runner.includes("splitStepMarkers"),
    "the runner parses stdout through the shared splitter",
  );
}

// ── 5. The map outlives a browser install ──────────────────────────────────
// `runCli` is also how a missing engine is downloaded, under the SAME runId. It
// used to delete the line map when that call closed, so the first run on any new
// browser highlighted nothing — a bug that reproduces once per engine per
// machine and then hides.
{
  const close = runner.slice(runner.indexOf('child.on("close"'), runner.indexOf("export const playwrightRunner"));
  assert(
    !close.includes("stepLineMaps.delete"),
    "a finished Playwright process does not drop the line map",
  );
  assert(
    runner.includes("stepLineMaps.delete(runId)"),
    "the run's own teardown drops the line map",
  );
}

// ── 6. End to end over the real writers ────────────────────────────────────
// Not a mock: the marker the fixture's own emitter produces, read back by the
// runner's own splitter, through the prefix the `line` reporter really leaves in
// front of a worker's output.
{
  const line = STEP_MARKER + JSON.stringify({ event: "end", line: 7, title: "click", ok: false });
  const { visible, markers } = splitStepMarkers("", "[1A[2K" + line + "\n");
  assert(
    markers.length === 1 && markers[0].line === 7 && markers[0].ok === false,
    "a failed action written from a worker is read back as a failed step",
  );
  assert(!visible.includes("__GLAZE_STEP__"), "and never reaches the user's output");
}

console.log(failures === 0 ? "\nAll step-progress checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
