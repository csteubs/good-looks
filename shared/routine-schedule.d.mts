// Types for routine-schedule.mjs.
//
// Hand-written, like the other `shared/*.d.mts`: the implementation is plain
// ESM so the standalone MCP server can import it without a build step, and this
// file is what keeps `npm run type-check` a real gate over every TypeScript
// caller.

import type { Routine, RoutineSchedule } from "../main/recorder/types.js";

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

/** Should this Routine fire now, in a session that began at
 *  `sessionStartedAt`? The session bound is what keeps the timer and the
 *  catch-up from firing the same occurrence — see the implementation. */
export declare function firesNow(
  routine: Routine | null | undefined,
  sessionStartedAt: number,
  now: number,
): boolean;

/** Routines with an occurrence missed while the app was closed. ONE per
 *  Routine, not one per missed occurrence. */
export declare function missedRoutines(
  routines: readonly Routine[] | null | undefined,
  now: number,
): Routine[];

export declare function describeSchedule(
  schedule: RoutineSchedule | null | undefined,
): string;

export declare function formatMinute(minute: number): string;
