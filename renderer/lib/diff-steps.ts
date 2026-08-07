// Content-based diff between two step lists, used to work out which steps an
// AI-debug apply actually ADDED so the step views can glow them.
//
// Why content and not ids: applying a suggested fix goes through
// `tests:updateScript`, which re-parses the whole spec, and the parser mints a
// fresh `randomUUID()` for every step it produces (main/services/spec-parser.ts
// `makeStep`). So after an apply EVERY id is different, including the ids of
// steps that did not change at all. Diffing by id would light up the entire
// list. The only stable thing across an apply is what a step *says*.
//
// Companion to line-diff.ts, which does the same job over the spec's text for
// the pre-apply confirm view. Same LCS, different unit.

import type { Step } from "./recorder-types";

/**
 * A stable identity for a step's *meaning*, ignoring `id` and `timestamp`
 * (both of which change on every re-parse and neither of which the user can
 * see).
 *
 * Built from an explicit field list rather than by stripping keys off the step.
 * That direction matters: a field added to `Step` later is inert here until
 * someone deliberately adds it, which is a missed highlight. The other
 * direction — spreading the step and deleting `id`/`timestamp` — would make
 * every future field silently significant, so an unrelated backend field that
 * happens to be recomputed on parse would mark every step as new.
 */
export function stepSignature(step: Step): string {
  return JSON.stringify([
    step.type,
    step.locator ? [step.locator.k, step.locator.v, step.locator.role, step.locator.name] : null,
    step.value,
    step.label,
    step.url,
    step.assert,
    step.cond,
    step.text,
    step.soft,
    step.attr,
    step.count,
    step.width,
    step.height,
    step.waitMs,
    step.waitUntil,
    step.timeoutMs,
    step.cookieAction,
    step.cookie
      ? [
          step.cookie.name,
          step.cookie.value,
          step.cookie.domain,
          step.cookie.path,
          step.cookie.secure,
          step.cookie.httpOnly,
          step.cookie.sameSite,
          step.cookie.expirationDate,
          step.cookie.url,
        ]
      : null,
    step.continueOnFailure,
    step.disabled,
    step.captureVar,
    step.captureFrom,
    step.captureAttr,
    step.flowId,
    step.flowArgs ? Object.entries(step.flowArgs).sort() : null,
  ]);
}

export interface StepDiff {
  /** Indexes into `after` of steps that are genuinely new. */
  addedIndexes: number[];
  /** How many steps in `before` have no counterpart in `after`. */
  removedCount: number;
}

/**
 * Diff two step lists by content.
 *
 * A step counts as ADDED when it is in `after`, is not matched by the LCS, and
 * its signature does not also appear among the removals. That last clause is
 * what stops a *reorder* from reading as a wholesale add+remove: dragging step
 * 5 to the top produces one LCS removal and one LCS addition of the very same
 * step, and glowing it would tell the user something was added when nothing
 * was.
 *
 * A SUBSTITUTION — the model swaps a step's selector, say — does glow its
 * replacement. That is deliberate: the resulting step is one the user has not
 * seen before and is exactly what they need to look at.
 */
export function diffSteps(before: Step[], after: Step[]): StepDiff {
  const a = before.map(stepSignature);
  const b = after.map(stepSignature);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i:] and b[j:]. O(n*m) is fine — step
  // lists are tens of entries, not thousands.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const addedCandidates: number[] = [];
  const removedSignatures: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removedSignatures.push(a[i]);
      i++;
    } else {
      addedCandidates.push(j);
      j++;
    }
  }
  while (i < n) removedSignatures.push(a[i++]);
  while (j < m) addedCandidates.push(j++);

  // Cancel each addition against at most one identical removal, so N copies of
  // a step that moved stay "moved" while an N+1th genuinely new copy still
  // glows. A plain `has` on a Set would swallow that extra copy.
  const unmatchedRemovals = new Map<string, number>();
  for (const sig of removedSignatures) {
    unmatchedRemovals.set(sig, (unmatchedRemovals.get(sig) ?? 0) + 1);
  }

  const addedIndexes: number[] = [];
  for (const index of addedCandidates) {
    const sig = b[index];
    const pending = unmatchedRemovals.get(sig) ?? 0;
    if (pending > 0) {
      unmatchedRemovals.set(sig, pending - 1);
      continue; // moved, not new
    }
    addedIndexes.push(index);
  }

  return { addedIndexes, removedCount: removedSignatures.length };
}

/**
 * The ids of the steps in `after` that `before` did not contain — what the
 * views actually key their highlight off.
 *
 * Ids are safe to use for the RESULT even though they are useless as diff
 * input: the highlight only has to survive until the list changes again, and
 * the list it is rendered against is the same `after` these ids came from.
 */
export function newStepIds(before: Step[], after: Step[]): Set<string> {
  const { addedIndexes } = diffSteps(before, after);
  return new Set(addedIndexes.map((i) => after[i].id));
}
