// When a Routine is due. docs/ROUTINES.md capability 2.
//
// LIVES HERE RATHER THAN BESIDE `shared/routine-schedule.mjs`: vitest's `node`
// project globs `main/**/*.test.ts`, so a test under `shared/` matches NEITHER
// project and passes by never running.
//
// EVERY CASE IS A CLOCK QUESTION, and clock questions are where a scheduler
// goes wrong silently: it fires twice, or drifts, or never fires at all, and
// none of those throws. Times are built with `new Date(y, m, d, h, m)` — LOCAL,
// deliberately, because that is what the user set and what the picker shows.

import { afterAll, beforeAll, describe, it, expect } from "vitest";

import type { Routine, RoutineSchedule } from "../recorder/types.js";
import {
  describeSchedule,
  firesNow,
  formatDate,
  formatInterval,
  formatMinute,
  INTERVAL_STEPS,
  isDue,
  missedRoutines,
  nextOccurrence,
  normalizeSchedule,
  onceHorizonEnd,
  ONCE_HORIZON_YEARS,
  SCHEDULE_CAVEAT,
  withinOnceHorizon,
} from "../../shared/routine-schedule.mjs";

/** A local timestamp, spelled out so a failure reads as a time rather than a
 *  number. Month is 0-based, as `Date` has it. */
function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo, d, h, mi).getTime();
}

/** The shape a schedule had before sub-hour cadences retired it. It has no
 *  type any more — that is what "migrated" means — so the cast is spelled here
 *  once rather than at each call, and only where a TYPED caller is under test.
 *  `normalizeSchedule` takes `unknown`, so its own cases need none. */
function legacyHours(hours: number): RoutineSchedule {
  return { kind: "everyHours", hours } as unknown as RoutineSchedule;
}

function show(ms: number | null): string {
  if (ms === null) return "none";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${formatMinute(d.getHours() * 60 + d.getMinutes())}`;
}

describe("normalizing what a picker can produce", () => {
  it("keeps a valid schedule of each kind", () => {
    expect(normalizeSchedule({ kind: "everyMinutes", minutes: 240 })).toEqual({
      kind: "everyMinutes",
      minutes: 240,
    });
    expect(normalizeSchedule({ kind: "dailyAt", minute: 570 })).toEqual({
      kind: "dailyAt",
      minute: 570,
    });
    expect(normalizeSchedule({ kind: "weekdaysAt", minute: 0 })).toEqual({
      kind: "weekdaysAt",
      minute: 0,
    });
    expect(normalizeSchedule({ kind: "onceAt", at: at(2027, 2, 14, 9, 0) })).toEqual({
      kind: "onceAt",
      at: at(2027, 2, 14, 9, 0),
    });
  });

  it("REFUSES a step that does not divide the day, rather than rounding it", () => {
    // Rounding 300 to 240 or 360 silently runs the suite on a cadence nobody
    // chose, and the screen would show the rounded value as though it had been
    // picked.
    expect(normalizeSchedule({ kind: "everyMinutes", minutes: 300 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyMinutes", minutes: 0 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyMinutes", minutes: 7 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyMinutes", minutes: 1441 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyMinutes", minutes: 90.5 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyMinutes", minutes: "60" })).toBeNull();
    expect(INTERVAL_STEPS.every((m) => 1440 % m === 0)).toBe(true);
  });

  it("migrates the hour-based shape it replaced, EXACTLY", () => {
    // A file written before sub-hour cadences existed is still on disk, and the
    // store re-normalizes on every read. Dropping it would silently unschedule
    // every Routine somebody already had.
    expect(normalizeSchedule({ kind: "everyHours", hours: 4 })).toEqual({
      kind: "everyMinutes",
      minutes: 240,
    });
    expect(normalizeSchedule({ kind: "everyHours", hours: 1 })).toEqual({
      kind: "everyMinutes",
      minutes: 60,
    });
    expect(normalizeSchedule({ kind: "everyHours", hours: 24 })).toEqual({
      kind: "everyMinutes",
      minutes: 1440,
    });
  });

  it("holds the migrated shape to the same table, so a bad old value stays bad", () => {
    expect(normalizeSchedule({ kind: "everyHours", hours: 5 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyHours", hours: 0 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyHours", hours: 25 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyHours", hours: "4" })).toBeNull();
  });

  it("refuses a minute outside the day, and a fractional one", () => {
    expect(normalizeSchedule({ kind: "dailyAt", minute: -1 })).toBeNull();
    expect(normalizeSchedule({ kind: "dailyAt", minute: 1440 })).toBeNull();
    expect(normalizeSchedule({ kind: "dailyAt", minute: 90.5 })).toBeNull();
    expect(normalizeSchedule({ kind: "dailyAt", minute: "540" })).toBeNull();
  });

  it("refuses a one-off instant that is not one", () => {
    // Structural only — this function is deliberately clockless, so "already
    // passed" is NOT its business. A spent one-off is a record of a run that
    // happened, and a normalizer that dropped it would erase that.
    expect(normalizeSchedule({ kind: "onceAt", at: "tomorrow" })).toBeNull();
    expect(normalizeSchedule({ kind: "onceAt", at: 1.5 })).toBeNull();
    expect(normalizeSchedule({ kind: "onceAt", at: Number.NaN })).toBeNull();
    expect(normalizeSchedule({ kind: "onceAt", at: 0 })).toBeNull();
    expect(normalizeSchedule({ kind: "onceAt" })).toBeNull();
    expect(normalizeSchedule({ kind: "onceAt", at: at(1998, 0, 1) })).toBeNull();
    expect(normalizeSchedule({ kind: "onceAt", at: at(2200, 0, 1) })).toBeNull();
  });

  it("keeps a one-off whose moment has already passed", () => {
    const past = at(2020, 0, 1, 9, 0);
    expect(normalizeSchedule({ kind: "onceAt", at: past })).toEqual({ kind: "onceAt", at: past });
  });

  it("refuses a kind that is not built and anything that is not an object", () => {
    expect(normalizeSchedule({ kind: "monthlyOn", day: 1 })).toBeNull();
    expect(normalizeSchedule(null)).toBeNull();
    expect(normalizeSchedule("dailyAt")).toBeNull();
    expect(normalizeSchedule([])).toBeNull();
  });
});

describe("on an interval", () => {
  const every4h: RoutineSchedule = { kind: "everyMinutes", minutes: 240 };

  it("is anchored to local midnight, not to the last run", () => {
    // Anchoring to the last run makes the cadence drift a little every time a
    // run is slow, so the job that started at 09:00 on Monday is running at
    // 11:20 by Thursday and nobody can say why.
    expect(show(nextOccurrence(every4h, at(2026, 7, 12, 9, 17)))).toBe("2026-08-12 12:00");
    expect(show(nextOccurrence(every4h, at(2026, 7, 12, 12, 1)))).toBe("2026-08-12 16:00");
  });

  it("rolls over midnight rather than stopping at the end of the day", () => {
    expect(show(nextOccurrence(every4h, at(2026, 7, 12, 22, 30)))).toBe("2026-08-13 00:00");
  });

  it("is STRICTLY after, so a run that just fired is not immediately due again", () => {
    // With a five-minute step and a run that takes under a minute, "at or
    // after" fires the same occurrence twice.
    const hourly: RoutineSchedule = { kind: "everyMinutes", minutes: 60 };
    expect(show(nextOccurrence(hourly, at(2026, 7, 12, 9, 0)))).toBe("2026-08-12 10:00");
    const every5: RoutineSchedule = { kind: "everyMinutes", minutes: 5 };
    expect(show(nextOccurrence(every5, at(2026, 7, 12, 9, 5)))).toBe("2026-08-12 09:10");
  });

  it("lands on the sub-hour grid the step describes", () => {
    // The whole point of the rebuild: below an hour, the anchor still has to
    // produce a grid a person can predict from the chip they pressed.
    const every5: RoutineSchedule = { kind: "everyMinutes", minutes: 5 };
    expect(show(nextOccurrence(every5, at(2026, 7, 12, 9, 2)))).toBe("2026-08-12 09:05");
    const every15: RoutineSchedule = { kind: "everyMinutes", minutes: 15 };
    expect(show(nextOccurrence(every15, at(2026, 7, 12, 9, 2)))).toBe("2026-08-12 09:15");
    expect(show(nextOccurrence(every15, at(2026, 7, 12, 9, 46)))).toBe("2026-08-12 10:00");
    const every30: RoutineSchedule = { kind: "everyMinutes", minutes: 30 };
    expect(show(nextOccurrence(every30, at(2026, 7, 12, 23, 45)))).toBe("2026-08-13 00:00");
  });

  it("treats a full day as once a day at midnight", () => {
    const daily: RoutineSchedule = { kind: "everyMinutes", minutes: 1440 };
    expect(show(nextOccurrence(daily, at(2026, 7, 12, 9, 0)))).toBe("2026-08-13 00:00");
  });

  it("never returns an occurrence that is not strictly ahead, on any step", () => {
    // The property, rather than a sample of it: every step, asked from a
    // handful of awkward moments, must answer with something later. An
    // occurrence equal to `after` is one that fires forever.
    for (const minutes of INTERVAL_STEPS) {
      for (const from of [
        at(2026, 7, 12, 0, 0),
        at(2026, 7, 12, 9, 17),
        at(2026, 7, 12, 23, 59),
      ]) {
        const next = nextOccurrence({ kind: "everyMinutes", minutes } as RoutineSchedule, from);
        expect(next).not.toBeNull();
        expect(next as number).toBeGreaterThan(from);
      }
    }
  });
});

describe("an interval across a clock change", () => {
  // TZ IS SET FOR REAL, because the property under test does not exist in UTC —
  // where these tests otherwise run, every day is 24 hours and both the right
  // and the wrong arithmetic agree. A vacuous version of this test would pass
  // against the bug it exists to catch.
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "Europe/London";
  });
  afterAll(() => {
    // `process.env.TZ = undefined` assigns the STRING "undefined", which Node
    // reads as an unknown zone and falls back to UTC — for the REST OF THE
    // FILE. The tests below this block then build their `at(...)` moments in
    // UTC while the `const`s beside them were built at collection time in the
    // real local zone, so a one-off at 09:00 local compares as still ahead of
    // 09:01 "local". Deleting the key is the only restore that works when
    // there was no TZ to begin with, which is the usual case on a laptop.
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("confirms the timezone actually took effect", () => {
    // Without this the three tests below could pass by testing nothing at all.
    expect(new Date(2026, 2, 29).getTimezoneOffset()).not.toBe(
      new Date(2026, 2, 30).getTimezoneOffset(),
    );
  });

  it("puts the midnight run at midnight on a 23-hour day", () => {
    // 2026-03-29 is the spring forward in London: 01:00 becomes 02:00, so the
    // day is 23 hours long. Adding 1 440 × 60 000 milliseconds to midnight —
    // which is what this used to do — lands at 01:00 the next morning, an hour
    // late, on the one schedule whose whole description is "at midnight".
    const daily: RoutineSchedule = { kind: "everyMinutes", minutes: 1440 };
    expect(show(nextOccurrence(daily, at(2026, 2, 29, 12, 0)))).toBe("2026-03-30 00:00");
  });

  it("keeps the grid on the wall clock through the jump", () => {
    const every12h: RoutineSchedule = { kind: "everyMinutes", minutes: 720 };
    expect(show(nextOccurrence(every12h, at(2026, 2, 29, 9, 0)))).toBe("2026-03-29 12:00");
  });

  it("does the same on a 25-hour day", () => {
    // 2026-10-25 is the autumn fall-back: the day is 25 hours long, so
    // millisecond arithmetic lands an hour EARLY — 23:00, which is then not
    // strictly after the next tick's own answer.
    const daily: RoutineSchedule = { kind: "everyMinutes", minutes: 1440 };
    expect(show(nextOccurrence(daily, at(2026, 9, 25, 12, 0)))).toBe("2026-10-26 00:00");
  });
});

describe("once, on a named day", () => {
  const moment = at(2027, 2, 14, 9, 0);
  const once: RoutineSchedule = { kind: "onceAt", at: moment };

  it("reports its moment while it is still ahead", () => {
    expect(nextOccurrence(once, at(2027, 2, 14, 8, 59))).toBe(moment);
  });

  it("has NO next occurrence once it has passed", () => {
    // Null already means "never again" to every caller, which is exactly what a
    // spent one-off is — so nothing downstream needs a new case for it.
    expect(nextOccurrence(once, moment)).toBeNull();
    expect(nextOccurrence(once, at(2027, 2, 14, 9, 1))).toBeNull();
  });
});

describe("the three-year horizon", () => {
  const now = at(2026, 7, 17, 14, 30);

  it("reaches the same date three years on, to the end of that day", () => {
    // End of the day rather than the same time of day, or the last date on the
    // calendar would be half selectable — pickable at 09:00 and refused at
    // 18:00, for no reason the user could see.
    expect(formatDate(onceHorizonEnd(now))).toBe("2029-08-17");
    expect(withinOnceHorizon(at(2029, 7, 17, 23, 59), now)).toBe(true);
    expect(withinOnceHorizon(at(2029, 7, 18, 0, 0), now)).toBe(false);
    expect(ONCE_HORIZON_YEARS).toBe(3);
  });

  it("refuses a moment that is not ahead of now", () => {
    expect(withinOnceHorizon(now, now)).toBe(false);
    expect(withinOnceHorizon(now - 1, now)).toBe(false);
    expect(withinOnceHorizon(now + 1, now)).toBe(true);
  });

  it("refuses anything that is not a moment", () => {
    expect(withinOnceHorizon(Number.NaN, now)).toBe(false);
    expect(withinOnceHorizon(Number.POSITIVE_INFINITY, now)).toBe(false);
  });
});

describe("daily at a time", () => {
  const at0930: RoutineSchedule = { kind: "dailyAt", minute: 9 * 60 + 30 };

  it("takes today's slot when it is still ahead", () => {
    expect(show(nextOccurrence(at0930, at(2026, 7, 12, 8, 0)))).toBe("2026-08-12 09:30");
  });

  it("rolls to tomorrow once today's has passed", () => {
    expect(show(nextOccurrence(at0930, at(2026, 7, 12, 9, 31)))).toBe("2026-08-13 09:30");
  });

  it("does not re-fire the occurrence it just ran", () => {
    expect(show(nextOccurrence(at0930, at(2026, 7, 12, 9, 30)))).toBe("2026-08-13 09:30");
  });
});

describe("weekdays at a time", () => {
  const weekdays: RoutineSchedule = { kind: "weekdaysAt", minute: 8 * 60 };

  it("skips the weekend", () => {
    // 2026-08-14 is a Friday. After Friday's slot the next is Monday's.
    const friday = at(2026, 7, 14, 9, 0);
    expect(new Date(friday).getDay()).toBe(5);
    expect(show(nextOccurrence(weekdays, friday))).toBe("2026-08-17 08:00");
  });

  it("takes Monday's slot when asked on a Sunday", () => {
    const sunday = at(2026, 7, 16, 12, 0);
    expect(new Date(sunday).getDay()).toBe(0);
    expect(show(nextOccurrence(weekdays, sunday))).toBe("2026-08-17 08:00");
  });

  it("takes today when today is a weekday and the slot is ahead", () => {
    const tuesday = at(2026, 7, 11, 6, 0);
    expect(new Date(tuesday).getDay()).toBe(2);
    expect(show(nextOccurrence(weekdays, tuesday))).toBe("2026-08-11 08:00");
  });
});

describe("whether an occurrence has been missed", () => {
  const at0930: RoutineSchedule = { kind: "dailyAt", minute: 9 * 60 + 30 };

  it("is NOT due when the schedule has never fired", () => {
    // A schedule set five minutes ago has missed nothing. Treating "never
    // fired" as "overdue" would run every suite the moment its schedule saved.
    expect(isDue(at0930, undefined, at(2026, 7, 12, 23, 0))).toBe(false);
  });

  it("is due once an occurrence has passed since the last fire", () => {
    const lastRun = at(2026, 7, 11, 9, 30);
    expect(isDue(at0930, lastRun, at(2026, 7, 12, 10, 0))).toBe(true);
  });

  it("is not due before the next occurrence arrives", () => {
    const lastRun = at(2026, 7, 12, 9, 30);
    expect(isDue(at0930, lastRun, at(2026, 7, 12, 23, 0))).toBe(false);
  });

  it("is not due for a Routine with no schedule at all", () => {
    expect(isDue(undefined, at(2026, 7, 1), at(2026, 7, 12))).toBe(false);
    expect(isDue({ kind: "everyMinutes", minutes: 300 }, at(2026, 7, 1), at(2026, 7, 12))).toBe(
      false,
    );
  });

  it("reports one missed occurrence, not the several that piled up", () => {
    // The app was closed for a week. `isDue` is a yes/no, and the catch-up it
    // feeds offers ONE run — replaying six nightly runs on launch is a machine
    // nobody can use, and five of the six would test the same commit anyway.
    const lastRun = at(2026, 7, 5, 9, 30);
    expect(isDue(at0930, lastRun, at(2026, 7, 12, 10, 0))).toBe(true);
  });
});

describe("whether a one-off has been missed", () => {
  // THE ONE PLACE THE "NEVER FIRED MEANS NOTHING IS OWED" RULE HAD TO BEND, and
  // the reason it had to: that rule is right for a cadence — setting one must
  // not run the suite on the spot — and wrong for a named moment. The user
  // picked a day. If the app was shut on that day the run IS owed, and the
  // recurring search says the opposite, because a spent one-off has no next
  // occurrence at all. Without this branch the occurrence is silently dropped,
  // which is the single thing the launch catch-up exists to prevent.
  const moment = at(2026, 7, 14, 9, 0);
  const once: RoutineSchedule = { kind: "onceAt", at: moment };

  it("is not due before its moment", () => {
    expect(isDue(once, undefined, at(2026, 7, 14, 8, 59))).toBe(false);
  });

  it("IS due once its moment has passed and it has never fired", () => {
    expect(isDue(once, undefined, moment)).toBe(true);
    expect(isDue(once, undefined, at(2026, 7, 20, 12, 0))).toBe(true);
  });

  it("is not due again once it has fired", () => {
    expect(isDue(once, moment, at(2026, 7, 20, 12, 0))).toBe(false);
    expect(isDue(once, at(2026, 7, 14, 9, 1), at(2026, 7, 20, 12, 0))).toBe(false);
  });

  it("ignores a fire stamped BEFORE the moment it names", () => {
    // That stamp belongs to a schedule the user has since changed — they moved
    // the date forward, and the old fire must not cancel the new one.
    expect(isDue(once, at(2026, 7, 1, 9, 0), at(2026, 7, 20, 12, 0))).toBe(true);
  });

  it("is claimed by the catch-up, which is what makes the caveat true", () => {
    const routine: Routine = {
      id: "r-once",
      name: "Release day",
      createdAt: 1,
      updatedAt: 1,
      steps: [],
      defaults: { captureArtifacts: false, concurrency: 1 },
      schedule: once,
    };
    expect(missedRoutines([routine], at(2026, 7, 20, 12, 0))).toHaveLength(1);
    expect(missedRoutines([routine], at(2026, 7, 14, 8, 0))).toHaveLength(0);
  });
});

describe("which occurrence belongs to the timer, and which to the catch-up", () => {
  const at0930: RoutineSchedule = { kind: "dailyAt", minute: 9 * 60 + 30 };

  function routine(over: Partial<Routine> = {}): Routine {
    return {
      id: "r-1",
      name: "Nightly",
      createdAt: 1,
      updatedAt: 1,
      steps: [],
      defaults: { captureArtifacts: false, concurrency: 1 },
      schedule: at0930,
      ...over,
    };
  }

  it("fires an occurrence that arrives while the app is open", () => {
    const opened = at(2026, 7, 12, 9, 0);
    expect(firesNow(routine(), opened, at(2026, 7, 12, 9, 31))).toBe(true);
  });

  it("does not fire before the occurrence arrives", () => {
    const opened = at(2026, 7, 12, 9, 0);
    expect(firesNow(routine(), opened, at(2026, 7, 12, 9, 29))).toBe(false);
  });

  it("does NOT fire an occurrence missed while the app was closed", () => {
    // THE BUG THIS BOUND EXISTS FOR. Without it: the catch-up offers the missed
    // run, the user declines, and sixty seconds later the timer runs it anyway.
    const missedYesterday = routine({ lastScheduledRunAt: at(2026, 7, 11, 9, 30) });
    const opened = at(2026, 7, 12, 14, 0);
    expect(firesNow(missedYesterday, opened, at(2026, 7, 12, 14, 1))).toBe(false);
    // …and the catch-up is the half that DOES claim it.
    expect(missedRoutines([missedYesterday], at(2026, 7, 12, 14, 1))).toHaveLength(1);
  });

  it("does not fire an occurrence it has already run this session", () => {
    const opened = at(2026, 7, 12, 9, 0);
    const justRan = routine({ lastScheduledRunAt: at(2026, 7, 12, 9, 30) });
    expect(firesNow(justRan, opened, at(2026, 7, 12, 9, 31))).toBe(false);
  });

  it("never fires a Routine with no schedule, or an unusable one", () => {
    expect(firesNow(routine({ schedule: undefined }), 0, at(2026, 7, 12, 23, 0))).toBe(false);
    expect(
      firesNow(
        routine({ schedule: { kind: "everyMinutes", minutes: 300 } as RoutineSchedule }),
        0,
        at(2026, 7, 12, 23, 0),
      ),
    ).toBe(false);
    expect(firesNow(null, 0, 1)).toBe(false);
  });

  it("fires a one-off whose moment arrives during the session, exactly once", () => {
    // No new code in `firesNow` for this, which is the point of storing a
    // one-off as an instant: the session bound already sorts it. The second
    // assertion is the one that matters — a Routine that stamped its fire is
    // then permanently done, rather than firing on every tick after its date.
    const moment = at(2026, 7, 12, 10, 0);
    const opened = at(2026, 7, 12, 9, 0);
    const oneOff = routine({ schedule: { kind: "onceAt", at: moment } });
    expect(firesNow(oneOff, opened, at(2026, 7, 12, 10, 1))).toBe(true);
    expect(
      firesNow({ ...oneOff, lastScheduledRunAt: moment }, opened, at(2026, 7, 12, 10, 1)),
    ).toBe(false);
  });

  it("leaves a one-off missed while the app was closed to the catch-up", () => {
    const moment = at(2026, 7, 11, 10, 0);
    const opened = at(2026, 7, 12, 9, 0);
    const oneOff = routine({ schedule: { kind: "onceAt", at: moment } });
    expect(firesNow(oneOff, opened, at(2026, 7, 12, 9, 1))).toBe(false);
    expect(missedRoutines([oneOff], at(2026, 7, 12, 9, 1))).toHaveLength(1);
  });

  it("reports one missed Routine per Routine, not one per missed occurrence", () => {
    // The app shut for a week does not owe seven nightly runs: six would test a
    // commit that has been superseded, and replaying them is a machine nobody
    // can use. What is owed is "this has not run since Tuesday".
    const stale = routine({ lastScheduledRunAt: at(2026, 7, 5, 9, 30) });
    expect(missedRoutines([stale], at(2026, 7, 12, 10, 0))).toHaveLength(1);
  });

  it("reports nothing missed for a schedule that has never fired", () => {
    expect(missedRoutines([routine()], at(2026, 7, 12, 23, 0))).toEqual([]);
    expect(missedRoutines(null, 1)).toEqual([]);
  });
});

describe("what the schedule says in words", () => {
  it("reads back each kind", () => {
    expect(describeSchedule({ kind: "everyMinutes", minutes: 5 })).toBe("Every 5 minutes");
    expect(describeSchedule({ kind: "everyMinutes", minutes: 30 })).toBe("Every 30 minutes");
    expect(describeSchedule({ kind: "everyMinutes", minutes: 60 })).toBe("Every hour");
    expect(describeSchedule({ kind: "everyMinutes", minutes: 240 })).toBe("Every 4 hours");
    expect(describeSchedule({ kind: "everyMinutes", minutes: 1440 })).toBe("Every day at midnight");
    expect(describeSchedule({ kind: "dailyAt", minute: 9 * 60 + 5 })).toBe("Every day at 09:05");
    expect(describeSchedule({ kind: "weekdaysAt", minute: 17 * 60 })).toBe("Weekdays at 17:00");
    expect(describeSchedule({ kind: "onceAt", at: at(2027, 2, 14, 9, 0) })).toBe(
      "Once on 2027-03-14 at 09:00",
    );
  });

  it("reads a migrated schedule back in the new vocabulary", () => {
    // The chip is regenerated from what is STORED, so an old file has to read
    // as something, and "Not scheduled" beside a job that still fires would be
    // the worst of the options.
    expect(describeSchedule(legacyHours(4))).toBe("Every 4 hours");
    expect(describeSchedule(legacyHours(24))).toBe("Every day at midnight");
  });

  it("says a Routine is not scheduled rather than saying nothing", () => {
    expect(describeSchedule(undefined)).toBe("Not scheduled");
    expect(describeSchedule({ kind: "everyMinutes", minutes: 300 })).toBe("Not scheduled");
    expect(describeSchedule(legacyHours(5))).toBe("Not scheduled");
  });

  it("reads a spent one-off as the moment it was set to, not as nothing", () => {
    // It never fires again, but the schedule is the record of what was asked
    // for. Reading it back as "Not scheduled" would leave the run in the
    // history with nothing on screen explaining why it happened.
    expect(describeSchedule({ kind: "onceAt", at: at(2020, 0, 2, 7, 30) })).toBe(
      "Once on 2020-01-02 at 07:30",
    );
  });

  it("zero-pads both halves, so the picker and the readout spell a time once", () => {
    expect(formatMinute(0)).toBe("00:00");
    expect(formatMinute(9 * 60 + 5)).toBe("09:05");
    expect(formatMinute(23 * 60 + 59)).toBe("23:59");
  });

  it("spells a date the same way wherever it is read", () => {
    // "03/04" is two different days depending on who is reading it, and this
    // string reaches the chip, the missed-run prompt and the MCP.
    expect(formatDate(at(2027, 2, 4, 23, 59))).toBe("2027-03-04");
    expect(formatDate(at(2027, 11, 31))).toBe("2027-12-31");
  });

  it("spells an interval the way the chip that sets it does", () => {
    expect(formatInterval(5)).toBe("5m");
    expect(formatInterval(30)).toBe("30m");
    expect(formatInterval(60)).toBe("1h");
    expect(formatInterval(1440)).toBe("24h");
  });
});

describe("the caveat", () => {
  it("says the guarantee out loud", () => {
    // ROUTINES.md is explicit: the weaker guarantee has to be STATED rather
    // than implied, because promising unattended nightly runs and delivering
    // them only when the app happens to be open is worse than not offering it.
    expect(SCHEDULE_CAVEAT).toContain("only while");
    expect(SCHEDULE_CAVEAT.toLowerCase()).toContain("missed");
  });
});
