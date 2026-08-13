// When a Routine is due. docs/ROUTINES.md, capability 2.
//
// PURE, and `now` is passed in rather than read — the rule §6.1, §6.6 and the
// weekly digest all follow. A schedule computed from a hidden clock is one no
// test can sit either side of, and "did this fire?" is the single hardest thing
// about a scheduler to be sure of.
//
// ── NOT A CRON STRING, and this is a deliberate departure from the spec ──────
//
// ROUTINES.md sketches `{ cron: string; lastRunAt?: number }`. A cron string in
// a UI needs either a cron editor — which is a project — or a text field, and a
// text field has a failure mode this feature cannot afford: a schedule that
// never fires looks EXACTLY like a schedule that is not due yet. There is no
// error, no red, nothing on screen; the user finds out days later that their
// nightly run never happened. An enumerated schedule cannot express that state,
// because every value it can hold came from a picker.
//
// The cost is expressiveness — "the 1st of every month at 03:00" is not
// sayable. That is the right trade for a local app whose scheduler only runs
// while the app is open: the useful schedules here are "a few times a day" and
// "once a day", and neither needs cron.
//
// ── EVERY-N-HOURS IS ANCHORED TO MIDNIGHT, NOT TO THE LAST RUN ──────────────
//
// "Every 4 hours" means 00:00, 04:00, 08:00 … in local time, not "four hours
// after whenever it last went". Anchoring to the last run makes the schedule
// drift a little every time a run is slow or missed, so the job that started at
// 09:00 on Monday is running at 11:20 by Thursday and nobody can say why. That
// is also why the step is constrained to divisors of 24: "every 5 hours" from
// midnight has a short day at the end, and a schedule with an irregular gap in
// it is one people stop trusting.

/** Hour steps that divide a day evenly. See the header. */
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12, 24];

export const SCHEDULE_KINDS = ["everyHours", "dailyAt", "weekdaysAt"];

const MINUTES_PER_DAY = 24 * 60;

/**
 * Rebuild a schedule, or null when there is nothing usable.
 *
 * REBUILDS rather than filters, like every other boundary in this app: a
 * schedule arrives over IPC from an editor and decides when a browser opens.
 */
export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = raw.kind;
  if (kind === "everyHours") {
    const hours = HOUR_STEPS.includes(raw.hours) ? raw.hours : null;
    // NOT clamped to the nearest step. A stored 5 is a corrupt file or a
    // caller that invented a value, and rounding it to 4 or 6 silently runs
    // the suite on a cadence nobody chose.
    return hours === null ? null : { kind, hours };
  }
  if (kind === "dailyAt" || kind === "weekdaysAt") {
    const minute = raw.minute;
    if (typeof minute !== "number" || !Number.isInteger(minute)) return null;
    if (minute < 0 || minute >= MINUTES_PER_DAY) return null;
    return { kind, minute };
  }
  return null;
}

/** Local minute-of-day for a timestamp. */
function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Midnight local, on the day `date` falls in. */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Monday–Friday, in LOCAL time — the same week the user is looking at. */
function isWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

/**
 * The first occurrence strictly after `after`.
 *
 * STRICTLY AFTER, so a schedule that has just fired does not immediately
 * report itself due again — with a one-hour step and a run that takes under a
 * minute, "at or after" would fire the same occurrence twice.
 *
 * Returns null for a schedule that is not one. DST is handled by construction:
 * `new Date(y, m, d, h, min)` normalises a local time that does not exist
 * (spring forward) to the next one that does, which is the answer a person
 * would give — the 02:30 job runs at 03:00 on the day 02:30 was skipped.
 */
export function nextOccurrence(schedule, after) {
  const s = normalizeSchedule(schedule);
  if (!s || typeof after !== "number" || !Number.isFinite(after)) return null;
  const from = new Date(after);

  if (s.kind === "everyHours") {
    const step = s.hours * 60;
    const midnight = startOfDay(from);
    const elapsed = minuteOfDay(from);
    const slotsToday = Math.floor(elapsed / step) + 1;
    const minutes = slotsToday * step;
    // Past the last slot of the day rolls to tomorrow's midnight, which is
    // what `setMinutes` beyond 1440 does anyway — spelled out because the
    // rollover is the case a reader will want to check.
    return new Date(midnight.getTime() + minutes * 60_000).getTime();
  }

  // dailyAt / weekdaysAt: today's slot if it is still ahead, else walk forward.
  // Bounded at 8 days so a schedule that can never match cannot spin — with
  // only weekday and daily kinds that is unreachable, and an unreachable
  // guard is cheaper than a hang.
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset);
    if (s.kind === "weekdaysAt" && !isWeekday(day)) continue;
    const at = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      Math.floor(s.minute / 60),
      s.minute % 60,
    ).getTime();
    if (at > after) return at;
  }
  return null;
}

/**
 * Has an occurrence been missed?
 *
 * `lastRunAt` is when this SCHEDULE last fired, not when the Routine last ran.
 * A manual run does not satisfy a schedule: the schedule is a promise about
 * time, and someone who ran the job by hand at 23:00 may well still want the
 * 23:30 occurrence — different data, different reason. Counting manual runs
 * would silently cancel scheduled ones, which is the failure this feature is
 * least able to survive.
 *
 * With no `lastRunAt` at all, NOTHING is due. A schedule set five minutes ago
 * has not missed anything, and treating "never fired" as "overdue" would run
 * every suite the moment its schedule was saved. That falls out of the search
 * rather than needing its own guard: with no last fire the search starts at
 * `now`, and `nextOccurrence` is STRICTLY after, so the answer is always in the
 * future. A second copy of the rule is the one that would rot.
 */
export function isDue(schedule, lastRunAt, now) {
  const due = nextOccurrence(schedule, typeof lastRunAt === "number" ? lastRunAt : now);
  if (due === null) return false;
  return due <= now;
}

/**
 * Should this Routine fire RIGHT NOW, in a session that started at
 * `sessionStartedAt`?
 *
 * THE SESSION BOUND IS THE WHOLE POINT, and it is what keeps the two halves of
 * this feature from fighting. A missed occurrence — one that came due while the
 * app was closed — belongs to the CATCH-UP, which offers it rather than running
 * it: a suite that seizes the machine the moment you launch the app, for a run
 * you may not want now, is how people turn scheduling off. So the timer only
 * fires occurrences that fall AFTER the session began, and the catch-up only
 * reports ones from before. No occurrence belongs to both, and neither can
 * double-fire the other's.
 *
 * Without it: the catch-up offers a missed run, the user declines, and sixty
 * seconds later the timer runs it anyway.
 */
export function firesNow(routine, sessionStartedAt, now) {
  const schedule = normalizeSchedule(routine?.schedule);
  if (!schedule) return false;
  const lastFire =
    typeof routine.lastScheduledRunAt === "number" ? routine.lastScheduledRunAt : sessionStartedAt;
  const due = nextOccurrence(schedule, lastFire);
  if (due === null) return false;
  return due <= now && due > sessionStartedAt;
}

/**
 * Occurrences missed while the app was closed, for the launch prompt.
 *
 * ONE PER ROUTINE, not one per occurrence. The app being shut for a week does
 * not mean seven nightly runs are owed — six of them would test a commit that
 * has been superseded, and replaying them all is a machine nobody can use. What
 * is owed is "this job has not run since Tuesday", and one run answers that.
 */
export function missedRoutines(routines, now) {
  return (Array.isArray(routines) ? routines : []).filter((r) =>
    isDue(r?.schedule, r?.lastScheduledRunAt, now),
  );
}

/**
 * What the schedule says, in words.
 *
 * Rendered beside the picker rather than only inside it, because the picker
 * shows what you are choosing and this says what is CHOSEN — and those are
 * the same string only until somebody changes one of them.
 */
export function describeSchedule(schedule) {
  const s = normalizeSchedule(schedule);
  if (!s) return "Not scheduled";
  if (s.kind === "everyHours") {
    return s.hours === 24 ? "Every day at midnight" : `Every ${s.hours} hours`;
  }
  const time = formatMinute(s.minute);
  return s.kind === "weekdaysAt" ? `Weekdays at ${time}` : `Every day at ${time}`;
}

/** 24-hour, zero-padded. Not locale-formatted: this string is also what the
 *  picker's own options read, and two spellings of 09:00 in one control is a
 *  control that looks broken. */
export function formatMinute(minute) {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The sentence the UI must show beside any schedule. ROUTINES.md is explicit:
 * this weaker guarantee has to be STATED rather than implied, because promising
 * unattended nightly runs and delivering them only when the app happens to be
 * open is worse than not offering the feature at all.
 *
 * Exported as a constant so the copy cannot drift between the editor, the
 * catch-up prompt and the docs.
 */
export const SCHEDULE_CAVEAT =
  "Runs only while Good Looks! is open. A missed run is offered when you next launch it.";
