// The runner's replay-correlation "brain", extracted from playwright-runner.ts
// so it can be regression-tested end-to-end without spawning Playwright or a
// browser (see main/services/__tests__/visual-pipeline.check.ts). These three
// functions depend only on the artifact/baseline stores, the pure diff helper,
// and describeStep — no child_process, no IPC — so a standalone check can drive
// them against a temp userData directory.
//
// Behavior is identical to the in-runner version; this is a pure move.

import { artifactStore } from "./artifact-store.js";
import type { NormalizedRect, ReplayStep, ReplayStepStatus, RunReplay } from "./artifact-store.js";
import { baselineStore } from "./baseline-store.js";
import { diffPngBuffers } from "./visual-diff.js";
import { diffViolations } from "./a11y-diff.js";
import type { A11yViolation } from "./a11y-diff.js";
import { describeStep } from "./script-generator.js";
import type { Step, VisualMask } from "../recorder/types.js";

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
  const rectByStep: (NormalizedRect | undefined)[] = [];
  // Accessibility results ride the SAME manifest entries as screenshots, so
  // they're collected in this pass rather than matched again separately —
  // two independent correlations over the same list would be two chances to
  // attribute a result to the wrong step.
  const a11yByStep: (A11yViolation[] | undefined)[] = [];
  const shotByStep: (string | null)[] = params.steps.map((s, i) => {
    const method = s.type === "if" || s.type === "endif" ? null : captureMethod(s);
    if (method && shotPtr < shots.length && shots[shotPtr].action === method) {
      const entry = shots[shotPtr++];
      rectByStep[i] = entry.rect;
      // Recorded whether or not the screenshot succeeded, and on a11y-only runs
      // where `ok` is false because no screenshot was ever attempted.
      a11yByStep[i] = entry.a11y;
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
    // Only steps that WOULD have produced a screenshot are candidates. This
    // fallback exists to answer "which uncaptured page interaction failed?" —
    // a step that never captures (cookie state, control flow) can't be
    // identified this way, and blaming it also marks every later step
    // "skipped" when they actually ran. A cookie step that genuinely fails is
    // still surfaced, because the reporter reports it and reportedFail wins
    // above this branch.
    const cand = params.steps.findIndex(
      (s, i) => i > lastShotIdx && captureMethod(s) !== null,
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
      ...(rectByStep[i] ? { rect: rectByStep[i] } : {}),
      // Raw violations only at this stage. Comparing them against the accepted
      // baseline is `enrichWithA11y`'s job, exactly as pixel diffing is
      // `enrichWithVisualDiffs`' — buildReplay stays a pure correlation of what
      // the run produced, with no store lookups in it.
      ...(a11yByStep[i]
        ? { a11y: { violations: a11yByStep[i]!, newKeys: [], acceptedCount: 0 } }
        : {}),
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

/**
 * Compare each step's accessibility violations against the test's accepted
 * baseline, filling in `newKeys` / `acceptedCount`.
 *
 * Separate from `buildReplay` for the same reason visual diffing is: the
 * builder correlates what the run produced, and enrichment consults stored
 * state. Keeping them apart is what lets both be tested without a browser.
 *
 * Returns how many steps have violations that are NOT accepted — the number the
 * UI badges and the run record stores. Never affects the run's pass/fail:
 * accessibility is reported here, not gated.
 */
export function enrichWithA11y(
  replay: RunReplay,
  baseline: Record<string, string[]> | undefined,
): number {
  let flagged = 0;
  for (const step of replay.steps) {
    if (!step.a11y) continue;
    const result = diffViolations(step.a11y.violations, baseline?.[step.stepId]);
    if (!result) {
      delete step.a11y;
      continue;
    }
    step.a11y = result;
    if (result.newKeys.length > 0) flagged++;
  }
  return flagged;
}

// Phase 3 — visual-diff enrichment. For each captured step, compare its
// screenshot against the PINNED baseline (keyed by Step.id, not URL). If no
// baseline exists yet, this run's shot seeds it ("new-baseline"). Mutates each
// step's `diff`. Best-effort: any failure degrades to "unable" — a diff must
// never throw into the run's finally block or false-flag a change.
export function enrichWithVisualDiffs(
  replay: RunReplay,
  threshold: number,
  masks: readonly VisualMask[] = [],
  /** stepIds the user set to compare element-scoped rather than page-wide. */
  elementSteps: readonly string[] = [],
): void {
  const elementScoped = new Set(elementSteps);
  replay.visualThreshold = threshold;
  for (const step of replay.steps) {
    // A mask with stepId null is test-wide; otherwise it targets one step.
    const stepMasks = masks.filter((m) => m.stepId === null || m.stepId === step.stepId);
    if (!step.screenshot) continue; // asserts/waits/skipped — nothing to compare
    const next = artifactStore.readShot(replay.testId, replay.runId, step.screenshot);
    if (!next) {
      step.diff = { state: "unable", reason: "screenshot unreadable", threshold };
      continue;
    }
    if (!baselineStore.has(replay.testId, step.stepId)) {
      // First captured run for this step — seed the pinned baseline, recording
      // the element geometry alongside so a later element-scoped diff can crop
      // the baseline the same way.
      baselineStore.set(replay.testId, step.stepId, next, {
        runId: replay.runId,
        label: step.label,
        rect: step.rect,
      });
      step.diff = { state: "new-baseline", threshold };
      continue;
    }
    const baseline = baselineStore.readShot(replay.testId, step.stepId);
    if (!baseline) {
      step.diff = { state: "unable", reason: "baseline unreadable", threshold };
      continue;
    }
    // Component-level: crop both sides to the element's rect as measured in
    // each run. Requires geometry on BOTH sides — if either is missing we say
    // so rather than silently falling back to a page-wide comparison the user
    // didn't ask for.
    let region: { baseline: NormalizedRect; next: NormalizedRect } | undefined;
    const wantsElement = elementScoped.has(step.stepId);
    if (wantsElement) {
      const baseRect = baselineStore.entry(replay.testId, step.stepId)?.rect;
      if (!baseRect || !step.rect) {
        step.diff = {
          state: "unable",
          reason: !step.rect
            ? "no element geometry recorded for this run (element-scoped comparison)"
            : "the pinned baseline predates element geometry — accept a new baseline to enable it",
          threshold,
          scope: "element",
        };
        continue;
      }
      region = { baseline: baseRect, next: step.rect };
    }

    const outcome = diffPngBuffers(baseline, next, threshold, undefined, stepMasks, region);
    const scope = wantsElement ? ("element" as const) : ("page" as const);
    if (outcome.state === "unable") {
      step.diff = { state: "unable", reason: outcome.reason, threshold, scope };
    } else if (outcome.state === "changed") {
      const shotIndex = Number.parseInt(step.screenshot, 10);
      const diffFile = artifactStore.writeDiff(replay.testId, replay.runId, shotIndex, outcome.diffPng);
      step.diff = {
        state: "changed",
        ratio: outcome.ratio,
        threshold,
        diffFile,
        maskedCount: stepMasks.length || undefined,
        scope,
      };
    } else {
      step.diff = {
        state: "match",
        ratio: outcome.ratio,
        threshold,
        maskedCount: stepMasks.length || undefined,
        scope,
      };
    }
  }
}
