// Types for step-insights.mjs. See run-pacing.d.mts for why these are
// hand-written.

import type { StepBrowserRow, StepDurationRow } from "./metrics-query.mjs";

/** Same vocabulary as triage's cross-run signals — the same question asked of a
 *  whole history rather than one run. */
export type DivergenceVerdict =
  | "single-engine"
  | "mixed"
  | "all-engines"
  | "clean"
  /** only one engine has ever run it — not the same fact as "never failed" */
  | "insufficient";

export interface DivergentStep {
  stepId: string;
  testId: string;
  testName: string | null;
  label: string | null;
  browsers: { browser: string; runs: number; failed: number }[];
  verdict: DivergenceVerdict;
  failingBrowsers: string[];
  passingBrowsers: string[];
}

export declare function divergentSteps(rows: readonly StepBrowserRow[]): DivergentStep[];

export declare const MIN_SAMPLES_FOR_TREND: number;
export declare const SLOWDOWN_RATIO: number;

export declare function slowdowns(
  rows: readonly StepDurationRow[],
  opts?: { ratio?: number; minSamples?: number },
): StepDurationRow[];

export interface SuiteCost {
  runs: number;
  totalMs: number;
  captureMs: number;
  a11yMs: number;
  shots: number;
  bySpeed: { speed: string; runs: number; totalMs: number }[];
}

export interface CostBreakdown extends SuiteCost {
  /** capture + a11y, both measured. Excludes the speed setting — see the note
   *  in the implementation for why that is not folded in. */
  instrumentedMs: number;
  otherMs: number;
  instrumentedShare: number;
}

export declare function costBreakdown(cost: SuiteCost): CostBreakdown;
