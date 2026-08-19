// The due-rules for the insights report.
//
// Everything here is silent when wrong: a boundary compared with <= instead
// of < double-generates on the boundary tick, a backoff that never expires
// reads as "the feature stopped working", and a never-generated state that
// isn't due makes the enable toggle a dead switch. Timestamps are built with
// LOCAL Date constructors so the assertions hold in any timezone — the rules
// are about local calendar buckets, and so are the fixtures.

import { describe, expect, it } from "vitest";

import {
  CADENCE_PERIOD_MS,
  contentWindow,
  isDue,
  periodStart,
  RETRY_BACKOFF_MS,
} from "./insight-schedule.js";

// 2026-08-18 is a Tuesday.
const tueAfternoon = new Date(2026, 7, 18, 14, 30).getTime();

describe("periodStart", () => {
  it("daily is local midnight of the same day", () => {
    expect(periodStart("daily", tueAfternoon)).toBe(new Date(2026, 7, 18).getTime());
  });

  it("weekly is Monday 00:00 of the ISO week", () => {
    expect(periodStart("weekly", tueAfternoon)).toBe(new Date(2026, 7, 17).getTime());
  });

  it("weekly on a Sunday reaches BACK to Monday, not forward", () => {
    // getDay() is Sunday-based, and the off-by-one here silently makes every
    // Sunday its own week.
    const sunday = new Date(2026, 7, 23, 9, 0).getTime();
    expect(periodStart("weekly", sunday)).toBe(new Date(2026, 7, 17).getTime());
  });

  it("weekly on a Monday is that Monday", () => {
    const mondayNoon = new Date(2026, 7, 17, 12, 0).getTime();
    expect(periodStart("weekly", mondayNoon)).toBe(new Date(2026, 7, 17).getTime());
  });

  it("monthly is the 1st at 00:00", () => {
    expect(periodStart("monthly", tueAfternoon)).toBe(new Date(2026, 7, 1).getTime());
  });
});

describe("isDue", () => {
  const base = {
    enabled: true,
    cadence: "weekly" as const,
    lastGeneratedAt: null,
    lastAttemptAt: null,
    now: tueAfternoon,
  };

  it("disabled is never due, whatever the timestamps say", () => {
    expect(isDue({ ...base, enabled: false })).toBe(false);
  });

  it("never-generated and enabled is due — the toggle is the request", () => {
    expect(isDue(base)).toBe(true);
  });

  it("generated inside the current bucket is not due", () => {
    // Monday morning of the same week: same bucket as Tuesday afternoon.
    const mondayMorning = new Date(2026, 7, 17, 8, 0).getTime();
    expect(isDue({ ...base, lastGeneratedAt: mondayMorning })).toBe(false);
  });

  it("generated exactly at the bucket boundary belongs to the bucket", () => {
    // Pins `<` against `<=`: a report stamped at Monday 00:00.000 satisfied
    // Monday's bucket, and `<=` would generate a second one on the next tick.
    expect(isDue({ ...base, lastGeneratedAt: periodStart("weekly", tueAfternoon) })).toBe(false);
  });

  it("generated in the previous bucket is due, even one minute over", () => {
    // Sunday 23:59 vs Monday 00:05 — the boundary is the calendar, not 7×24h.
    const sundayNight = new Date(2026, 7, 16, 23, 59).getTime();
    const mondaySmallHours = new Date(2026, 7, 17, 0, 5).getTime();
    expect(
      isDue({ ...base, lastGeneratedAt: sundayNight, now: mondaySmallHours }),
    ).toBe(true);
  });

  it("a failed attempt backs the retry off, and the backoff expires", () => {
    const failedAt = tueAfternoon - RETRY_BACKOFF_MS + 60_000;
    expect(isDue({ ...base, lastAttemptAt: failedAt })).toBe(false);
    const failedLongAgo = tueAfternoon - RETRY_BACKOFF_MS;
    expect(isDue({ ...base, lastAttemptAt: failedLongAgo })).toBe(true);
  });

  it("the backoff only matters while a report is owed", () => {
    const mondayMorning = new Date(2026, 7, 17, 8, 0).getTime();
    // Not owed: a stale lastAttemptAt from last week's failure changes nothing.
    expect(
      isDue({ ...base, lastGeneratedAt: mondayMorning, lastAttemptAt: 0 }),
    ).toBe(false);
  });

  it("daily crosses at local midnight", () => {
    const lateMonday = new Date(2026, 7, 17, 23, 50).getTime();
    const earlyTuesday = new Date(2026, 7, 18, 0, 10).getTime();
    expect(
      isDue({ ...base, cadence: "daily", lastGeneratedAt: lateMonday, now: earlyTuesday }),
    ).toBe(true);
    expect(
      isDue({ ...base, cadence: "daily", lastGeneratedAt: earlyTuesday, now: earlyTuesday }),
    ).toBe(false);
  });

  it("monthly crosses on the 1st", () => {
    const julyReport = new Date(2026, 6, 28, 9, 0).getTime();
    expect(isDue({ ...base, cadence: "monthly", lastGeneratedAt: julyReport })).toBe(true);
    const augustReport = new Date(2026, 7, 2, 9, 0).getTime();
    expect(isDue({ ...base, cadence: "monthly", lastGeneratedAt: augustReport })).toBe(false);
  });
});

describe("contentWindow", () => {
  it("is the trailing period ending now — rolling, not calendar", () => {
    for (const cadence of ["daily", "weekly", "monthly"] as const) {
      const w = contentWindow(cadence, tueAfternoon);
      expect(w.until).toBe(tueAfternoon);
      expect(w.until - w.since).toBe(CADENCE_PERIOD_MS[cadence]);
    }
  });
});
