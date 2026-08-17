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
// while the app is open: the useful schedules here are "on an interval", "once
// a day", and "once, on a named day", and none of them needs cron.
//
// ── AN INTERVAL IS ANCHORED TO MIDNIGHT, NOT TO THE LAST RUN ────────────────
//
// "Every 4 hours" means 00:00, 04:00, 08:00 … in local time, not "four hours
// after whenever it last went". Anchoring to the last run makes the schedule
// drift a little every time a run is slow or missed, so the job that started at
// 09:00 on Monday is running at 11:20 by Thursday and nobody can say why. That
// is also why the step is constrained to divisors of a day: "every 5 hours"
// from midnight has a short day at the end, and a schedule with an irregular
// gap in it is one people stop trusting.
//
// ── MINUTES, NOT HOURS, AND THE OLD SHAPE MIGRATES ──────────────────────────
//
// The interval used to be `{ kind: "everyHours", hours }` and floored at one
// hour. Sub-hour cadences are what retired it: a smoke suite people want on a
// fifteen-minute loop had no expressible schedule. Two kinds both meaning "on
// an interval" would be two places to forget, so `normalizeSchedule` REBUILDS
// the old shape as the new one — `hours × 60`, exact, no rounding — and every
// old value has a new spelling because `HOUR_STEPS × 60` is a subset of
// `INTERVAL_STEPS`.
//
// ── A ONE-OFF IS AN INSTANT, NOT A RULE ─────────────────────────────────────
//
// `onceAt` stores an absolute epoch-ms moment rather than a wall-clock
// description, which is what makes it answerable in one line here and what
// makes "it has already fired" a comparison rather than bookkeeping. Its
// horizon — three years — needs a clock, so it lives in `withinOnceHorizon`
// rather than in `normalizeSchedule`, which is deliberately clockless. The
// structural check here is only that the instant is a real one.

/** Interval steps, in minutes. All divide a day evenly — see the header. */
export const INTERVAL_STEPS = [5, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];

export const SCHEDULE_KINDS = ["everyMinutes", "dailyAt", "weekdaysAt", "onceAt"];

const MINUTES_PER_DAY = 24 * 60;

/** How far ahead a one-off may be set. Three years is not a technical limit —
 *  it is the point past which "run this on that day" stops being a plan and
 *  starts being a note the user will never see again. */
export const ONCE_HORIZON_YEARS = 3;

/** Structural bounds on a stored one-off instant. NOT the horizon — this is
 *  only "is that a real moment", asked without a clock so that
 *  `normalizeSchedule` stays pure of one. A stored schedule outside this is a
 *  corrupt file, not an expired plan. */
const ONCE_MIN_AT = Date.UTC(2000, 0, 1);
const ONCE_MAX_AT = Date.UTC(2100, 0, 1);

/**
 * Rebuild a schedule, or null when there is nothing usable.
 *
 * REBUILDS rather than filters, like every other boundary in this app: a
 * schedule arrives over IPC from an editor and decides when a browser opens.
 */
export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = raw.kind;
  if (kind === "everyMinutes" || kind === "everyHours") {
    // The legacy shape converts EXACTLY — `hours × 60` — and is then held to
    // the same table as a new one. NOT clamped to the nearest step in either
    // spelling: a stored 5 hours is a corrupt file or a caller that invented a
    // value, and rounding it to 4 or 6 silently runs the suite on a cadence
    // nobody chose.
    const minutes = kind === "everyHours" ? asInt(raw.hours) * 60 : asInt(raw.minutes);
    return INTERVAL_STEPS.includes(minutes) ? { kind: "everyMinutes", minutes } : null;
  }
  if (kind === "dailyAt" || kind === "weekdaysAt") {
    const minute = raw.minute;
    if (typeof minute !== "number" || !Number.isInteger(minute)) return null;
    if (minute < 0 || minute >= MINUTES_PER_DAY) return null;
    return { kind, minute };
  }
  if (kind === "onceAt") {
    const at = raw.at;
    if (typeof at !== "number" || !Number.isInteger(at)) return null;
    if (at < ONCE_MIN_AT || at > ONCE_MAX_AT) return null;
    return { kind, at };
  }
  return null;
}

/** An integer, or NaN — which no step is, so the caller's `includes` rejects
 *  it without a second guard. */
function asInt(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : NaN;
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
 * The last instant a one-off may be set to, from `now`.
 *
 * A CALENDAR SPAN, not 1095 days: the user picks a DATE off a month grid, and
 * "three years out" on a calendar is the same day-of-month three years on. The
 * 29th of February normalises to the 1st of March by the same construction that
 * handles a clock hour that does not exist, which is the answer a person would
 * give.
 *
 * End of that day rather than the same time of day, so the last day on the
 * calendar is selectable at any hour rather than half selectable.
 */
export function onceHorizonEnd(now) {
  const d = new Date(now);
  return new Date(
    d.getFullYear() + ONCE_HORIZON_YEARS,
    d.getMonth(),
    d.getDate(),
    23,
    59,
    59,
    999,
  ).getTime();
}

/**
 * May a one-off be SET to this instant?
 *
 * Takes `now` because it is a question about the future, and it is asked by the
 * picker rather than by `normalizeSchedule` — a stored one-off whose moment has
 * passed is not invalid, it is spent, and a normalizer that dropped it would
 * erase the record of a run that happened.
 */
export function withinOnceHorizon(at, now) {
  if (typeof at !== "number" || !Number.isFinite(at)) return false;
  return at > now && at <= onceHorizonEnd(now);
}

/**
 * The first occurrence strictly after `after`.
 *
 * STRICTLY AFTER, so a schedule that has just fired does not immediately
 * report itself due again — with a five-minute step and a run that takes under
 * a minute, "at or after" would fire the same occurrence twice.
 *
 * Returns null for a schedule that is not one, and for a one-off whose moment
 * has passed — a spent one-off has no next occurrence, which is exactly what
 * null already means to every caller.
 *
 * DST is handled by construction: `new Date(y, m, d, h, min)` normalises a
 * local time that does not exist (spring forward) to the next one that does,
 * which is the answer a person would give — the 02:30 job runs at 03:00 on the
 * day 02:30 was skipped. The interval branch builds its answer the same way
 * rather than adding milliseconds to midnight, because a 23-hour day makes
 * "midnight + 1440 minutes" land at 23:00 — an occurrence that is then not
 * strictly after itself, and so is due forever.
 */
export function nextOccurrence(schedule, after) {
  const s = normalizeSchedule(schedule);
  if (!s || typeof after !== "number" || !Number.isFinite(after)) return null;
  const from = new Date(after);

  if (s.kind === "onceAt") return s.at > after ? s.at : null;

  if (s.kind === "everyMinutes") {
    const step = s.minutes;
    const slotsToday = Math.floor(minuteOfDay(from) / step) + 1;
    // Past the last slot of the day rolls into tomorrow, which is what a
    // minutes field beyond 1440 does anyway — spelled out because the rollover
    // is the case a reader will want to check.
    return new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate(),
      0,
      slotsToday * step,
    ).getTime();
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
 * With no `lastRunAt` at all, NOTHING RECURRING is due. A schedule set five
 * minutes ago has not missed anything, and treating "never fired" as "overdue"
 * would run every suite the moment its schedule was saved. That falls out of
 * the search rather than needing its own guard: with no last fire the search
 * starts at `now`, and `nextOccurrence` is STRICTLY after, so the answer is
 * always in the future. A second copy of the rule is the one that would rot.
 *
 * A ONE-OFF IS THE EXCEPTION, and it needs its own branch precisely because
 * that rule is right for a repeating schedule and wrong for a named moment. The
 * user did not describe a cadence, they picked a day; if the app was shut on
 * that day the run IS owed, and the search above would report the opposite —
 * `nextOccurrence` from `now` is null for a spent one-off, so it would be read
 * as "never due" and the occurrence would be silently dropped. That is the one
 * thing the launch catch-up exists to prevent.
 *
 * "Already fired" is a comparison rather than a flag: the schedule fired if the
 * schedule's last fire is at or after the instant it names. A fire stamped
 * BEFORE that instant belongs to a schedule the user has since changed, and
 * must not count against the new one.
 */
export function isDue(schedule, lastRunAt, now) {
  const s = normalizeSchedule(schedule);
  if (!s) return false;
  if (s.kind === "onceAt") {
    if (s.at > now) return false;
    return !(typeof lastRunAt === "number" && lastRunAt >= s.at);
  }
  const due = nextOccurrence(s, typeof lastRunAt === "number" ? lastRunAt : now);
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
 *
 * A one-off needs nothing added here, and that is worth stating rather than
 * leaving to be rediscovered: its moment either falls inside the session, in
 * which case `nextOccurrence` returns it once and never again, or it fell
 * before the session started, in which case `nextOccurrence` returns null and
 * the catch-up has it. The split is already exact.
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
  if (s.kind === "everyMinutes") {
    if (s.minutes === MINUTES_PER_DAY) return "Every day at midnight";
    if (s.minutes < 60) return `Every ${s.minutes} minutes`;
    const hours = s.minutes / 60;
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  if (s.kind === "onceAt") {
    const at = new Date(s.at);
    return `Once on ${formatDate(s.at)} at ${formatMinute(minuteOfDay(at))}`;
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

/** `YYYY-MM-DD`, LOCAL. Same argument as `formatMinute`, plus one: a one-off
 *  date is read back in the chip, in the missed-run prompt and by the MCP, and
 *  "03/04" means two different days depending on who is reading it. */
export function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** An interval step as the picker spells it: `5m`, `1h`, `24h`. Here rather
 *  than in the picker so the chip a user pressed and any later readout of the
 *  same number cannot disagree. */
export function formatInterval(minutes) {
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
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
