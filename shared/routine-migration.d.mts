// Types for routine-migration.mjs.
//
// Hand-written, like the other `shared/*.d.mts`: the implementation is plain
// ESM so the standalone MCP server can import it without a build step, and this
// file is what keeps `npm run type-check` a real gate over every TypeScript
// caller.
//
// The type-only imports are erased at run time, so the .mjs stays free of any
// dependency on main/. Declaring the return as `Routine` rather than `object`
// is the point: a field added to the interface with nothing produced for it
// here is a compile error instead of an `undefined` that reads as a default.

import type { RecorderSettings, Routine, RoutineTestStep } from "../main/recorder/types.js";

export declare const FAILURE_POLICIES: readonly ["continue", "stopRoutine", "skipGroup"];

export declare const MIGRATED_NAME: string;

export declare const MIGRATED_ROUTINE_ID: string;

export declare const ORPHAN_BATCH_OWNER: string;

export declare function batchBelongsToRoutine(
  batch: { routineId?: string } | null | undefined,
  routineId: string | null | undefined,
): boolean;

export declare const MIGRATED_CONCURRENCY: number;

export declare function stepsFromBatchSettings(
  order: unknown,
  options: unknown,
  knownTestIds?: readonly string[] | null,
): RoutineTestStep[];

export declare function routineFromBatchSettings(
  settings: Partial<RecorderSettings> | null | undefined,
  knownTestIds: readonly string[] | null | undefined,
  now: number,
): Routine | null;

export declare function normalizeConcurrency(raw: unknown): number;
