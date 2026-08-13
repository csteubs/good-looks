// Types for routine-schedule.mjs.
//
// Hand-written, like the other `shared/*.d.mts`: the implementation is plain
// ESM so the standalone MCP server can import it without a build step, and this
// file is what keeps `npm run type-check` a real gate over every TypeScript
// caller.

import type { RoutineSchedule } from "../main/recorder/types.js";

export declare const HOUR_STEPS: readonly number[];

export declare const SCHEDULE_KINDS: readonly RoutineSchedule["kind"][];

export declare const SCHEDULE_CAVEAT: string;

export declare function normalizeSchedule(raw: unknown): RoutineSchedule | null;

/** The first occurrence strictly after `after`, or null when the schedule is
 *  not one. */
export declare function nextOccurrence(
  schedule: RoutineSchedule | null | undefined,
  after: number,
): number | null;

/** `lastRunAt` is when this SCHEDULE last fired, not when the Routine last
 *  ran — see the implementation. */
export declare function isDue(
  schedule: RoutineSchedule | null | undefined,
  lastRunAt: number | undefined,
  now: number,
): boolean;

export declare function describeSchedule(
  schedule: RoutineSchedule | null | undefined,
): string;

export declare function formatMinute(minute: number): string;
