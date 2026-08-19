// When an insights report is DUE, and what window it covers.
//
// Deliberately NOT `shared/routine-schedule.mjs`, and deliberately not its
// session-bound timer/catch-up split either. A Routine seizes the machine —
// browsers open, the suite runs — so its scheduler fires only occurrences that
// arrive while the app is open and OFFERS the missed ones. A report is a
// background HTTP call: the honest behaviour for a period missed while the app
// was closed is to generate it quietly at the next opportunity, which this
// module gets by making "due" a fact about calendar buckets rather than about
// the session. See routine-scheduler.ts:19-26 for the inversion this inverts.
//
// The due-rule is CALENDAR-ANCHORED (a new local day / ISO week / month has
// started since the last report) so the cadence cannot drift; the CONTENT
// window is ROLLING (the trailing period from generation time) so a catch-up
// report generated on Wednesday honestly covers Wednesday-to-Wednesday rather
// than pretending it ran on Monday. Local time throughout, like
// routine-schedule: `new Date(y, m, d)` normalises DST for free.
//
// Pure. `now` is always passed in — a boundary computed from a hidden clock is
// one no test can sit either side of.

import type { InsightsCadence } from "../../recorder/types.js";

const DAY_MS = 86_400_000;

/** The rolling content-window length per cadence. Monthly is 30 days — the
 *  window is rolling, so "the last 30 days" is the honest reading; a calendar
 *  month's variable length would buy nothing but harder comparisons. */
export const CADENCE_PERIOD_MS: Record<InsightsCadence, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

/** The digest sentences' noun per cadence ("Nothing ran this week."). */
export const CADENCE_PERIOD_LABEL: Record<InsightsCadence, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

/** How long after a FAILED attempt before another is made. An hour: long
 *  enough that a dead provider isn't probed on every tick, short enough that
 *  the report still lands the same day the provider comes back. */
export const RETRY_BACKOFF_MS = 60 * 60_000;

/**
 * The start of the calendar bucket `nowMs` falls in, local time.
 *
 * daily → local midnight; weekly → Monday 00:00 of the ISO week; monthly →
 * the 1st, 00:00. A report generated any time inside a bucket satisfies that
 * bucket, so generation drifting later in the day never drifts the schedule.
 */
export function periodStart(cadence: InsightsCadence, nowMs: number): number {
  const d = new Date(nowMs);
  if (cadence === "daily") {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  if (cadence === "weekly") {
    // getDay() is Sunday-based; (day + 6) % 7 is days since Monday.
    const back = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  }
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/**
 * Whether a report is owed right now.
 *
 * Never-generated + enabled is DUE — the inversion of routine-schedule's
 * "with no last fire, nothing is due", and deliberate: for a Routine that rule
 * stops every suite running the moment its schedule is saved, while here the
 * toggle IS the request, and a first report that arrives within a minute of
 * enabling is the feature demonstrating itself.
 *
 * `lastAttemptAt` is the last FAILED attempt (success clears the question by
 * moving `lastGeneratedAt` forward), so the second clause is the retry
 * backoff, not a rate limit on success.
 */
export function isDue(opts: {
  enabled: boolean;
  cadence: InsightsCadence;
  lastGeneratedAt: number | null;
  lastAttemptAt: number | null;
  now: number;
}): boolean {
  if (!opts.enabled) return false;
  const owed =
    opts.lastGeneratedAt === null || opts.lastGeneratedAt < periodStart(opts.cadence, opts.now);
  if (!owed) return false;
  return opts.lastAttemptAt === null || opts.now - opts.lastAttemptAt >= RETRY_BACKOFF_MS;
}

/** The rolling window a report generated at `now` covers. */
export function contentWindow(
  cadence: InsightsCadence,
  now: number,
): { since: number; until: number } {
  return { since: now - CADENCE_PERIOD_MS[cadence], until: now };
}
