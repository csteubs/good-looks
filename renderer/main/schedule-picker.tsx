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
// EVERY VALUE COMES FROM A CONTROL THAT CANNOT PRODUCE A BAD ONE: the kind from
// a menu, the step from `HOUR_STEPS`, the time from a native `<input
// type="time">`. That is the whole argument for an enumerated schedule over a
// cron string — see `shared/routine-schedule.mjs`. There is no free text here
// and there must never be, because a schedule that never fires is
// indistinguishable on screen from one that is not due yet.

import * as React from "react";
import { AlertDialog } from "@ui";
import { CalendarClock } from "lucide-react";

import { Menu, MenuItem } from "../theme";
import {
  describeSchedule,
  formatMinute,
  HOUR_STEPS,
  SCHEDULE_CAVEAT,
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

type Kind = "none" | RoutineSchedule["kind"];

function kindOf(schedule: RoutineSchedule | undefined): Kind {
  return schedule?.kind ?? "none";
}

const KIND_LABELS: Record<Kind, string> = {
  none: "Not scheduled",
  everyHours: "Every few hours",
  dailyAt: "Every day",
  weekdaysAt: "Weekdays",
};

export interface SchedulePickerProps {
  schedule?: RoutineSchedule;
  disabled?: boolean;
  onChange: (schedule: RoutineSchedule | undefined) => void;
}

export function SchedulePicker({
  schedule,
  disabled,
  onChange,
}: SchedulePickerProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  // Held while the dialog is open so Cancel means cancel. Committing per
  // keystroke would re-date the Routine on every nudge of the clock, and a
  // schedule saved half-typed is one that fires at a time nobody chose.
  const [draft, setDraft] = React.useState<RoutineSchedule | undefined>(schedule);
  React.useEffect(() => {
    if (open) setDraft(schedule);
  }, [open, schedule]);

  const kind = kindOf(draft);
  const minute = draft && draft.kind !== "everyHours" ? draft.minute : DEFAULT_MINUTE;
  const hours = draft?.kind === "everyHours" ? draft.hours : 4;

  const setKind = (next: Kind) => {
    if (next === "none") setDraft(undefined);
    else if (next === "everyHours") setDraft({ kind: "everyHours", hours });
    else setDraft({ kind: next, minute });
  };

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

      <AlertDialog
        open={open}
        onOpenChange={(next) => setOpen(next)}
        size="small"
        title="When does this routine run?"
        description={SCHEDULE_CAVEAT}
        confirmLabel="Save"
        onConfirm={() => {
          setOpen(false);
          onChange(draft);
        }}
      >
        <div className="gl-schedule-form">
          <Menu value={KIND_LABELS[kind]} label="How often" width={180}>
            {(close) =>
              (["none", "everyHours", "dailyAt", "weekdaysAt"] as Kind[]).map((k) => (
                <MenuItem
                  key={k}
                  label={KIND_LABELS[k]}
                  selected={k === kind}
                  onSelect={() => {
                    setKind(k);
                    close();
                  }}
                />
              ))
            }
          </Menu>

          {kind === "everyHours" ? (
            <Menu value={`${hours}h`} label="How many hours apart" width={110}>
              {(close) =>
                HOUR_STEPS.map((h) => (
                  <MenuItem
                    key={h}
                    label={h === 24 ? "24h (midnight)" : `${h}h`}
                    selected={h === hours}
                    onSelect={() => {
                      setDraft({ kind: "everyHours", hours: h });
                      close();
                    }}
                  />
                ))
              }
            </Menu>
          ) : null}

          {kind === "dailyAt" || kind === "weekdaysAt" ? (
            // A NATIVE TIME INPUT, not a text field. It cannot produce a value
            // the schedule rules would reject, which is the same reason the
            // schedule is an enumeration rather than a cron string. `value` is
            // "HH:MM" and comes back the same way, so the conversion is two
            // integers and no parsing.
            <input
              type="time"
              className="gl-schedule-time"
              aria-label="Time of day"
              value={formatMinute(minute)}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map((n) => Number.parseInt(n, 10));
                if (!Number.isInteger(h) || !Number.isInteger(m)) return;
                setDraft({ kind, minute: h * 60 + m });
              }}
            />
          ) : null}

          {kind !== "none" ? <p className="gl-note gl-schedule-note">{HEADLESS_NOTE}</p> : null}
        </div>
      </AlertDialog>
    </>
  );
}
