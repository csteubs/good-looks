// "Accept these accessibility violations" operations.
//
// Mirrors visual-baseline-ops.ts, and for the same reason: accepting spans the
// run's replay (where the violations were reported) and the test record (where
// the acceptance is pinned), so it belongs in neither store.
//
// One difference from the pixel baseline is deliberate. A pixel baseline is an
// IMAGE, stored under the artifacts tree and therefore something retention has
// to be taught to spare. An accepted-violations baseline is a small list of
// keys, so it lives on the TestRecord — which retention never touches at all.
// That makes the "pruning deleted my baseline" bug structurally impossible here
// rather than a rule someone has to remember.

import { logger } from "@shell/backend";

import { artifactStore } from "./artifact-store.js";
import type { RunReplay } from "./artifact-store.js";
import { runHistoryStore } from "./run-history-store.js";
import { testStore } from "./test-store.js";
import { acceptKeysFor } from "./a11y-diff.js";
import { keysOf, selectLatestA11yRuns } from "../../shared/a11y-rollup.mjs";

/** Merge accepted keys into a test's baseline and persist. Returns the number
 *  of steps whose acceptance changed. */
function pin(testId: string, perStep: Record<string, string[]>): number {
  const rec = testStore.get(testId);
  if (!rec) {
    // The acceptance has nowhere to live. Silence here would look exactly like
    // success from the UI — the replay gets patched, the badge clears, and the
    // next run flags everything again with no explanation.
    logger.warn("a11y", "Cannot accept violations: no such test", { testId });
    return 0;
  }
  const next: Record<string, string[]> = { ...(rec.a11yBaseline ?? {}) };
  let changed = 0;
  for (const [stepId, keys] of Object.entries(perStep)) {
    if (keys.length === 0) continue;
    const before = next[stepId] ?? [];
    // Union, not replace: a step's earlier acceptances stay accepted. Replacing
    // would silently un-accept anything the current run happened not to hit —
    // a conditional branch that didn't run this time, say — and those would
    // then reappear as "new" on the next run that did hit them.
    const merged = [...new Set([...before, ...keys])];
    if (merged.length !== before.length) changed++;
    next[stepId] = merged;
  }
  if (changed === 0) return 0;
  rec.a11yBaseline = next;
  rec.updatedAt = Date.now();
  testStore.save(rec);
  return changed;
}

/** Patch a replay so accepted steps stop being flagged, without re-running. */
function clearFlags(replay: RunReplay, stepIds: Set<string>): void {
  for (const step of replay.steps) {
    if (!step.a11y || !stepIds.has(step.stepId)) continue;
    step.a11y = {
      violations: step.a11y.violations,
      newKeys: [],
      // Everything this step reported is now accepted, which is what the count
      // should say — otherwise the UI would show "0 new, 0 accepted" for a step
      // that plainly has violations.
      acceptedCount: acceptKeysFor(step.a11y.violations).length,
    };
  }
}

/** Accept every violation one step reported in this run. */
export function acceptStepA11y(testId: string, runId: string, stepId: string): RunReplay | null {
  const replay = artifactStore.readReplay(testId, runId);
  if (!replay) return null;
  const step = replay.steps.find((s) => s.stepId === stepId);
  if (!step?.a11y) return replay;
  pin(testId, { [stepId]: acceptKeysFor(step.a11y.violations) });
  clearFlags(replay, new Set([stepId]));
  artifactStore.writeReplay(testId, runId, replay);
  return replay;
}

/** Accept every violation this run reported, across all its steps. */
export function acceptRunA11y(testId: string, runId: string): RunReplay | null {
  const replay = artifactStore.readReplay(testId, runId);
  if (!replay) return null;
  const perStep: Record<string, string[]> = {};
  const touched = new Set<string>();
  for (const step of replay.steps) {
    if (!step.a11y) continue;
    perStep[step.stepId] = acceptKeysFor(step.a11y.violations);
    touched.add(step.stepId);
  }
  if (touched.size === 0) return replay;
  pin(testId, perStep);
  clearFlags(replay, touched);
  artifactStore.writeReplay(testId, runId, replay);
  return replay;
}

/**
 * Accept ONE RULE everywhere it currently fires — the Accessibility view's
 * triage verb. "Everywhere" is defined the same way the rollup defines it
 * (`selectLatestA11yRuns`): each test's most recent run that completed checks.
 * Using any other selection would let the view offer an accept that touches a
 * different set of steps than the board it sits on shows.
 *
 * Only that rule's keys are pinned — accepting `color-contrast` across the
 * suite must not quietly sign off an `image-alt` violation that happens to
 * share a step. The replays are patched the same way the step/run accepts
 * patch them, narrowed to the rule's keys, and written back so the Visual
 * replay and the rollup agree without a re-run.
 */
export function acceptRuleA11y(ruleId: string): { tests: number; steps: number } {
  const chosen = selectLatestA11yRuns(runHistoryStore.list());
  let tests = 0;
  let steps = 0;
  for (const run of chosen) {
    const replay = artifactStore.readReplay(run.testId, run.id);
    if (!replay) continue;
    const perStep: Record<string, string[]> = {};
    let stepsHere = 0;
    for (const step of replay.steps) {
      if (!step.a11y) continue;
      const ruleKeys = step.a11y.violations
        .filter((v) => v.id === ruleId)
        .flatMap((v) => keysOf(v));
      if (ruleKeys.length === 0) continue;
      perStep[step.stepId] = ruleKeys;
      const accepted = new Set(ruleKeys);
      const remaining = step.a11y.newKeys.filter((k) => !accepted.has(k));
      if (remaining.length !== step.a11y.newKeys.length) stepsHere++;
      step.a11y = {
        violations: step.a11y.violations,
        newKeys: remaining,
        // Recomputed from the violations rather than incremented: keys can be
        // pinned twice (a step accept followed by a rule accept), and a count
        // that double-adds reads as more accepted issues than the step has.
        acceptedCount: acceptKeysFor(step.a11y.violations).filter((k) => !remaining.includes(k))
          .length,
      };
    }
    if (Object.keys(perStep).length === 0) continue;
    const pinned = pin(run.testId, perStep);
    if (pinned > 0 || stepsHere > 0) {
      tests++;
      steps += stepsHere;
      artifactStore.writeReplay(run.testId, run.id, replay);
    }
  }
  return { tests, steps };
}

/**
 * Un-accept ONE RULE for ONE TEST — the Accessibility view's per-item revoke.
 * `resetA11yBaseline` below is all-or-nothing, which makes one mistaken
 * acceptance cost a whole re-triage; this removes only the keys spelled
 * `<ruleId>|…`. Like reset, it changes nothing until the next run, which then
 * reports the rule's violations again.
 */
export function revokeA11yRule(testId: string, ruleId: string): { removed: number } {
  const rec = testStore.get(testId);
  if (!rec?.a11yBaseline) return { removed: 0 };
  const prefix = `${ruleId}|`;
  let removed = 0;
  const next: Record<string, string[]> = {};
  for (const [stepId, keys] of Object.entries(rec.a11yBaseline)) {
    const kept = keys.filter((k) => !k.startsWith(prefix));
    removed += keys.length - kept.length;
    if (kept.length > 0) next[stepId] = kept;
  }
  if (removed === 0) return { removed: 0 };
  if (Object.keys(next).length === 0) delete rec.a11yBaseline;
  else rec.a11yBaseline = next;
  rec.updatedAt = Date.now();
  testStore.save(rec);
  return { removed };
}

/** Forget a test's accepted violations, so the next run reports everything
 *  again. The way back from an over-eager "accept run". */
export function resetA11yBaseline(testId: string): { cleared: number } {
  const rec = testStore.get(testId);
  if (!rec?.a11yBaseline) return { cleared: 0 };
  const cleared = Object.keys(rec.a11yBaseline).length;
  delete rec.a11yBaseline;
  rec.updatedAt = Date.now();
  testStore.save(rec);
  return { cleared };
}
