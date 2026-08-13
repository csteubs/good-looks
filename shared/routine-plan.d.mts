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

/** A step's failure policy, normalised to one the runner acts on. Anything
 *  unrecognised — including `skipGroup`, whose groups do not exist yet —
 *  becomes `"continue"`.
 *
 *  `onFailure` is typed `unknown` DELIBERATELY. The two callers that matter are
 *  a record read off disk and an object off the IPC wire, and the whole reason
 *  this function exists is that a TypeScript type is not a runtime check.
 *  Declaring the parameter as `Partial<RoutineStep>` would make the one call
 *  site that most needs it — the `batch:run` handler — the one that has to cast
 *  around it. */
export declare function failurePolicy(
  step: { onFailure?: unknown } | null | undefined,
): "continue" | "stopRoutine" | "skipGroup";

/** Longest a single `wait` may pause a Routine: one hour. Mirrors
 *  `MAX_ROUTINE_WAIT_MS` — this module cannot import the app's types. */
export declare const MAX_WAIT_MS: number;

/** A stored wait clamped to something a run can sit through. 0 for anything
 *  that is not a usable duration, and 0 means "no barrier". */
export declare function clampWaitMs(raw: unknown): number;

export interface RoutinePerTest {
  testId: string;
  browsers: RunBrowser[];
  headless: boolean;
  /** Normalised through `failurePolicy`, never the raw stored value. */
  onFailure: "continue" | "stopRoutine" | "skipGroup";
  /** The group this step came from, absent for a top-level step. The whole of
   *  what a group means at run time: `skipGroup` needs to know which queue
   *  entries are "the rest of this group". */
  groupId?: string;
  /** Which side of the Routine's barriers this entry falls on. 0 for a Routine
   *  with no `wait` steps, which is every Routine that predates them. */
  segment: number;
}

/** A join in the Routine: everything in `afterSegment` finishes, then the run
 *  pauses for `ms`, then the next segment starts. */
export interface RoutineBarrier {
  afterSegment: number;
  ms: number;
}

export interface RoutineRunPlan {
  testIds: string[];
  perTest: RoutinePerTest[];
  /** Where the runner must join and pause. A barrier with nothing after it is
   *  dropped — it would hold the batch open past the end of the job. */
  barriers: RoutineBarrier[];
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
