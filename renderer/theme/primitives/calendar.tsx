// Calendar — a month grid, for picking one day.
//
// OURS RATHER THAN `<input type="date">`, and that is the expensive call in
// this primitive. The native control is a real calendar in Chromium and needs
// no code at all, so the three reasons it lost are worth writing down:
//
//   • ITS POPUP CANNOT BE BOUNDED VISIBLY. `min`/`max` make out-of-range dates
//     unselectable, but the one-off horizon is three years and a user who
//     scrolls to 2032 and finds nothing clickable has been told nothing. Here
//     the days outside the window are drawn and disabled, so the edge of the
//     window is a thing you can see rather than a thing you infer.
//   • IT CANNOT BE STYLED. The popup is browser chrome — near-white, rounded,
//     system font — opening out of a dialog that is hairlines and phosphor on
//     near-black. `color-scheme: dark` gets it to a dark grey and no further.
//   • IT CANNOT BE DRIVEN IN A TEST. The popup is not in the document, so
//     nothing about the horizon, the month rollover or the disabled edge could
//     be asserted anywhere but an e2e run. The time-of-day inputs beside this
//     stay native precisely because they have none of these problems: a time
//     input's value IS its DOM value, and there is no popup to reach.
//
// THE ROLES IT CLAIMS ARE THE ONES IT IMPLEMENTS, which is the argument
// `Menu` makes in this same directory after shipping `role="menu"` with no key
// handler at all. `role="grid"` promises a two-dimensional keyboard pattern, so
// this has one: arrows by day and week, PageUp/PageDown by month, Home/End to
// the ends of the week, and a single tab stop that moves with focus. A grid
// where Tab visits forty-two cells is not a grid, it is a trap.
//
// FOCUS AND SELECTION ARE DIFFERENT THINGS. Arrowing onto a day does not pick
// it — the month you are reading and the day you have chosen are separate
// state, or every glance at next month would change what the routine does.

import * as React from "react";

/** Monday first. The scheduler's own weekday rule is Monday–Friday, and a
 *  grid whose weekend is split across both edges disagrees with it on sight. */
const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Six rows always, so the grid does not change height between months — a
 *  dialog that grows a row when you page from February is one whose buttons
 *  move under the pointer. */
const WEEKS = 6;

export interface CalendarProps {
  /** The chosen day, as a LOCAL-MIDNIGHT timestamp. */
  value: number;
  onChange: (day: number) => void;
  /** Inclusive bounds, also local-midnight timestamps. Days outside are
   *  rendered and disabled rather than omitted — see the header. */
  min: number;
  max: number;
  /** Names the grid for assistive tech. A bare month of numbers announces as
   *  forty-two unrelated buttons otherwise. */
  label: string;
  /** Today, injected. Every other date rule in this feature takes its clock as
   *  an argument for the same reason: a marker read from a hidden `Date.now()`
   *  is one no test can sit either side of. */
  today: number;
  className?: string;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Shift by whole days through the local calendar rather than by 86 400 000ms.
 *  A DST day is 23 or 25 hours long, and "+1 day" in milliseconds lands on the
 *  same date twice a year. */
function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** Same day-of-month `n` months on, clamped INTO the month rather than rolling
 *  past it: `new Date(y, 0, 31)` plus a month is 3 March, which is not what
 *  PageDown from 31 January should do. */
function addMonths(ts: number, months: number): number {
  const d = new Date(ts);
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    Math.min(d.getDate(), lastDay),
  ).getTime();
}

export function Calendar({
  value,
  onChange,
  min,
  max,
  label,
  today,
  className,
}: CalendarProps): React.ReactElement {
  // The day the single tab stop sits on. Seeded from the selection and moved by
  // the arrow keys and the month buttons; the selection only moves on a real
  // choice. Resynced when the caller changes `value` underneath — the dialog
  // reopening on a different Routine is exactly that.
  const [focusDay, setFocusDay] = React.useState(() => startOfDay(value));
  React.useEffect(() => {
    setFocusDay(startOfDay(value));
  }, [value]);

  // Set only by a keyboard move, so opening the dialog does not steal focus
  // into the grid and paging with the mouse leaves focus on the button pressed.
  const [pullFocus, setPullFocus] = React.useState(false);
  const focusedRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    if (!pullFocus) return;
    focusedRef.current?.focus();
    setPullFocus(false);
  }, [pullFocus, focusDay]);

  const minDay = startOfDay(min);
  const maxDay = startOfDay(max);
  const todayDay = startOfDay(today);
  const selected = startOfDay(value);

  const monthStart = React.useMemo(() => {
    const d = new Date(focusDay);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }, [focusDay]);

  /** Move the tab stop, CLAMPED into the window. Refusing to leave rather than
   *  landing on a day that cannot be chosen is what makes the edge of the
   *  horizon legible from the keyboard as well as on screen. */
  const move = (to: number, viaKeyboard = true) => {
    const clamped = Math.min(Math.max(startOfDay(to), minDay), maxDay);
    setFocusDay(clamped);
    if (viaKeyboard) setPullFocus(true);
  };

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const by: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (e.key in by) {
      e.preventDefault();
      move(addDays(focusDay, by[e.key]));
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      move(addMonths(focusDay, e.key === "PageUp" ? -1 : 1));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      // Monday-first, so Monday is offset 0 and Sunday is 6.
      const offset = (new Date(focusDay).getDay() + 6) % 7;
      move(addDays(focusDay, e.key === "Home" ? -offset : 6 - offset));
    }
  };

  // The 42 cells, starting on the Monday on or before the 1st.
  const gridStart = React.useMemo(() => {
    const lead = (monthStart.getDay() + 6) % 7;
    return addDays(monthStart.getTime(), -lead);
  }, [monthStart]);

  // A month button is dead when the month it would reach holds no selectable
  // day at all — judged on the neighbouring month's nearest EDGE, not on the
  // focused date, or paging from the 31st would stop a month early.
  const prevDisabled = startOfDay(monthStart.getTime() - 1) < minDay;
  const nextDisabled =
    new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1).getTime() > maxDay;

  return (
    <div className={["gl-cal", className].filter(Boolean).join(" ")} data-gl="calendar">
      <div className="gl-cal-bar">
        <button
          type="button"
          className="gl-cal-nav"
          aria-label="Previous month"
          disabled={prevDisabled}
          onClick={() => move(addMonths(focusDay, -1), false)}
        >
          ‹
        </button>
        {/* `aria-live` so a keyboard user paging months hears where they are.
            The grid's own label does not change, and the cells only announce a
            date once focus reaches one. */}
        <span className="gl-cal-month" aria-live="polite">
          {MONTHS[monthStart.getMonth()]} {monthStart.getFullYear()}
        </span>
        <button
          type="button"
          className="gl-cal-nav"
          aria-label="Next month"
          disabled={nextDisabled}
          onClick={() => move(addMonths(focusDay, 1), false)}
        >
          ›
        </button>
      </div>

      <div className="gl-cal-dow" aria-hidden="true">
        {DOW.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>

      <div className="gl-cal-grid" role="grid" aria-label={label} onKeyDown={onGridKeyDown}>
        {Array.from({ length: WEEKS }, (_, week) => (
          <div className="gl-cal-week" role="row" key={week}>
            {Array.from({ length: 7 }, (_, day) => {
              const ts = addDays(gridStart, week * 7 + day);
              const date = new Date(ts);
              const outside = ts < minDay || ts > maxDay;
              const isFocusDay = ts === focusDay;
              return (
                <div className="gl-cal-cell" role="gridcell" key={ts}>
                  <button
                    type="button"
                    ref={isFocusDay ? focusedRef : undefined}
                    className={[
                      "gl-cal-day",
                      date.getMonth() === monthStart.getMonth() ? null : "gl-cal-day-other",
                      ts === todayDay ? "gl-cal-day-today" : null,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    // ONE tab stop. Without the roving index Tab walks all
                    // forty-two cells on the way to the next control.
                    tabIndex={isFocusDay ? 0 : -1}
                    disabled={outside}
                    aria-pressed={ts === selected}
                    aria-label={`${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`}
                    onClick={() => {
                      setFocusDay(ts);
                      onChange(ts);
                    }}
                  >
                    {date.getDate()}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
