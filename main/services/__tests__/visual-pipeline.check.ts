// End-to-end regression check for the whole visual-testing pipeline (the
// contract Phases 0–4 built toward), exercised in ONE contiguous path against
// a real temp filesystem — no Playwright, no browser, deterministic.
//
// It drives the REAL modules (buildReplay/enrichWithVisualDiffs, artifactStore,
// baselineStore, visual-baseline-ops, annotationStore, visual-diff); only
// `@glaze/core/backend` is aliased to a test stub (see glaze-backend-stub.ts)
// so `app.getPath("userData")` points at a throwaway dir. Same convention as
// spec-parser.check.ts: plain assertions + a non-zero exit on failure.
//
// Run (bundle with the alias, then node — tsx/plain node can't resolve
// @glaze/core/backend, and esbuild+node needs no listen socket so it's
// sandbox-safe):
//   npm run check:visual-pipeline

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { PNG } from "pngjs";

import { artifactStore } from "../artifact-store.js";
import type { ArtifactManifest, ReplayStepStatus } from "../artifact-store.js";
import { baselineStore } from "../baseline-store.js";
import { buildReplay, enrichWithA11y, enrichWithVisualDiffs } from "../replay-builder.js";
import type { A11yViolation } from "../a11y-diff.js";
import { acceptRunBaseline, acceptStepBaseline } from "../visual-baseline-ops.js";
import { acceptRunA11y, acceptStepA11y, resetA11yBaseline } from "../a11y-baseline-ops.js";
import { testStore } from "../test-store.js";
import { annotationStore } from "../annotation-store.js";
import { compareRuns } from "../run-comparison.js";
import { DEFAULT_VISUAL_THRESHOLD } from "../../recorder/types.js";
import type { Step, VisualMask } from "../../recorder/types.js";

// ── temp userData (must be set BEFORE the stores resolve paths) ────────────
// The stub reads GLAZE_TEST_USERDATA at import; the check's runner sets it,
// but default here too so a direct invocation still isolates to a fresh dir.
const DATA_ROOT =
  process.env.GLAZE_TEST_USERDATA ??
  fs.mkdtempSync(path.join(os.tmpdir(), "glaze-visual-e2e-"));
process.env.GLAZE_TEST_USERDATA = DATA_ROOT;

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.error(`FAIL ${label}`);
  }
}
function eq<T>(actual: T, expected: T, label: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

// A deterministic solid-color PNG (equal dims so diffs are pixel-driven,
// never size-mismatch "unable").
function solidPng(r: number, g: number, b: number, w = 24, h = 24): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

const RED = solidPng(220, 40, 40);
const RED_AGAIN = solidPng(220, 40, 40); // identical to RED → should "match"
const BLUE = solidPng(40, 60, 220); // wholly different → should be "changed"

const testId = randomUUID();
const threshold = DEFAULT_VISUAL_THRESHOLD;

// The test's Step[] — a goto + fill + click (all capture screenshots) plus a
// trailing assert (no screenshot). Mirrors a real app-generated test.
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: randomUUID(), timestamp: 0, ...partial } as Step;
}
const steps: Step[] = [
  step({ type: "goto", url: "https://example.com" }),
  step({ type: "fill", locator: { k: "label", v: "Search" }, value: "glaze" }),
  step({ type: "click", locator: { k: "role", role: "button", name: "Go" } }),
  step({ type: "assert", locator: { k: "text", v: "Results" }, assert: "visible" }),
];
const capturedStepIds = [steps[0].id, steps[1].id, steps[2].id]; // goto/fill/click

// Simulate what the capture fixture writes to a run dir: <index>.png for each
// page action, in execution order, plus manifest.json. `action` must match
// captureMethod(step) so buildReplay correlates shots to steps.
function seedRunArtifacts(
  runId: string,
  shots: Buffer[],
  /** violations per action index, as the capture fixture would have written
   *  them onto the same manifest entries the screenshots use */
  a11yByAction: Record<number, A11yViolation[]> = {},
): void {
  const dir = artifactStore.ensureRunDir(testId, runId);
  const actions = ["goto", "fill", "click"];
  shots.forEach((buf, i) => fs.writeFileSync(path.join(dir, `${i}.png`), buf));
  const manifest: ArtifactManifest = {
    testId,
    runId,
    status: "passed",
    steps: actions.map((action, i) => ({
      index: i,
      action,
      target: "",
      ok: true,
      ts: Date.now(),
      ...(a11yByAction[i] ? { a11y: a11yByAction[i] } : {}),
    })),
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function runReplay(runId: string): ReturnType<typeof buildReplay> {
  const replay = buildReplay({
    testId,
    runId,
    testName: "E2E pipeline",
    url: "https://example.com",
    status: "passed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    steps,
    statuses: { 3: "passed" }, // the assert is reporter-visible
  });
  enrichWithVisualDiffs(replay, threshold);
  artifactStore.writeReplay(testId, runId, replay);
  return replay;
}

// ── 1. Toggle on → run produces artifacts, replay correlates correctly ─────
const run1 = randomUUID();
seedRunArtifacts(run1, [RED, RED, RED]);
const replay1 = runReplay(run1);
eq(replay1.steps.length, 4, "replay has one entry per Step[] step");
eq(replay1.failedIndex, null, "passing run has no failed step");
eq(
  replay1.steps.map((s) => s.screenshot !== null),
  [true, true, true, false],
  "captured steps have a screenshot; the assert does not",
);
eq(
  replay1.steps.map((s) => s.status),
  ["passed", "passed", "passed", "passed"],
  "every step is passed",
);
check(
  replay1.steps.every((s) => s.label.length > 0),
  "every step has a human-readable label",
);

// replay round-trips from disk (the UI reads it back).
const readBack = artifactStore.readReplay(testId, run1);
eq(readBack?.steps.length, 4, "replay.json round-trips from disk");

// ── 2. First run seeds pinned baselines (no false flag) ────────────────────
eq(
  replay1.steps.slice(0, 3).map((s) => s.diff?.state),
  ["new-baseline", "new-baseline", "new-baseline"],
  "first captured run seeds baselines (never a change)",
);
check(
  capturedStepIds.every((id) => baselineStore.has(testId, id)),
  "a pinned baseline PNG exists for every captured step",
);
eq(
  artifactStore.listReplays().find((r) => r.runId === run1)?.changedSteps,
  0,
  "run 1 reports zero changed steps",
);

// ── 3. A second run with an intentional change is flagged ──────────────────
const run2 = randomUUID();
seedRunArtifacts(run2, [RED_AGAIN, BLUE, RED_AGAIN]); // step 1 (fill) changed
const replay2 = runReplay(run2);
eq(
  replay2.steps.slice(0, 3).map((s) => s.diff?.state),
  ["match", "changed", "match"],
  "unchanged shots match; the altered shot is flagged changed",
);
const changedStep = replay2.steps[1];
check((changedStep.diff?.ratio ?? 0) > threshold / 100, "changed ratio exceeds the threshold");
check(
  !!changedStep.diff?.diffFile &&
    fs.existsSync(path.join(artifactStore.runDir(testId, run2), changedStep.diff.diffFile)),
  "a diff-overlay PNG was written for the changed step",
);
eq(
  artifactStore.listReplays().find((r) => r.runId === run2)?.changedSteps,
  1,
  "run 2 reports exactly one changed step",
);

// ── 4. Baseline approval clears the flag ───────────────────────────────────
// (a) per-step accept flips just that step.
const afterStepAccept = acceptStepBaseline(testId, run2, changedStep.stepId);
eq(
  afterStepAccept?.steps[1].diff?.state,
  "match",
  "per-step accept flips the changed step to match",
);
check(
  Buffer.compare(baselineStore.readShot(testId, changedStep.stepId) ?? Buffer.alloc(0), BLUE) === 0,
  "per-step accept re-pins the new (BLUE) screenshot as the baseline",
);

// (b) per-run accept clears any remaining flag and persists to disk.
const afterRunAccept = acceptRunBaseline(testId, run2);
eq(
  afterRunAccept?.steps.filter((s) => s.diff?.state === "changed").length,
  0,
  "per-run accept leaves zero changed steps",
);
eq(
  artifactStore.readReplay(testId, run2)?.steps.filter((s) => s.diff?.state === "changed").length,
  0,
  "the cleared flag persists in replay.json on disk",
);
// Re-diffing the same run against the now-updated baselines confirms the flag stays clear.
const replay2Reconfirm = runReplay(run2);
eq(
  replay2Reconfirm.steps.slice(0, 3).map((s) => s.diff?.state),
  ["match", "match", "match"],
  "a re-run after approval no longer flags the change",
);

// ── 5. Annotations persist and display ─────────────────────────────────────
const noteStepId = steps[2].id;
const saved = annotationStore.upsert(testId, run2, noteStepId, "  investigate this button  ");
check(saved !== null && saved.text === "investigate this button", "note is trimmed and stored");
const listed = annotationStore.list(testId, run2);
eq(listed.length, 1, "the saved note is listed for the run");
eq(listed[0]?.stepId, noteStepId, "the note is linked to the right step");
check(
  fs.existsSync(path.join(DATA_ROOT, "recorder", "annotations.json")),
  "the note persisted to annotations.json on disk",
);
// Blank text clears it (the app's clear affordance).
const cleared = annotationStore.upsert(testId, run2, noteStepId, "   ");
eq(cleared, null, "blank text deletes the note");
eq(annotationStore.list(testId, run2).length, 0, "the note is gone after clearing");

// ── 6. Retention keeps only the newest N run directories ───────────────────
const keep = 3;
for (let i = 0; i < keep + 4; i++) {
  const rid = `retain-${String(i).padStart(2, "0")}-${randomUUID()}`;
  seedRunArtifacts(rid, [RED, RED, RED]);
  // Stagger mtimes so "newest" is unambiguous.
  const dir = artifactStore.runDir(testId, rid);
  const t = new Date(Date.now() + i * 1000);
  fs.utimesSync(dir, t, t);
}
artifactStore.pruneRuns(testId, keep);
const remaining = artifactStore.listRuns(testId).filter((r) => r.startsWith("retain-"));
eq(remaining.length, keep, `pruneRuns keeps exactly ${keep} retention run dirs`);
check(
  baselineStore.has(testId, capturedStepIds[0]),
  "pruning run dirs never deletes the pinned baseline",
);

// ── 7. Ignore masks exclude a region from the comparison ───────────────────
// A screenshot that differs from its baseline ONLY inside a masked region must
// stay "match" — that's the whole point of masking dynamic content. The same
// screenshot with no mask (or a mask elsewhere) must still be flagged.
const maskTestId = randomUUID();
const maskSteps: Step[] = [step({ type: "goto", url: "https://example.com" })];
const maskStepId = maskSteps[0].id;

/** RED with a BLUE rectangle painted over the given normalized region. */
function patchedPng(nx: number, ny: number, nw: number, nh: number): Buffer {
  const png = PNG.sync.read(RED);
  const x0 = Math.round(nx * png.width);
  const y0 = Math.round(ny * png.height);
  const x1 = Math.round((nx + nw) * png.width);
  const y1 = Math.round((ny + nh) * png.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * png.width + x) * 4;
      png.data[o] = 40;
      png.data[o + 1] = 60;
      png.data[o + 2] = 220;
    }
  }
  return PNG.sync.write(png);
}

// The volatile widget occupies the top-left quarter of the page.
const WIDGET = { x: 0, y: 0, w: 0.25, h: 0.25 };
const PATCHED = patchedPng(WIDGET.x, WIDGET.y, WIDGET.w, WIDGET.h);

function maskReplay(runId: string, shot: Buffer, masks: VisualMask[]) {
  const dir = artifactStore.ensureRunDir(maskTestId, runId);
  fs.writeFileSync(path.join(dir, "0.png"), shot);
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      testId: maskTestId,
      runId,
      status: "passed",
      steps: [{ index: 0, action: "goto", target: "", ok: true, ts: Date.now() }],
    } satisfies ArtifactManifest),
  );
  const replay = buildReplay({
    testId: maskTestId,
    runId,
    testName: "Masking",
    url: "https://example.com",
    status: "passed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    steps: maskSteps,
    statuses: {},
  });
  enrichWithVisualDiffs(replay, threshold, masks);
  return replay;
}

// Seed the baseline from a clean run.
eq(maskReplay(randomUUID(), RED, []).steps[0].diff?.state, "new-baseline", "mask run seeds baseline");

// Unmasked: the patched widget is a real change.
eq(
  maskReplay(randomUUID(), PATCHED, []).steps[0].diff?.state,
  "changed",
  "without a mask, the altered region is flagged changed",
);

// Masked over the widget: same pixels, but now ignored.
const coveringMask: VisualMask = { id: randomUUID(), stepId: null, ...WIDGET };
const maskedRun = maskReplay(randomUUID(), PATCHED, [coveringMask]);
eq(
  maskedRun.steps[0].diff?.state,
  "match",
  "a mask over the altered region suppresses the change",
);
eq(maskedRun.steps[0].diff?.maskedCount, 1, "the applied mask count is recorded on the diff");

// A mask somewhere else must NOT suppress it.
eq(
  maskReplay(randomUUID(), PATCHED, [
    { id: randomUUID(), stepId: null, x: 0.6, y: 0.6, w: 0.3, h: 0.3 },
  ]).steps[0].diff?.state,
  "changed",
  "a mask elsewhere on the page doesn't suppress a real change",
);

// A mask scoped to a DIFFERENT step must not apply here.
eq(
  maskReplay(randomUUID(), PATCHED, [{ id: randomUUID(), stepId: randomUUID(), ...WIDGET }])
    .steps[0].diff?.state,
  "changed",
  "a mask pinned to another step doesn't apply",
);

// The same mask scoped to THIS step does apply.
eq(
  maskReplay(randomUUID(), PATCHED, [{ id: randomUUID(), stepId: maskStepId, ...WIDGET }])
    .steps[0].diff?.state,
  "match",
  "a mask pinned to this step applies",
);

// ── 8. Component-level (element-scoped) diffing ────────────────────────────
// Cropping to the element's recorded rect means a change ELSEWHERE on the page
// is ignored, while a change inside the element is still caught. A size change
// between runs is reported honestly rather than diffed as mismatched crops.
const elTestId = randomUUID();
const elSteps: Step[] = [
  step({ type: "click", locator: { k: "role", role: "button", name: "Go" } }),
];
const elStepId = elSteps[0].id;
// The button occupies the bottom-right quarter.
const BUTTON = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };

function elReplay(
  runId: string,
  shot: Buffer,
  rect: { x: number; y: number; w: number; h: number } | undefined,
  elementScoped: boolean,
) {
  const dir = artifactStore.ensureRunDir(elTestId, runId);
  fs.writeFileSync(path.join(dir, "0.png"), shot);
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      testId: elTestId,
      runId,
      status: "passed",
      steps: [
        { index: 0, action: "click", target: "", ok: true, ts: Date.now(), ...(rect ? { rect } : {}) },
      ],
    } satisfies ArtifactManifest),
  );
  const replay = buildReplay({
    testId: elTestId,
    runId,
    testName: "Component diffing",
    url: "https://example.com",
    status: "passed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    steps: elSteps,
    statuses: {},
  });
  enrichWithVisualDiffs(replay, threshold, [], elementScoped ? [elStepId] : []);
  return replay;
}

// Seed a baseline that carries the element geometry.
const elSeed = elReplay(randomUUID(), RED, BUTTON, true);
eq(elSeed.steps[0].diff?.state, "new-baseline", "element run seeds a baseline");
eq(elSeed.steps[0].rect?.w, BUTTON.w, "the capture rect round-trips into the replay model");
check(!!baselineStore.entry(elTestId, elStepId)?.rect, "the baseline records its element rect");

// A change OUTSIDE the element (top-left quarter) is ignored element-scoped...
const OUTSIDE = patchedPng(0, 0, 0.25, 0.25);
eq(
  elReplay(randomUUID(), OUTSIDE, BUTTON, true).steps[0].diff?.state,
  "match",
  "element-scoped: a change outside the element is ignored",
);
// ...but caught page-wide.
eq(
  elReplay(randomUUID(), OUTSIDE, BUTTON, false).steps[0].diff?.state,
  "changed",
  "page-scoped: the same change is still flagged",
);

// A change INSIDE the element is caught.
const INSIDE = patchedPng(0.5, 0.5, 0.5, 0.5);
const insideRun = elReplay(randomUUID(), INSIDE, BUTTON, true);
eq(insideRun.steps[0].diff?.state, "changed", "element-scoped: a change inside the element is caught");
eq(insideRun.steps[0].diff?.scope, "element", "the diff records the scope it was measured at");

// A resized element must not be diffed as mismatched crops.
const resized = elReplay(randomUUID(), RED, { x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, true);
eq(resized.steps[0].diff?.state, "unable", "a resized element reports unable, not a false change");
check(
  (resized.steps[0].diff?.reason ?? "").includes("moved or resized"),
  "the resize reason names the cause",
);

// Element scope requested but no geometry captured this run → say so.
eq(
  elReplay(randomUUID(), RED, undefined, true).steps[0].diff?.state,
  "unable",
  "element scope without recorded geometry reports unable",
);

// ── 9. Baselines manager: listing and unpinning ────────────────────────────
const pinnedList = Object.values(baselineStore.manifest(testId).steps);
eq(pinnedList.length, capturedStepIds.length, "every captured step is listed as a pinned baseline");
check(
  pinnedList.every((b) => b.label.length > 0 && b.runId.length > 0),
  "each listed baseline carries the label and run it was pinned from",
);

// Unpinning removes both the PNG and the manifest entry, so the next capture
// run re-seeds the step from scratch.
baselineStore.clear(testId, capturedStepIds[0]);
eq(baselineStore.has(testId, capturedStepIds[0]), false, "unpinning deletes the baseline image");
eq(baselineStore.entry(testId, capturedStepIds[0]), null, "unpinning removes the manifest entry");
eq(
  baselineStore.has(testId, capturedStepIds[1]),
  true,
  "unpinning one step leaves the others pinned",
);
// Clearing something already gone must not throw.
baselineStore.clear(testId, capturedStepIds[0]);
eq(baselineStore.entry(testId, capturedStepIds[0]), null, "clearing twice is a no-op");

// ── 10. Re-run comparison (live re-execution) ──────────────────────────────
// The comparison must distinguish "worked before, doesn't now" from a plain
// failure, and must match steps by id so an index shift can't misalign it.
const cmpTestId = randomUUID();
const cmpSteps: Step[] = [
  step({ type: "goto", url: "https://example.com" }),
  step({ type: "click", locator: { k: "role", role: "button", name: "A" } }),
  step({ type: "click", locator: { k: "role", role: "button", name: "B" } }),
];

function seedReplayWithStatuses(
  runId: string,
  statuses: ReplayStepStatus[],
): void {
  artifactStore.ensureRunDir(cmpTestId, runId);
  artifactStore.writeReplay(cmpTestId, runId, {
    testId: cmpTestId,
    runId,
    testName: "Comparison",
    status: statuses.includes("failed") ? "failed" : "passed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    failedIndex: statuses.indexOf("failed") >= 0 ? statuses.indexOf("failed") : null,
    steps: cmpSteps.map((st, i) => ({
      index: i,
      stepId: st.id,
      label: `step ${i}`,
      type: st.type,
      status: statuses[i],
      screenshot: null,
    })),
  });
}

const baseRun = randomUUID();
const rerun = randomUUID();
seedReplayWithStatuses(baseRun, ["passed", "passed", "failed"]);
seedReplayWithStatuses(rerun, ["passed", "failed", "passed"]);

const cmp = compareRuns(cmpTestId, baseRun, rerun);
eq(
  cmp?.steps.map((c) => c.delta),
  ["stable", "changed-since", "fixed"],
  "each step is classified by what moved between the runs",
);
eq(cmp?.changedSinceCount, 1, "counts what worked before and doesn't now");
eq(cmp?.fixedCount, 1, "counts what failed before and passes now");
eq(cmp?.stepsDiverged, false, "matching step sets don't report divergence");

// A missing replay (e.g. pruned by retention) is null, not a crash.
eq(compareRuns(cmpTestId, baseRun, randomUUID()), null, "a missing re-run compares to null");

// A step absent from the re-run is "unknown", and divergence is flagged.
const shortRun = randomUUID();
artifactStore.ensureRunDir(cmpTestId, shortRun);
artifactStore.writeReplay(cmpTestId, shortRun, {
  testId: cmpTestId,
  runId: shortRun,
  testName: "Comparison",
  status: "passed",
  startedAt: Date.now(),
  finishedAt: Date.now(),
  failedIndex: null,
  steps: [
    {
      index: 0,
      stepId: cmpSteps[0].id,
      label: "step 0",
      type: "goto",
      status: "passed",
      screenshot: null,
    },
  ],
});
const partial = compareRuns(cmpTestId, baseRun, shortRun);
eq(partial?.steps.map((c) => c.delta), ["stable", "unknown", "unknown"], "absent steps are unknown");
eq(partial?.changedSinceCount, 0, "an absent step is never counted as broken");
eq(partial?.stepsDiverged, true, "a differing step set is reported as diverged");

// ── Failure attribution must skip steps that never capture ────────────────
// When a capture run fails but NO step reported a failure, buildReplay falls
// back to "the first uncaptured step after the last screenshot". That question
// only makes sense for page interactions: a step that never produces a
// screenshot (a cookie step, control flow) can't be identified this way, and
// blaming it also marks every LATER step "skipped" when they actually ran.
{
  const runId = randomUUID();
  const dir = artifactStore.ensureRunDir(testId, runId);
  fs.writeFileSync(path.join(dir, "0.png"), solidPng(10, 20, 30));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      testId,
      runId,
      status: "failed",
      steps: [{ index: 0, action: "goto", target: "", ok: true, ts: Date.now() }],
    } satisfies ArtifactManifest),
  );

  // goto (captured) → cookie (never captures) → click (should be blamed)
  const mixed: Step[] = [
    step({ type: "goto", url: "https://example.com" }),
    step({ type: "cookie", cookieAction: "set", cookie: { name: "s", value: "1" } }),
    step({ type: "click", locator: { k: "role", role: "button", name: "Go" } }),
  ];
  const replay = buildReplay({
    testId,
    runId,
    testName: "attribution",
    url: "https://example.com",
    status: "failed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    steps: mixed,
    statuses: {}, // nothing reported a failure — the fallback path
  });

  eq(replay.steps[0].status, "passed", "the captured step before the failure passes");
  eq(
    replay.steps[1].status !== "failed",
    true,
    "a cookie step is NOT blamed for an uncaptured failure",
  );
  eq(replay.steps[2].status, "failed", "the first step that WOULD capture is blamed instead");
}

// ── accessibility rides the same pipeline ─────────────────────────────────
//
// The point of this section is that a11y results travel on the SAME manifest
// entries as screenshots, through the SAME step correlation. A separate
// correlation would be a second chance to attribute a result to the wrong step,
// and that mistake is invisible — the violation just appears under a step that
// didn't produce it.
{
  // The accept path writes onto the TestRecord, so one has to exist — in the
  // app it always does. Creating it here also pins that acceptance is stored on
  // the record rather than in the artifacts tree.
  testStore.save({
    id: testId,
    name: "E2E pipeline",
    url: "https://example.com",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps,
    scriptPath: path.join(DATA_ROOT, "unused.spec.ts"),
  });

  const a11yRunId = randomUUID();
  const contrast: A11yViolation[] = [
    { id: "color-contrast", impact: "serious", help: "Contrast is too low", nodes: [".cta"] },
  ];
  const missingLabel: A11yViolation[] = [
    { id: "label", impact: "critical", help: "Form elements must have labels", nodes: ["#email"] },
  ];
  // Attach to the SECOND and THIRD actions only, so a mis-correlation by one
  // would land them on the wrong steps and be caught.
  seedRunArtifacts(a11yRunId, [RED, RED, RED], { 1: contrast, 2: missingLabel });

  const replay = buildReplay({
    testId,
    runId: a11yRunId,
    testName: "E2E pipeline",
    url: "https://example.com",
    status: "passed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    steps,
    statuses: { 3: "passed" },
  });

  eq(replay.steps[0].a11y, undefined, "a step with no violations carries no a11y payload");
  eq(
    replay.steps[1].a11y?.violations[0].id,
    "color-contrast",
    "violations land on the step whose action produced them",
  );
  eq(
    replay.steps[2].a11y?.violations[0].id,
    "label",
    "…and the next step gets its own, not the previous step's",
  );

  // No baseline yet: everything is new.
  let flagged = enrichWithA11y(replay, undefined);
  eq(flagged, 2, "with no accepted baseline, every step with violations is flagged");
  eq(replay.steps[1].a11y?.newKeys, ["color-contrast|.cta"], "new keys are the violation keys");

  artifactStore.writeReplay(testId, a11yRunId, replay);

  // Accept one step, and the OTHER must stay flagged — accepting is per step.
  const afterAccept = acceptStepA11y(testId, a11yRunId, steps[1].id);
  eq(afterAccept?.steps[1].a11y?.newKeys.length, 0, "the accepted step stops being flagged");
  eq(
    afterAccept?.steps[2].a11y?.newKeys.length,
    1,
    "accepting one step leaves the others flagged",
  );
  eq(
    afterAccept?.steps[1].a11y?.violations.length,
    1,
    "an accepted step still SHOWS its violations, greyed rather than hidden",
  );

  // Re-running with the stored baseline reproduces that state — the acceptance
  // is persisted on the test record, not just patched into this replay.
  const rerun = buildReplay({
    testId,
    runId: a11yRunId,
    testName: "E2E pipeline",
    url: "https://example.com",
    status: "passed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    steps,
    statuses: { 3: "passed" },
  });
  flagged = enrichWithA11y(rerun, testStore.get(testId)?.a11yBaseline);
  eq(flagged, 1, "the acceptance survives into the next run");

  // A NEW node of an already-accepted rule must still flag: this is what stops
  // one acceptance from swallowing every future failure of the same rule.
  const widened: A11yViolation[] = [
    {
      id: "color-contrast",
      impact: "serious",
      help: "Contrast is too low",
      nodes: [".cta", ".footer-link"],
    },
  ];
  const widenedRunId = randomUUID();
  seedRunArtifacts(widenedRunId, [RED, RED, RED], { 1: widened });
  const widenedReplay = buildReplay({
    testId,
    runId: widenedRunId,
    testName: "E2E pipeline",
    url: "https://example.com",
    status: "passed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    steps,
    statuses: { 3: "passed" },
  });
  enrichWithA11y(widenedReplay, testStore.get(testId)?.a11yBaseline);
  eq(
    widenedReplay.steps[1].a11y?.newKeys,
    ["color-contrast|.footer-link"],
    "a new NODE of an accepted rule is still flagged",
  );

  // Resetting gives everything back, so an over-eager "accept run" is undoable.
  resetA11yBaseline(testId);
  const afterReset = buildReplay({
    testId,
    runId: a11yRunId,
    testName: "E2E pipeline",
    url: "https://example.com",
    status: "passed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    steps,
    statuses: { 3: "passed" },
  });
  eq(
    enrichWithA11y(afterReset, testStore.get(testId)?.a11yBaseline),
    2,
    "resetting the baseline reports everything again",
  );

  // Retention must not touch the acceptance. The pixel baseline needed a
  // special exclusion for this and once lost one to a pruning bug; keeping the
  // a11y baseline on the TestRecord instead makes it structurally safe, and
  // this pins that.
  acceptRunA11y(testId, a11yRunId);
  const beforePrune = testStore.get(testId)?.a11yBaseline;
  artifactStore.pruneRuns(testId, 0, 0);
  eq(
    testStore.get(testId)?.a11yBaseline,
    beforePrune,
    "pruning every run's artifacts leaves the accepted-violations baseline intact",
  );
}

// ── cleanup + verdict ──────────────────────────────────────────────────────
try {
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
} catch {
  /* best-effort */
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll visual-pipeline end-to-end checks passed");
