// Presentation helpers for accessibility results.
//
// Mirrors the ranking half of main/services/a11y-diff.ts. The backend owns the
// decision of what counts as NEW (it has the baseline); the renderer only needs
// to know how to rank and phrase what it was handed.

import { violationKey, keysOf } from "../../shared/a11y-rollup.mjs";
import type { A11yResult, A11yViolation } from "./recorder-types";

/** axe's own severity order, worst first. */
export const IMPACT_ORDER: A11yViolation["impact"][] = [
  "critical",
  "serious",
  "moderate",
  "minor",
];

/** NO LONGER A MIRROR. Both of these used to be a hand-copy of the pair in
 *  `main/services/a11y-diff.ts`, with a comment asking the next person to keep
 *  them in sync. They are one definition in `shared/a11y-rollup.mjs` now and
 *  re-exported here, because two spellings of a key mean an accepted violation
 *  stops matching its baseline and the app reports a finding the user has
 *  already dismissed — with nothing on screen or in a log to say why. */
export { violationKey, keysOf };

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

/** The shape of a run record this module needs — a structural subset, so the
 *  helper below can be tested without building a whole RunRecord. */
export interface A11yRunLike {
  testId: string;
  startedAt: number;
  a11yMs?: number;
  a11yChecks?: number;
}

/**
 * The most recent run of one test that actually ran the accessibility check.
 *
 * `a11yMs` counts, not just `a11yChecks`. A run where axe executed but every
 * check failed reports zero CHECKS while still having spent the time, and
 * treating that as "this test has never been checked" would hide a broken check
 * behind the same empty state as a test nobody has enabled it for — which is
 * precisely how a fixture bug went unnoticed for months. The panel needs to be
 * able to tell those two apart, so this returns the run and lets it.
 *
 * Sorts rather than trusting the caller's order: `runs:list` is newest-first
 * today, and "the panel silently shows an old run" is not a failure anyone would
 * notice.
 */
export function latestA11yRun<T extends A11yRunLike>(
  runs: readonly T[],
  testId: string,
): T | null {
  const checked = runs
    .filter((r) => r.testId === testId && ((r.a11yMs ?? 0) > 0 || (r.a11yChecks ?? 0) > 0))
    .sort((a, b) => b.startedAt - a.startedAt);
  return checked[0] ?? null;
}
