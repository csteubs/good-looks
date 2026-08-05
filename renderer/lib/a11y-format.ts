// Presentation helpers for accessibility results.
//
// Mirrors the ranking half of main/services/a11y-diff.ts. The backend owns the
// decision of what counts as NEW (it has the baseline); the renderer only needs
// to know how to rank and phrase what it was handed.

import type { A11yResult, A11yViolation } from "./recorder-types";

/** axe's own severity order, worst first. */
export const IMPACT_ORDER: A11yViolation["impact"][] = [
  "critical",
  "serious",
  "moderate",
  "minor",
];

/** Mirror of `violationKey` in main/services/a11y-diff.ts — keep in sync.
 *  Rule id AND node target: keying on the rule alone would make accepting one
 *  low-contrast label accept every future contrast failure on the page. */
export function violationKey(id: string, target: string): string {
  return `${id}|${target}`;
}

/** Every key a violation covers — one per offending node. */
export function keysOf(v: A11yViolation): string[] {
  if (!v.nodes || v.nodes.length === 0) return [violationKey(v.id, "")];
  return v.nodes.map((t) => violationKey(v.id, t));
}

/**
 * The worst impact among a result's NEW violations, for badge colouring.
 *
 * Ranked by severity rather than by count on purpose: one critical violation
 * deserves more attention than six minor ones, and a badge that only counted
 * would say the opposite.
 */
export function worstNewImpact(result: A11yResult | undefined): A11yViolation["impact"] | null {
  if (!result || result.newKeys.length === 0) return null;
  const newSet = new Set(result.newKeys);
  let worst: A11yViolation["impact"] | null = null;
  for (const v of result.violations) {
    if (!keysOf(v).some((k) => newSet.has(k))) continue;
    if (worst === null || IMPACT_ORDER.indexOf(v.impact) < IMPACT_ORDER.indexOf(worst)) {
      worst = v.impact;
    }
  }
  return worst;
}

/** How many steps in a replay have unaccepted violations. */
export function countA11ySteps(steps: { a11y?: A11yResult }[]): number {
  return steps.filter((s) => (s.a11y?.newKeys.length ?? 0) > 0).length;
}
