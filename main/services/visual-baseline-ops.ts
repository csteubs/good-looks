// "Accept as new baseline" operations (Phase 3). Re-pinning spans the run's
// artifacts (where the accepted screenshot lives) and the baseline store (where
// it's pinned), so it lives here rather than in either store to avoid a cycle.
//
// Accepting patches the run's replay.json so the UI reflects the re-pin
// immediately: the accepted steps become "match" (ratio 0) against themselves.

import { artifactStore } from "./artifact-store.js";
import type { RunReplay } from "./artifact-store.js";
import { baselineStore } from "./baseline-store.js";

/** Pin one step of a completed run as its new baseline. Returns the patched
 *  replay (or null if the run has no replay). No-op when the step produced no
 *  screenshot to pin. */
export function acceptStepBaseline(testId: string, runId: string, stepId: string): RunReplay | null {
  const replay = artifactStore.readReplay(testId, runId);
  if (!replay) return null;
  const step = replay.steps.find((s) => s.stepId === stepId);
  if (step && step.screenshot) {
    const png = artifactStore.readShot(testId, runId, step.screenshot);
    if (png) {
      baselineStore.set(testId, stepId, png, { runId, label: step.label });
      step.diff = { state: "match", ratio: 0, threshold: replay.visualThreshold };
      artifactStore.writeReplay(testId, runId, replay);
    }
  }
  return replay;
}

/** Pin every screenshot-producing step of a run as the new baselines. */
export function acceptRunBaseline(testId: string, runId: string): RunReplay | null {
  const replay = artifactStore.readReplay(testId, runId);
  if (!replay) return null;
  for (const step of replay.steps) {
    if (!step.screenshot) continue;
    const png = artifactStore.readShot(testId, runId, step.screenshot);
    if (!png) continue;
    baselineStore.set(testId, step.stepId, png, { runId, label: step.label });
    step.diff = { state: "match", ratio: 0, threshold: replay.visualThreshold };
  }
  artifactStore.writeReplay(testId, runId, replay);
  return replay;
}
