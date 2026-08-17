// Types for routine-schedule.mjs.
//
// Hand-written, like the other `shared/*.d.mts`: the implementation is plain
// ESM so the standalone MCP server can import it without a build step, and this
// file is what keeps `npm run type-check` a real gate over every TypeScript
// caller.

import type { Routine, RoutineSchedule } from "../main/recorder/types.js";

/** Interval steps in MINUTES. All divide a day evenly. */
export declare const INTERVAL_STEPS: readonly number[];

export declare const SCHEDULE_KINDS: readonly RoutineSchedule["kind"][];

export declare const SCHEDULE_CAVEAT: string;

/** How far ahead a one-off may be set. */
export declare const ONCE_HORIZON_YEARS: number;

export declare function normalizeSchedule(raw: unknown): RoutineSchedule | null;

/** The last instant a one-off may be set to, from `now`. A CALENDAR span — see
 *  the implementation. */
export declare function onceHorizonEnd(now: number): number;

/** May a one-off be SET to this instant? Takes `now` because it is a question
 *  about the future, and is asked by the picker rather than by
 *  `normalizeSchedule` — a spent one-off is not invalid. */
export declare function withinOnceHorizon(at: number, now: number): boolean;

/** The first occurrence strictly after `after`, or null when the schedule is
 *  not one — or is a one-off whose moment has passed. */
export declare function nextOccurrence(
  schedule: RoutineSchedule | null | undefined,
  after: number,
): number | null;

/** `lastRunAt` is when this SCHEDULE last fired, not when the Routine last
 *  ran. A one-off has its own branch — see the implementation. */
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

/** `YYYY-MM-DD`, local. */
export declare function formatDate(ts: number): string;

/** An interval step as the picker spells it: `5m`, `1h`, `24h`. */
export declare function formatInterval(minutes: number): string;
