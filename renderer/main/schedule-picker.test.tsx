// Setting a Routine's schedule. docs/ROUTINES.md capability 2.
//
// The schedule ARITHMETIC is tested in `routine-schedule.test.ts`. What is only
// observable here is the promise the UI makes: that the caveat is on screen
// wherever a schedule is set, that a scheduled run says it will be headless,
// that nothing commits until Save, and — new with the rebuild — that the dialog
// says WHEN the run will happen and refuses to save a moment that has passed.
//
// THE CLOCK IS INJECTED, like every other date rule in this feature. A readout
// computed from a hidden `Date.now()` is one no test can sit either side of,
// and "in three years" is not assertable against a moving today.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { SCHEDULE_CAVEAT } from "../../shared/routine-schedule.mjs";
import type { RoutineSchedule } from "../lib/recorder-types";
import { HEADLESS_NOTE, SchedulePicker, formatNextRun } from "./schedule-picker";

/** Monday 17 August 2026, 14:30 local. A weekday and an afternoon, so "today"
 *  still has slots left in it and the weekday kinds have a today to take. */
const NOW = new Date(2026, 7, 17, 14, 30).getTime();

function open(schedule?: RoutineSchedule) {
  const onChange = vi.fn();
  render(<SchedulePicker schedule={schedule} onChange={onChange} now={NOW} />);
  fireEvent.click(screen.getByLabelText("When this routine runs"));
  return onChange;
}

const mode = (name: RegExp) => screen.getByRole("radio", { name });
const save = () => screen.getByRole("button", { name: "Save" });
const readout = () => screen.getByText(/^Next run$/).parentElement as HTMLElement;

describe("the chip", () => {
  it("reads back the schedule, and says so when there is none", () => {
    const { rerender } = render(<SchedulePicker onChange={vi.fn()} now={NOW} />);
    expect(screen.getByLabelText("When this routine runs").textContent).toContain("Not scheduled");

    rerender(
      <SchedulePicker
        schedule={{ kind: "dailyAt", minute: 9 * 60 + 30 }}
        onChange={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByLabelText("When this routine runs").textContent).toContain(
      "Every day at 09:30",
    );
  });

  it("reads back the two kinds the rebuild added", () => {
    const { rerender } = render(
      <SchedulePicker schedule={{ kind: "everyMinutes", minutes: 15 }} onChange={vi.fn()} now={NOW} />,
    );
    expect(screen.getByLabelText("When this routine runs").textContent).toContain(
      "Every 15 minutes",
    );

    rerender(
      <SchedulePicker
        schedule={{ kind: "onceAt", at: new Date(2027, 2, 14, 9, 0).getTime() }}
        onChange={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByLabelText("When this routine runs").textContent).toContain(
      "Once on 2027-03-14 at 09:00",
    );
  });
});

describe("what the dialog has to say out loud", () => {
  it("states the caveat — that this only runs while the app is open", () => {
    // ROUTINES.md requires the weaker guarantee to be STATED rather than
    // implied: promising unattended nightly runs and delivering them only when
    // the app happens to be running is worse than not offering the feature.
    open();
    expect(screen.getByText(SCHEDULE_CAVEAT)).toBeTruthy();
  });

  it("says a scheduled run is headless, once there is a schedule to run", () => {
    // The spec asks for this in the BUILDER, not only in the code that enforces
    // it: somebody who ticked "headed" on a step needs to know their nightly
    // run will not be.
    open({ kind: "dailyAt", minute: 540 });
    expect(screen.getByText(HEADLESS_NOTE)).toBeTruthy();
  });

  it("does not promise headless when nothing is scheduled", () => {
    open();
    expect(screen.queryByText(HEADLESS_NOTE)).toBeNull();
  });

  it("warns that a five-minute cadence skips an overrunning run", () => {
    // Not an error and never was — the batch runner refuses a second batch —
    // but a suite silently running half as often as its chip claims is exactly
    // the quiet wrongness this feature cannot afford.
    open({ kind: "everyMinutes", minutes: 240 });
    expect(screen.queryByText(/skipped/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "5m" }));
    expect(screen.getByText(/skipped/)).toBeTruthy();
  });
});

describe("choosing a mode", () => {
  it("shows only the controls the chosen mode has", () => {
    open({ kind: "everyMinutes", minutes: 240 });
    expect(screen.getByRole("button", { name: "4h" })).toBeTruthy();
    expect(screen.queryByLabelText("Time of day")).toBeNull();
    expect(screen.queryByRole("grid")).toBeNull();

    fireEvent.click(mode(/^Daily/));
    expect(screen.getByLabelText("Time of day")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "4h" })).toBeNull();

    fireEvent.click(mode(/^Once/));
    expect(screen.getByRole("grid", { name: "Choose a date" })).toBeTruthy();
    expect(screen.getByLabelText("Time")).toBeTruthy();
    expect(screen.queryByLabelText("Time of day")).toBeNull();
  });

  it("offers every interval step flat, with none behind a menu", () => {
    // THE BUG THE REBUILD EXISTS FOR. These were inside a `Menu` whose popover
    // was clipped by `AlertDialogBody`'s `overflow-y-auto` — eight of the ten
    // cadences could not be seen, let alone chosen. A flat row has no popover
    // to clip.
    open({ kind: "everyMinutes", minutes: 240 });
    for (const label of ["5m", "15m", "30m", "1h", "2h", "3h", "4h", "6h", "8h", "12h", "24h"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps each mode's own value while you look at another", () => {
    // A picker that forgets what you set the moment you glance at another
    // option is one you have to get right first time.
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "22:15" } });
    fireEvent.click(mode(/^Repeat/));
    fireEvent.click(mode(/^Daily/));
    fireEvent.click(save());
    expect(onChange).toHaveBeenCalledWith({ kind: "dailyAt", minute: 22 * 60 + 15 });
  });

  it("moves the choice with the arrow keys, as a radiogroup promises", () => {
    open();
    expect(mode(/^Off/).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(mode(/^Off/), { key: "ArrowDown" });
    expect(mode(/^Repeat/).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(mode(/^Repeat/), { key: "ArrowUp" });
    expect(mode(/^Off/).getAttribute("aria-checked")).toBe("true");
  });
});

describe("what it can produce", () => {
  it("commits nothing until Save", () => {
    // Committing per keystroke would re-date the Routine on every nudge of the
    // clock, and a schedule saved half-typed fires at a time nobody chose.
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "22:15" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(save());
    expect(onChange).toHaveBeenCalledWith({ kind: "dailyAt", minute: 22 * 60 + 15 });
  });

  it("abandons the edit on Cancel", () => {
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "22:15" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("saves a sub-hour interval", () => {
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.click(mode(/^Repeat/));
    fireEvent.click(screen.getByRole("button", { name: "15m" }));
    fireEvent.click(save());
    expect(onChange).toHaveBeenCalledWith({ kind: "everyMinutes", minutes: 15 });
  });

  it("saves a one-off as the instant its date and time name", () => {
    const onChange = open();
    fireEvent.click(mode(/^Once/));
    fireEvent.click(screen.getByRole("button", { name: "20 August 2026" }));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "07:45" } });
    fireEvent.click(save());
    expect(onChange).toHaveBeenCalledWith({
      kind: "onceAt",
      at: new Date(2026, 7, 20, 7, 45).getTime(),
    });
  });

  it("clears the schedule when set back to Off", () => {
    // The only way OUT of a schedule. Without it a Routine scheduled once is
    // scheduled forever, and the way people would find that is by deleting the
    // job to stop it.
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.click(mode(/^Off/));
    fireEvent.click(save());
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("ignores a time the browser could not parse rather than storing NaN", () => {
    // A cleared native time input reports "". Storing the arithmetic on that
    // would put NaN in the schedule, which the store drops — so the visible
    // result would be a schedule that silently vanished on save.
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "" } });
    fireEvent.click(save());
    expect(onChange).toHaveBeenCalledWith({ kind: "dailyAt", minute: 540 });
  });
});

describe("the readout", () => {
  // The fault that actually cost people runs: the old dialog never said when
  // the run would happen, and an interval anchored to local midnight is a rule
  // the user has no way of knowing.

  it("names the next occurrence of an interval", () => {
    open({ kind: "everyMinutes", minutes: 240 });
    // 14:30 on a four-hour grid from midnight → 16:00 the same day.
    expect(within(readout()).getByText("today at 16:00")).toBeTruthy();
  });

  it("follows the chip that was just pressed", () => {
    open({ kind: "everyMinutes", minutes: 240 });
    fireEvent.click(screen.getByRole("button", { name: "15m" }));
    expect(within(readout()).getByText("today at 14:45")).toBeTruthy();
  });

  it("rolls to tomorrow when today's slot has gone", () => {
    open({ kind: "dailyAt", minute: 9 * 60 });
    expect(within(readout()).getByText("tomorrow at 09:00")).toBeTruthy();
  });

  it("skips the weekend for a weekday schedule", () => {
    open({ kind: "weekdaysAt", minute: 8 * 60 });
    // Monday 17 August at 14:30 — 08:00 has gone, so Tuesday's is next.
    expect(within(readout()).getByText("tomorrow at 08:00")).toBeTruthy();
  });

  it("says a one-off will not come round again", () => {
    open();
    fireEvent.click(mode(/^Once/));
    expect(within(readout()).getByText(/and then never again/)).toBeTruthy();
  });

  it("says nothing will run when the routine is Off", () => {
    open();
    expect(within(readout()).getByText(/only runs when you press Run/)).toBeTruthy();
  });
});

describe("a one-off Save can refuse", () => {
  it("refuses a moment that has already passed, and says why", () => {
    // Reachable through the UI: today is selectable, and any time before now on
    // it is in the past. Today the dialog cannot produce an invalid schedule at
    // all; the moment a date is involved it can, so the refusal has to be
    // visible rather than silent.
    const onChange = open();
    fireEvent.click(mode(/^Once/));
    fireEvent.click(screen.getByRole("button", { name: "17 August 2026" }));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "09:00" } });

    expect(within(readout()).getByText(/already passed/)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets the same day through once the time is ahead of now", () => {
    const onChange = open();
    fireEvent.click(mode(/^Once/));
    fireEvent.click(screen.getByRole("button", { name: "17 August 2026" }));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "18:00" } });

    expect((save() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save());
    expect(onChange).toHaveBeenCalledWith({
      kind: "onceAt",
      at: new Date(2026, 7, 17, 18, 0).getTime(),
    });
  });

  it("stops the calendar three years out, and says where", () => {
    open();
    fireEvent.click(mode(/^Once/));
    expect(screen.getByText("Any date up to 2029-08-17.")).toBeTruthy();
    // Yesterday is drawn and dead, so the edge of the window is visible rather
    // than inferred from an absence.
    expect(
      (screen.getByRole("button", { name: "16 August 2026" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("how the next run is spelled", () => {
  it("uses the two days a person thinks in, then a plain date", () => {
    // A relative phrase past tomorrow ("in 3 days") makes the reader do the
    // arithmetic the readout exists to save them.
    expect(formatNextRun(new Date(2026, 7, 17, 16, 0).getTime(), NOW)).toBe("today at 16:00");
    expect(formatNextRun(new Date(2026, 7, 18, 9, 0).getTime(), NOW)).toBe("tomorrow at 09:00");
    expect(formatNextRun(new Date(2026, 7, 19, 9, 0).getTime(), NOW)).toBe("2026-08-19 at 09:00");
  });
});
