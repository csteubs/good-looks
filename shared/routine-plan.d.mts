// Types for routine-plan.mjs.
//
// Hand-written, like the other `shared/*.d.mts`: the implementation is plain
// ESM so the standalone MCP server can import it without a build step, and this
// file is what keeps `npm run type-check` a real gate over every TypeScript
// caller.
//
// `perTest` is declared as the batch runner's own entry shape on purpose — the
// plan is a TRANSLATION into that payload, and typing it as anything looser
// would let the two drift silently, which is the whole failure this module
// exists to avoid.

import type { Routine, RunBrowser } from "../main/recorder/types.js";

export declare const PLAN_BROWSERS: readonly RunBrowser[];

export interface RoutinePerTest {
  testId: string;
  browsers: RunBrowser[];
  headless: boolean;
}

export interface RoutineRunPlan {
  testIds: string[];
  perTest: RoutinePerTest[];
  plannedRuns: number;
  /** Steps that will not run: a deleted test, or one with no valid engine. */
  skipped: string[];
  captureArtifacts: boolean;
  concurrency: number;
}

export interface RoutinePlanOptions {
  /** Force every step headless, whatever the step says. Set for a SCHEDULED
   *  run: a window that steals focus while somebody is working is the fastest
   *  way to have scheduling turned off. */
  forceHeadless?: boolean;
}

export declare function routineRunPlan(
  routine: Routine | null | undefined,
  knownTestIds: readonly string[] | null,
  options?: RoutinePlanOptions,
): RoutineRunPlan;

export declare function routineBlockedReason(plan: RoutineRunPlan | null): string | null;
