// The one place a test's run history becomes the colour of its status dot.
//
// Same contract as ai-debug-status.ts, for the same reason: the colour IS the
// signal, a wrong one is silent (the app works perfectly while the dot lies),
// and a mapping spread across inline ternaries is one nobody can test. So it
// lives here as pure data, and every state carries a distinct LABEL — colour
// alone is not an accessible signal and is not assertable in jsdom.
//
// Why five states rather than pass/fail. A test run across the three browsers
// is one verdict made of three outcomes, and "two of three passed" is a
// different fact from "all three failed" — a dot that flattens both to red
// tells you to go and look, when in one case you already know that Chromium is
// fine and only WebKit is not. The scale is green → red through the blends in
// renderer/ui/tokens.css.
//
// Auto-heals are on the same scale on purpose: a run that passed only because
// run-time Auto-Heal substituted locators for four steps did pass, so it is not
// yellow — but it is not the same green as a run that needed nothing, because
// the healing is the early warning that the selectors are drifting.

import type { RunRecord } from "./recorder-types";

/** Auto-heals a passing cohort may use before the dot stops being plain green.
 *  Up to and including this many is ordinary; MORE is the drift warning. */
export const HEAL_TOLERANCE = 3;

export type RunVerdict =
  /** Everything passed, on its own locators. */
  | "passed"
  /** Everything passed, but more than HEAL_TOLERANCE steps had to be healed. */
  | "healed"
  /** A minority of the cohort failed (one browser of three). */
  | "mostly-passed"
  /** A majority failed, but not all of it (two browsers of three). */
  | "mostly-failed"
  /** Every run in the cohort failed. */
  | "failed";

export interface RunVerdictTone {
  /** Tailwind background-colour class for the dot. */
  className: string;
  /** Tooltip + aria-label. Never rely on the colour by itself. */
  label: string;
}

/** The counted outcome of one cohort — what `verdictFor` decides from. */
export interface RunTally {
  passed: number;
  failed: number;
  total: number;
  healedSteps: number;
}

export function tally(runs: RunRecord[]): RunTally {
  let passed = 0;
  let healedSteps = 0;
  for (const r of runs) {
    if (r.status === "passed") passed++;
    healedSteps += r.healedSteps ?? 0;
  }
  return { passed, failed: runs.length - passed, total: runs.length, healedSteps };
}

/** Verdict for one cohort of runs, or null when there are none.
 *
 *  The two mixed states are decided by RATIO, not by a hardcoded "1 of 3": the
 *  browser picker is a set the user chooses, so a cohort can be two runs or
 *  four. A third or less failing is `mostly-passed`; more than that (but not
 *  everything) is `mostly-failed`. At the three-browser size the user actually
 *  runs, that is exactly 1-of-3 → yellow-orange and 2-of-3 → orange-red. */
export function verdictFor(runs: RunRecord[]): RunVerdict | null {
  if (runs.length === 0) return null;
  const t = tally(runs);
  if (t.failed === 0) return t.healedSteps > HEAL_TOLERANCE ? "healed" : "passed";
  if (t.passed === 0) return "failed";
  return t.failed * 3 <= t.total ? "mostly-passed" : "mostly-failed";
}

/** Green → red, through the three blend tokens.
 *
 *  The single-run labels are still "Last run passed" / "Last run failed": a
 *  one-browser run is the overwhelmingly common case and had those words before
 *  this scale existed. The mixed labels COUNT, because "some passed" is not
 *  actionable and "2 of 3 browsers passed" is. */
export function toneForVerdict(verdict: RunVerdict, t: RunTally): RunVerdictTone {
  const of = `${t.passed} of ${t.total} runs passed`;
  switch (verdict) {
    case "passed":
      return {
        className: "bg-support-green",
        label: t.total > 1 ? `All ${t.total} runs passed` : "Last run passed",
      };
    case "healed":
      return {
        className: "bg-support-green-yellow",
        label: `${t.total > 1 ? `All ${t.total} runs passed` : "Last run passed"} — ${t.healedSteps} steps auto-healed`,
      };
    case "mostly-passed":
      return { className: "bg-support-yellow-orange", label: of };
    case "mostly-failed":
      return { className: "bg-support-orange-red", label: of };
    case "failed":
      return {
        className: "bg-support-red",
        label: t.total > 1 ? `All ${t.total} runs failed` : "Last run failed",
      };
    default: {
      // Exhaustiveness guard: a new verdict without a colour is a COMPILE
      // error here, not a silent fall-through to some default tone.
      const never: never = verdict;
      throw new Error(`Unhandled run verdict: ${String(never)}`);
    }
  }
}

/** What a test's dot should say right now, from the whole run list.
 *
 *  COHORT, not "the last run": when the newest run for a test belongs to a
 *  batch, its siblings from that same batch — the other browsers — are part of
 *  the same verdict, and reading only the newest one would report whichever
 *  browser happened to finish last.
 *
 *  This is also why nothing here is sticky. The verdict is recomputed from the
 *  newest cohort every time, so a re-run that passes turns the dot green the
 *  moment its record lands, from wherever it was started — and a manual re-run
 *  that fails turns it red the same way. There is no remembered failure to
 *  clear, which is the only version of "resets on the next run" that cannot get
 *  stuck. */
export function verdictsByTest(runs: RunRecord[]): Map<string, RunVerdictTone> {
  const newest = new Map<string, RunRecord>();
  for (const r of runs) {
    const prev = newest.get(r.testId);
    if (!prev || r.startedAt > prev.startedAt) newest.set(r.testId, r);
  }
  const out = new Map<string, RunVerdictTone>();
  for (const [testId, last] of newest) {
    const cohort = last.batchId
      ? runs.filter((r) => r.testId === testId && r.batchId === last.batchId)
      : [last];
    const t = tally(cohort);
    const verdict = verdictFor(cohort);
    if (verdict) out.set(testId, toneForVerdict(verdict, t));
  }
  return out;
}
