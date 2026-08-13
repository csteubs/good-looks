// Setting a Routine's schedule. docs/ROUTINES.md capability 2.
//
// The schedule ARITHMETIC is tested in `routine-schedule.test.ts`. What is only
// observable here is the promise the UI makes: that the caveat is on screen
// wherever a schedule is set, that a scheduled run says it will be headless,
// and that nothing commits until Save.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SCHEDULE_CAVEAT } from "../../shared/routine-schedule.mjs";
import type { RoutineSchedule } from "../lib/recorder-types";
import { HEADLESS_NOTE, SchedulePicker } from "./schedule-picker";

function open(schedule?: RoutineSchedule) {
  const onChange = vi.fn();
  render(<SchedulePicker schedule={schedule} onChange={onChange} />);
  fireEvent.click(screen.getByLabelText("When this routine runs"));
  return onChange;
}

describe("the chip", () => {
  it("reads back the schedule, and says so when there is none", () => {
    const { rerender } = render(<SchedulePicker onChange={vi.fn()} />);
    expect(screen.getByLabelText("When this routine runs").textContent).toContain("Not scheduled");

    rerender(
      <SchedulePicker schedule={{ kind: "dailyAt", minute: 9 * 60 + 30 }} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText("When this routine runs").textContent).toContain(
      "Every day at 09:30",
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
});

describe("what it can produce", () => {
  it("offers a time only for the kinds that have one", () => {
    open({ kind: "everyHours", hours: 4 });
    expect(screen.queryByLabelText("Time of day")).toBeNull();
    expect(screen.getByRole("button", { name: /how many hours apart/i })).toBeTruthy();
  });

  it("offers hour steps only for every-N-hours", () => {
    open({ kind: "dailyAt", minute: 540 });
    expect(screen.getByLabelText("Time of day")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /how many hours apart/i })).toBeNull();
  });

  it("commits nothing until Save", () => {
    // Committing per keystroke would re-date the Routine on every nudge of the
    // clock, and a schedule saved half-typed fires at a time nobody chose.
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "22:15" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "dailyAt", minute: 22 * 60 + 15 });
  });

  it("abandons the edit on Cancel", () => {
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "22:15" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the schedule when set back to Not scheduled", () => {
    // The only way OUT of a schedule. Without it a Routine scheduled once is
    // scheduled forever, and the way people would find that is by deleting the
    // job to stop it.
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.click(screen.getByRole("button", { name: /how often/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Not scheduled" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("ignores a time the browser could not parse rather than storing NaN", () => {
    // A cleared native time input reports "". Storing the arithmetic on that
    // would put NaN in the schedule, which the store drops — so the visible
    // result would be a schedule that silently vanished on save.
    const onChange = open({ kind: "dailyAt", minute: 540 });
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "dailyAt", minute: 540 });
  });
});
