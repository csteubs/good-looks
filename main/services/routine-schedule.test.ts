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

import { describe, it, expect } from "vitest";

import type { Routine, RoutineSchedule } from "../recorder/types.js";
import {
  describeSchedule,
  firesNow,
  missedRoutines,
  formatMinute,
  HOUR_STEPS,
  isDue,
  nextOccurrence,
  normalizeSchedule,
  SCHEDULE_CAVEAT,
} from "../../shared/routine-schedule.mjs";

/** A local timestamp, spelled out so a failure reads as a time rather than a
 *  number. Month is 0-based, as `Date` has it. */
function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo, d, h, mi).getTime();
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
    expect(normalizeSchedule({ kind: "everyHours", hours: 4 })).toEqual({
      kind: "everyHours",
      hours: 4,
    });
    expect(normalizeSchedule({ kind: "dailyAt", minute: 570 })).toEqual({
      kind: "dailyAt",
      minute: 570,
    });
    expect(normalizeSchedule({ kind: "weekdaysAt", minute: 0 })).toEqual({
      kind: "weekdaysAt",
      minute: 0,
    });
  });

  it("REFUSES an hour step that does not divide the day, rather than rounding it", () => {
    // Rounding 5 to 4 or 6 silently runs the suite on a cadence nobody chose,
    // and the screen would show the rounded value as though it had been picked.
    expect(normalizeSchedule({ kind: "everyHours", hours: 5 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyHours", hours: 0 })).toBeNull();
    expect(normalizeSchedule({ kind: "everyHours", hours: 25 })).toBeNull();
    expect(HOUR_STEPS.every((h) => 24 % h === 0)).toBe(true);
  });

  it("refuses a minute outside the day, and a fractional one", () => {
    expect(normalizeSchedule({ kind: "dailyAt", minute: -1 })).toBeNull();
    expect(normalizeSchedule({ kind: "dailyAt", minute: 1440 })).toBeNull();
    expect(normalizeSchedule({ kind: "dailyAt", minute: 90.5 })).toBeNull();
    expect(normalizeSchedule({ kind: "dailyAt", minute: "540" })).toBeNull();
  });

  it("refuses a kind that is not built and anything that is not an object", () => {
    expect(normalizeSchedule({ kind: "monthlyOn", day: 1 })).toBeNull();
    expect(normalizeSchedule(null)).toBeNull();
    expect(normalizeSchedule("dailyAt")).toBeNull();
    expect(normalizeSchedule([])).toBeNull();
  });
});

describe("every N hours", () => {
  const every4: RoutineSchedule = { kind: "everyHours", hours: 4 };

  it("is anchored to local midnight, not to the last run", () => {
    // Anchoring to the last run makes the cadence drift a little every time a
    // run is slow, so the job that started at 09:00 on Monday is running at
    // 11:20 by Thursday and nobody can say why.
    expect(show(nextOccurrence(every4, at(2026, 7, 12, 9, 17)))).toBe("2026-08-12 12:00");
    expect(show(nextOccurrence(every4, at(2026, 7, 12, 12, 1)))).toBe("2026-08-12 16:00");
  });

  it("rolls over midnight rather than stopping at the end of the day", () => {
    expect(show(nextOccurrence(every4, at(2026, 7, 12, 22, 30)))).toBe("2026-08-13 00:00");
  });

  it("is STRICTLY after, so a run that just fired is not immediately due again", () => {
    // With a one-hour step and a run that takes under a minute, "at or after"
    // fires the same occurrence twice.
    const hourly: RoutineSchedule = { kind: "everyHours", hours: 1 };
    const onTheHour = at(2026, 7, 12, 9, 0);
    expect(show(nextOccurrence(hourly, onTheHour))).toBe("2026-08-12 10:00");
  });

  it("treats 24 as once a day at midnight", () => {
    const daily: RoutineSchedule = { kind: "everyHours", hours: 24 };
    expect(show(nextOccurrence(daily, at(2026, 7, 12, 9, 0)))).toBe("2026-08-13 00:00");
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
    expect(isDue({ kind: "everyHours", hours: 5 }, at(2026, 7, 1), at(2026, 7, 12))).toBe(false);
  });

  it("reports one missed occurrence, not the several that piled up", () => {
    // The app was closed for a week. `isDue` is a yes/no, and the catch-up it
    // feeds offers ONE run — replaying six nightly runs on launch is a machine
    // nobody can use, and five of the six would test the same commit anyway.
    const lastRun = at(2026, 7, 5, 9, 30);
    expect(isDue(at0930, lastRun, at(2026, 7, 12, 10, 0))).toBe(true);
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
        routine({ schedule: { kind: "everyHours", hours: 5 } as RoutineSchedule }),
        0,
        at(2026, 7, 12, 23, 0),
      ),
    ).toBe(false);
    expect(firesNow(null, 0, 1)).toBe(false);
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
    expect(describeSchedule({ kind: "everyHours", hours: 4 })).toBe("Every 4 hours");
    expect(describeSchedule({ kind: "everyHours", hours: 24 })).toBe("Every day at midnight");
    expect(describeSchedule({ kind: "dailyAt", minute: 9 * 60 + 5 })).toBe("Every day at 09:05");
    expect(describeSchedule({ kind: "weekdaysAt", minute: 17 * 60 })).toBe("Weekdays at 17:00");
  });

  it("says a Routine is not scheduled rather than saying nothing", () => {
    expect(describeSchedule(undefined)).toBe("Not scheduled");
    expect(describeSchedule({ kind: "everyHours", hours: 5 })).toBe("Not scheduled");
  });

  it("zero-pads both halves, so the picker and the readout spell a time once", () => {
    expect(formatMinute(0)).toBe("00:00");
    expect(formatMinute(9 * 60 + 5)).toBe("09:05");
    expect(formatMinute(23 * 60 + 59)).toBe("23:59");
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
