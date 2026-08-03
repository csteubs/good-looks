// The runner's replay-correlation "brain", extracted from playwright-runner.ts
// so it can be regression-tested end-to-end without spawning Playwright or a
// browser (see main/services/__tests__/visual-pipeline.check.ts). These three
// functions depend only on the artifact/baseline stores, the pure diff helper,
// and describeStep — no child_process, no IPC — so a standalone check can drive
// them against a temp userData directory.
//
// Behavior is identical to the in-runner version; this is a pure move.

import { artifactStore } from "./artifact-store.js";
import type { ReplayStep, ReplayStepStatus, RunReplay } from "./artifact-store.js";
import { baselineStore } from "./baseline-store.js";
import { diffPngBuffers } from "./visual-diff.js";
import { describeStep } from "./script-generator.js";
import type { Step } from "../recorder/types.js";

// The Playwright action a step captures a screenshot for (mirrors the fixture's
// PAGE_ACTIONS/LOCATOR_ACTIONS in capture-fixture-source.ts). null → the step
// produces no screenshot (assertions, waits, keyboard press, if/endif). Used to
// match manifest entries to steps by method, so a single classification miss
// can never cascade-desync the whole timeline.
export function captureMethod(step: Step): string | null {
  switch (step.type) {
    case "goto":
      return "goto";
    case "click":
      return "click";
    case "fill":
      return "fill";
    case "select":
      return "selectOption";
    case "check":
      return "check";
    case "uncheck":
      return "uncheck";
    case "viewport":
      return "setViewportSize";
    case "press":
      // Only locator.press() is captured; page.keyboard.press() is not.
      return step.locator ? "press" : null;
    default:
      return null;
  }
}

// Correlate the reporter's per-step statuses and the capture manifest against
// the test's Step[] to produce the canonical replay model. All index reconciling
// (reporter step index, action-order screenshot index, Step[] index) happens
// here, once, so the replay UI is a dumb reader.
//
// Status uses two independent, complementary signals — neither alone is
// sufficient for a capture run:
//   • Reporter statuses are authoritative for steps the StepReporter sees —
//     asserts, waits, page-level calls. But the capture fixture WRAPS action
//     methods, so Playwright attributes those wrapped actions' step location to
//     the fixture file and the reporter's file guard drops them. So the wrapped
//     actions (goto/click/fill/…) get NO reporter status on a capture run.
//   • A wrapped action's screenshot is taken only AFTER it resolves, so a
//     screenshot present ⇒ that action ran and passed; the run halts at the
//     first failure, so the failing step is the first uncaptured step after the
//     last screenshot (or a reported failure, whichever comes first).
export function buildReplay(params: {
  testId: string;
  runId: string;
  testName: string;
  url?: string;
  status: "passed" | "failed";
  startedAt: number;
  finishedAt: number;
  steps: Step[];
  statuses: Record<number, "passed" | "failed">;
}): RunReplay {
  const shots = artifactStore.readManifest(params.testId, params.runId)?.steps ?? [];

  // Pass 1 — screenshots per step, matched in execution order by method so a
  // non-captured step can never steal the next action's shot.
  let shotPtr = 0;
  const shotByStep: (string | null)[] = params.steps.map((s) => {
    const method = s.type === "if" || s.type === "endif" ? null : captureMethod(s);
    if (method && shotPtr < shots.length && shots[shotPtr].action === method) {
      const entry = shots[shotPtr++];
      return entry.ok ? `${entry.index}.png` : null;
    }
    return null;
  });
  const lastShotIdx = shotByStep.reduce((acc, sc, i) => (sc ? i : acc), -1);

  // Pass 2 — the failing step. A reported failure wins; otherwise, for a failed
  // run, it's the first step past the last screenshot that could actually fail.
  const reportedFail = Object.keys(params.statuses)
    .map(Number)
    .filter((i) => params.statuses[i] === "failed")
    .sort((a, b) => a - b)[0];
  let failedIdx: number | null = null;
  if (reportedFail !== undefined) {
    failedIdx = reportedFail;
  } else if (params.status === "failed") {
    const cand = params.steps.findIndex(
      (s, i) => i > lastShotIdx && s.type !== "if" && s.type !== "endif",
    );
    failedIdx = cand >= 0 ? cand : lastShotIdx >= 0 ? lastShotIdx : params.steps.length ? 0 : null;
  }

  // Pass 3 — status per step, reconciling both signals.
  const steps: ReplayStep[] = params.steps.map((s, i) => {
    const isControl = s.type === "if" || s.type === "endif";
    let status: ReplayStepStatus;
    if (isControl) status = "skipped";
    else if (params.statuses[i]) status = params.statuses[i];
    else if (shotByStep[i]) status = "passed";
    else if (failedIdx !== null && i === failedIdx) status = "failed";
    else if (failedIdx !== null && i > failedIdx) status = "skipped";
    else status = "passed";
    return {
      index: i,
      stepId: s.id,
      label: describeStep(s),
      type: s.type,
      status,
      screenshot: shotByStep[i],
    };
  });
  const failedIndex = steps.find((s) => s.status === "failed")?.index ?? null;
  return {
    testId: params.testId,
    runId: params.runId,
    testName: params.testName,
    url: params.url,
    status: params.status,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    failedIndex,
    steps,
  };
}

// Phase 3 — visual-diff enrichment. For each captured step, compare its
// screenshot against the PINNED baseline (keyed by Step.id, not URL). If no
// baseline exists yet, this run's shot seeds it ("new-baseline"). Mutates each
// step's `diff`. Best-effort: any failure degrades to "unable" — a diff must
// never throw into the run's finally block or false-flag a change.
export function enrichWithVisualDiffs(replay: RunReplay, threshold: number): void {
  replay.visualThreshold = threshold;
  for (const step of replay.steps) {
    if (!step.screenshot) continue; // asserts/waits/skipped — nothing to compare
    const next = artifactStore.readShot(replay.testId, replay.runId, step.screenshot);
    if (!next) {
      step.diff = { state: "unable", reason: "screenshot unreadable", threshold };
      continue;
    }
    if (!baselineStore.has(replay.testId, step.stepId)) {
      // First captured run for this step — seed the pinned baseline.
      baselineStore.set(replay.testId, step.stepId, next, {
        runId: replay.runId,
        label: step.label,
      });
      step.diff = { state: "new-baseline", threshold };
      continue;
    }
    const baseline = baselineStore.readShot(replay.testId, step.stepId);
    if (!baseline) {
      step.diff = { state: "unable", reason: "baseline unreadable", threshold };
      continue;
    }
    const outcome = diffPngBuffers(baseline, next, threshold);
    if (outcome.state === "unable") {
      step.diff = { state: "unable", reason: outcome.reason, threshold };
    } else if (outcome.state === "changed") {
      const shotIndex = Number.parseInt(step.screenshot, 10);
      const diffFile = artifactStore.writeDiff(replay.testId, replay.runId, shotIndex, outcome.diffPng);
      step.diff = { state: "changed", ratio: outcome.ratio, threshold, diffFile };
    } else {
      step.diff = { state: "match", ratio: outcome.ratio, threshold };
    }
  }
}
