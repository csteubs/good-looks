// Setting a Routine's schedule. docs/ROUTINES.md capability 2, REDESIGN §7.1.
//
// A CHIP THAT OPENS A DIALOG, rather than controls in the toolbar. §7.1 asks
// for a "schedule chip" beside the name, and the dialog is what gives the
// caveat room: ROUTINES.md requires the weaker guarantee to be STATED — this
// only runs while the app is open — because promising unattended nightly runs
// and delivering them only when the app happens to be running is worse than not
// offering the feature. A sentence that long cannot live in a toolbar, and a
// tooltip is not "stated" when the thing it qualifies is a promise.
//
// THE CHIP IS NEUTRAL CHROME, not phosphor. REDESIGN §7.1 is explicit and the
// palette rule behind it is the app's oldest: colour means OUTCOME. A schedule
// is a fact about a job — it has not passed or failed anything — and a green
// "Every day at 09:00" beside a red run history would be the loudest wrong
// signal on the screen.
//
// EVERY VALUE COMES FROM A CONTROL THAT CANNOT PRODUCE A BAD ONE: the mode from
// a radio row, the interval from `INTERVAL_STEPS`, the time from a native
// `<input type="time">`, the date from a `Calendar` bounded at the horizon.
// That is the whole argument for an enumerated schedule over a cron string —
// see `shared/routine-schedule.mjs`. There is no free text here and there must
// never be, because a schedule that never fires is indistinguishable on screen
// from one that is not due yet.
//
// ── WHAT THE REBUILD FIXED, AND WHY IT IS NOT A MENU ANY MORE ───────────────
//
// This was two `Menu`s inside an `AlertDialog`. Three faults, and the first was
// not cosmetic:
//
//   • `AlertDialogBody` is `overflow-y-auto` and `.gl-menu` is
//     `position: absolute` inside it, so the popover was CLIPPED BY ITS OWN
//     CONTAINER — a 268px menu showing about 40px of itself. Eight of the ten
//     cadences could not be seen, let alone chosen. Loosening the body's
//     overflow would have let the popover escape the panel instead; laying the
//     options out flat is what makes the bug structurally impossible, because
//     there is no popover left to clip.
//   • Neither control had a visible label. Both carried an `aria-label`, so a
//     screen reader was told what they were and a sighted user got
//     "EVERY FEW HOURS" and "4H" side by side with nothing between them.
//   • `AlertDialogContent` is `text-center` at `max-w-sm`, because an alert is
//     a destructive confirmation. This is a form. `Dialog` is the right
//     component and it left-aligns by default.
//
// ── THE READOUT IS THE POINT, NOT DECORATION ────────────────────────────────
//
// The old dialog never said when the run would happen. "Every 4 hours" is
// anchored to local midnight — a rule the user has no way of knowing — so
// whether that meant 16:00 today or 04:00 tomorrow was arithmetic left to
// them. The readout answers it with `nextOccurrence`, the same function the
// scheduler will call, so the sentence on screen and the moment the timer picks
// cannot disagree. It is also the other half of the enumeration argument: a
// schedule that never fires looks exactly like one that is not due yet, and
// this is where the app finally says which it is.

import * as React from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui";
import { CalendarClock } from "lucide-react";

import { Calendar } from "../theme";
import {
  describeSchedule,
  formatDate,
  formatInterval,
  formatMinute,
  INTERVAL_STEPS,
  onceHorizonEnd,
  ONCE_HORIZON_YEARS,
  SCHEDULE_CAVEAT,
  nextOccurrence,
} from "../../shared/routine-schedule.mjs";
import type { RoutineSchedule } from "../lib/recorder-types";

/** What a scheduled run always does, said where it is set. ROUTINES.md asks for
 *  this in the builder, not only in the code that enforces it: somebody who
 *  ticked "headed" on a step needs to know their nightly run will not be. */
export const HEADLESS_NOTE =
  "Scheduled runs are always headless — no browser window opens.";

/** The default time a newly scheduled Routine gets: 09:00. A time had to be
 *  chosen, and midnight would put the first run at the moment least likely to
 *  have anyone awake to see it go wrong. */
const DEFAULT_MINUTE = 9 * 60;

/** The default interval: four hours, which is what `everyHours` defaulted to
 *  before the sub-hour steps arrived. Not five minutes — a default that runs
 *  the suite twelve times an hour is one nobody asked for. */
const DEFAULT_MINUTES = 240;

/**
 * Consequences worth spelling out, on the two steps short enough to have one.
 *
 * A run that overruns its own cadence is not an error and never was — the batch
 * runner refuses a second batch and the scheduler records `alreadyRunning` —
 * but it IS a new way to be surprised, and a suite that silently runs half as
 * often as its chip claims is exactly the kind of quiet wrongness this feature
 * cannot afford.
 */
const INTERVAL_NOTES: Record<number, string> = {
  5: "Every 5 minutes only suits a suite that finishes in under five minutes — an occurrence arriving while the last one is still running is skipped.",
  15: "An occurrence arriving while the last one is still running is skipped.",
};

type Mode = "off" | RoutineSchedule["kind"];

const MODES: ReadonlyArray<{ mode: Mode; label: string; hint: string }> = [
  { mode: "off", label: "Off", hint: "Only when you press Run" },
  { mode: "everyMinutes", label: "Repeat", hint: "On a fixed interval" },
  { mode: "dailyAt", label: "Daily", hint: "Every day at a time" },
  { mode: "weekdaysAt", label: "Weekdays", hint: "Mon–Fri at a time" },
  { mode: "onceAt", label: "Once", hint: "On one date, then never" },
];

/**
 * The dialog's working state.
 *
 * WIDER THAN A `RoutineSchedule` ON PURPOSE. Every mode keeps its own value, so
 * flipping from Daily to Once and back does not lose the time you set on the
 * way past — a picker that forgets what you typed the moment you look at
 * another option is one you have to get right first time.
 */
interface Draft {
  mode: Mode;
  minutes: number;
  minute: number;
  /** Local midnight of the chosen day; the time comes from `onceMinute`. */
  onceDay: number;
  onceMinute: number;
}

/** Local midnight on the day `ts` falls in. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The instant a one-off draft names. */
function onceInstant(draft: Draft): number {
  const d = new Date(draft.onceDay);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    Math.floor(draft.onceMinute / 60),
    draft.onceMinute % 60,
  ).getTime();
}

/** Seed the draft from what is stored, defaulting every mode the stored
 *  schedule says nothing about. Exported for the test, which is the only other
 *  thing that needs to know what an unset mode falls back to. */
export function draftFrom(schedule: RoutineSchedule | undefined, now: number): Draft {
  const today = new Date(startOfDay(now));
  const base: Draft = {
    mode: schedule?.kind ?? "off",
    minutes: DEFAULT_MINUTES,
    minute: DEFAULT_MINUTE,
    // Tomorrow, not today: today at 09:00 is already in the past by
    // mid-morning, and a picker that opens on a moment it will refuse to save
    // reads as broken before the user has touched anything.
    onceDay: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime(),
    onceMinute: DEFAULT_MINUTE,
  };
  if (!schedule) return base;
  if (schedule.kind === "everyMinutes") return { ...base, minutes: schedule.minutes };
  if (schedule.kind === "onceAt") {
    const at = new Date(schedule.at);
    return {
      ...base,
      onceDay: startOfDay(schedule.at),
      onceMinute: at.getHours() * 60 + at.getMinutes(),
    };
  }
  return { ...base, minute: schedule.minute };
}

/** What the draft would be stored as. `undefined` is "not scheduled", which is
 *  what `Routine.schedule` already means when absent. */
function scheduleOf(draft: Draft): RoutineSchedule | undefined {
  if (draft.mode === "off") return undefined;
  if (draft.mode === "everyMinutes") return { kind: "everyMinutes", minutes: draft.minutes };
  if (draft.mode === "onceAt") return { kind: "onceAt", at: onceInstant(draft) };
  return { kind: draft.mode, minute: draft.minute };
}

/**
 * When the next run lands, in words.
 *
 * "today"/"tomorrow" for the two days a person thinks in, and the plain date
 * after that — a relative phrase past tomorrow ("in 3 days") makes the reader
 * do the arithmetic the readout exists to save them. The date is the ISO-ish
 * spelling `formatDate` uses everywhere else in this feature, for the reason
 * given there: "03/04" is two different days depending on who is reading it.
 *
 * Exported for the test — a copy of this format string in the assertions is one
 * that goes stale the day the copy changes.
 */
export function formatNextRun(at: number, now: number): string {
  const when = new Date(at);
  const time = formatMinute(when.getHours() * 60 + when.getMinutes());
  const day = startOfDay(at);
  const today = new Date(startOfDay(now));
  if (day === today.getTime()) return `today at ${time}`;
  if (day === new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime()) {
    return `tomorrow at ${time}`;
  }
  return `${formatDate(at)} at ${time}`;
}

export interface SchedulePickerProps {
  schedule?: RoutineSchedule;
  disabled?: boolean;
  onChange: (schedule: RoutineSchedule | undefined) => void;
  /** The clock, injected — the same discipline every other date rule in this
   *  feature follows. Read once when the dialog OPENS rather than per render,
   *  so the readout does not drift under the pointer while it is being read. */
  now?: number;
}

export function SchedulePicker({
  schedule,
  disabled,
  onChange,
  now,
}: SchedulePickerProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [openedAt, setOpenedAt] = React.useState(() => now ?? Date.now());
  // Held while the dialog is open so Cancel means cancel. Committing per
  // keystroke would re-date the Routine on every nudge of the clock, and a
  // schedule saved half-typed is one that fires at a time nobody chose.
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(schedule, openedAt));
  React.useEffect(() => {
    if (!open) return;
    const at = now ?? Date.now();
    setOpenedAt(at);
    setDraft(draftFrom(schedule, at));
  }, [open, schedule, now]);

  const draftSchedule = scheduleOf(draft);
  const horizonEnd = onceHorizonEnd(openedAt);
  const onceAt = onceInstant(draft);
  const oncePast = draft.mode === "onceAt" && onceAt <= openedAt;
  const onceBeyond = draft.mode === "onceAt" && onceAt > horizonEnd;
  const canSave = !oncePast && !onceBeyond;

  return (
    <>
      <button
        type="button"
        className="gl-schedule-chip"
        disabled={disabled}
        aria-label="When this routine runs"
        onClick={() => setOpen(true)}
      >
        <CalendarClock aria-hidden="true" />
        {describeSchedule(schedule)}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="large" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>When does this routine run?</DialogTitle>
          </DialogHeader>

          <DialogBody className="gl-schedule-body">
            <ModeColumn draft={draft} onMode={(mode) => setDraft((d) => ({ ...d, mode }))} />
            <div className="gl-schedule-pane">
              <ModePane
                draft={draft}
                setDraft={setDraft}
                openedAt={openedAt}
                horizonEnd={horizonEnd}
              />
            </div>
          </DialogBody>

          <Readout
            schedule={draftSchedule}
            openedAt={openedAt}
            oncePast={oncePast}
            onceBeyond={onceBeyond}
          />

          <div className="gl-schedule-notes">
            {/* The caveat, and it IS the dialog's description — `aria-describedby`
                points here rather than at a second copy under the title, so the
                sentence a screen reader reads and the sentence on screen are one
                element. */}
            <DialogDescription className="gl-schedule-note">{SCHEDULE_CAVEAT}</DialogDescription>
            {draftSchedule ? <p className="gl-schedule-note">{HEADLESS_NOTE}</p> : null}
            {draft.mode === "everyMinutes" && INTERVAL_NOTES[draft.minutes] ? (
              <p className="gl-schedule-note">{INTERVAL_NOTES[draft.minutes]}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="muted" className="mr-auto" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              disabled={!canSave}
              onClick={() => {
                setOpen(false);
                onChange(draftSchedule);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The five modes, as a radiogroup. Arrow keys move the choice and there is one
 *  tab stop — what `role="radiogroup"` promises, implemented rather than
 *  claimed (see `renderer/theme/primitives/menu.tsx` for the time this repo
 *  claimed a keyboard pattern it did not have). */
function ModeColumn({
  draft,
  onMode,
}: {
  draft: Draft;
  onMode: (mode: Mode) => void;
}): React.ReactElement {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const move = (from: number, by: number) => {
    const next = (from + by + MODES.length) % MODES.length;
    onMode(MODES[next].mode);
    refs.current[next]?.focus();
  };
  return (
    <div className="gl-schedule-modes" role="radiogroup" aria-label="How often">
      {MODES.map((m, i) => (
        <button
          key={m.mode}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          className="gl-schedule-mode"
          aria-checked={m.mode === draft.mode}
          tabIndex={m.mode === draft.mode ? 0 : -1}
          onClick={() => onMode(m.mode)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") {
              e.preventDefault();
              move(i, 1);
            } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
              e.preventDefault();
              move(i, -1);
            }
          }}
        >
          <span className="gl-schedule-mode-label">{m.label}</span>
          <span className="gl-schedule-mode-hint">{m.hint}</span>
        </button>
      ))}
    </div>
  );
}

/** The selected mode's own controls. */
function ModePane({
  draft,
  setDraft,
  openedAt,
  horizonEnd,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  openedAt: number;
  horizonEnd: number;
}): React.ReactElement {
  if (draft.mode === "off") {
    return (
      <p className="gl-schedule-blank">
        This routine runs only when you press Run. Choose a mode on the left to give it a schedule.
      </p>
    );
  }

  if (draft.mode === "everyMinutes") {
    return (
      <div className="gl-schedule-field">
        <span className="gl-schedule-field-label" id="schedule-interval-label">
          How often
        </span>
        {/* FLAT, not a menu. Eleven values fit in two rows and all of them are
            readable without opening anything — which is the fix for the clipped
            popover, not a decoration on top of it. */}
        <div className="gl-schedule-chips" role="group" aria-labelledby="schedule-interval-label">
          {INTERVAL_STEPS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className="gl-schedule-step"
              aria-pressed={minutes === draft.minutes}
              onClick={() => setDraft((d) => ({ ...d, minutes }))}
            >
              {formatInterval(minutes)}
            </button>
          ))}
        </div>
        <p className="gl-schedule-hint">Counted from local midnight, so the gaps never drift.</p>
      </div>
    );
  }

  if (draft.mode === "onceAt") {
    return (
      <div className="gl-schedule-once">
        <div className="gl-schedule-field">
          <span className="gl-schedule-field-label">Date</span>
          <Calendar
            label="Choose a date"
            value={draft.onceDay}
            today={openedAt}
            min={openedAt}
            max={horizonEnd}
            onChange={(onceDay) => setDraft((d) => ({ ...d, onceDay }))}
          />
          <p className="gl-schedule-hint">Any date up to {formatDate(horizonEnd)}.</p>
        </div>
        <TimeField
          label="Time"
          minute={draft.onceMinute}
          onMinute={(onceMinute) => setDraft((d) => ({ ...d, onceMinute }))}
        />
      </div>
    );
  }

  return (
    <div className="gl-schedule-field">
      <TimeField
        label="Time of day"
        minute={draft.minute}
        onMinute={(minute) => setDraft((d) => ({ ...d, minute }))}
      />
      <p className="gl-schedule-hint">
        {draft.mode === "weekdaysAt"
          ? "Monday to Friday only. Saturday and Sunday are skipped."
          : "Every day, including weekends."}
      </p>
    </div>
  );
}

/** A NATIVE TIME INPUT, not a text field, and not the bespoke treatment the
 *  calendar beside it gets. It cannot produce a value the schedule rules would
 *  reject, its value IS its DOM value so a test can drive it, and it has no
 *  popup to style — which is the whole list of reasons the date picker could
 *  not stay native. `value` is "HH:MM" and comes back the same way, so the
 *  conversion is two integers and no parsing. */
function TimeField({
  label,
  minute,
  onMinute,
}: {
  label: string;
  minute: number;
  onMinute: (minute: number) => void;
}): React.ReactElement {
  return (
    <div className="gl-schedule-field">
      <span className="gl-schedule-field-label">{label}</span>
      <input
        type="time"
        className="gl-schedule-time"
        aria-label={label}
        value={formatMinute(minute)}
        onChange={(e) => {
          const [h, m] = e.target.value.split(":").map((n) => Number.parseInt(n, 10));
          // A cleared native time input reports "". Storing the arithmetic on
          // that would put NaN in the schedule, which the store drops — so the
          // visible result would be a schedule that silently vanished on save.
          if (!Number.isInteger(h) || !Number.isInteger(m)) return;
          onMinute(h * 60 + m);
        }}
      />
    </div>
  );
}

/** What the draft will actually do, in a sentence. See the file header — this
 *  is the fix for the fault that costs people runs, not a flourish. */
function Readout({
  schedule,
  openedAt,
  oncePast,
  onceBeyond,
}: {
  schedule: RoutineSchedule | undefined;
  openedAt: number;
  oncePast: boolean;
  onceBeyond: boolean;
}): React.ReactElement {
  let tone = "";
  let text: string;
  if (oncePast) {
    tone = "gl-schedule-next-bad";
    text = "That moment has already passed. Pick a time ahead of now.";
  } else if (onceBeyond) {
    tone = "gl-schedule-next-bad";
    text = `That is more than ${ONCE_HORIZON_YEARS} years out, which is as far ahead as a one-off goes.`;
  } else if (!schedule) {
    tone = "gl-schedule-next-none";
    text = "Never — this routine only runs when you press Run.";
  } else {
    const at = nextOccurrence(schedule, openedAt);
    text =
      at === null
        ? "Never — this routine only runs when you press Run."
        : formatNextRun(at, openedAt) +
          (schedule.kind === "onceAt" ? " — and then never again" : "");
  }
  return (
    <div className="gl-schedule-readout">
      <span className="gl-schedule-readout-label">Next run</span>
      {/* `aria-live`, because this is the one thing in the dialog that changes
          without being touched: pressing a chip four rows away rewrites it. */}
      <span className={["gl-schedule-next", tone].filter(Boolean).join(" ")} aria-live="polite">
        {text}
      </span>
    </div>
  );
}
