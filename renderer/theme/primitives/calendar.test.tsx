// Calendar — the month grid a one-off Routine date is picked from.
//
// WHAT IS ONLY OBSERVABLE HERE is everything the native `<input type="date">`
// put out of reach: whether the horizon is visible as a disabled edge rather
// than an absence, whether the month buttons stop at it, and whether the
// keyboard pattern `role="grid"` promises actually exists. A browser's own date
// popup is not in the document, so none of these could be asserted anywhere but
// an e2e run — which is most of why this primitive exists at all.
//
// jsdom has no layout engine, so the marks are asserted as the classes that
// draw them. That is the contract: a "today" ring nothing renders is a marker
// that lies, and there is no computed style here to catch it.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { Calendar } from "./calendar";

/** Monday 17 August 2026 — the month the tests read, chosen because it starts
 *  on a Saturday, so the Monday-first grid has a five-day lead-in and the
 *  "days from the month before" case is on screen without arranging it. */
const TODAY = new Date(2026, 7, 17, 14, 30).getTime();
const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

function draw(over: Partial<React.ComponentProps<typeof Calendar>> = {}) {
  const onChange = vi.fn();
  render(
    <Calendar
      label="Choose a date"
      value={day(2026, 7, 18)}
      today={TODAY}
      min={TODAY}
      max={new Date(2029, 7, 17, 23, 59, 59, 999).getTime()}
      onChange={onChange}
      {...over}
    />,
  );
  return onChange;
}

const cell = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("what it draws", () => {
  it("opens on the month the value falls in", () => {
    draw();
    expect(screen.getByText("August 2026")).toBeTruthy();
  });

  it("always draws six weeks, so the grid does not change height between months", () => {
    // A dialog that grows a row when you page from February is one whose
    // buttons move under the pointer.
    draw();
    expect(screen.getAllByRole("row")).toHaveLength(6);
    expect(screen.getAllByRole("gridcell")).toHaveLength(42);
  });

  it("marks today and the selection differently", () => {
    // Two different claims — "you are here" and "this is what will happen" —
    // and one day is routinely both.
    draw();
    expect(cell("17 August 2026").className).toContain("gl-cal-day-today");
    expect(cell("17 August 2026").getAttribute("aria-pressed")).toBe("false");
    expect(cell("18 August 2026").getAttribute("aria-pressed")).toBe("true");
    expect(cell("18 August 2026").className).not.toContain("gl-cal-day-today");
  });

  it("dims the days that belong to a neighbouring month", () => {
    draw();
    expect(cell("31 July 2026").className).toContain("gl-cal-day-other");
    expect(cell("18 August 2026").className).not.toContain("gl-cal-day-other");
  });
});

describe("the window it is bounded by", () => {
  it("draws the days outside it and disables them, rather than omitting them", () => {
    // The horizon is a fact about the WINDOW, and a blank cell says nothing
    // about why it is blank.
    draw();
    expect(cell("16 August 2026").disabled).toBe(true);
    expect(cell("1 August 2026").disabled).toBe(true);
    expect(cell("17 August 2026").disabled).toBe(false);
  });

  it("refuses to page before the first selectable month", () => {
    draw();
    expect((screen.getByLabelText("Previous month") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Next month") as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses to page past the last one", () => {
    draw({ value: day(2029, 7, 1), min: day(2026, 7, 17), max: day(2029, 7, 17) });
    expect(screen.getByText("August 2029")).toBeTruthy();
    expect((screen.getByLabelText("Next month") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Previous month") as HTMLButtonElement).disabled).toBe(false);
  });

  it("judges a month button on the neighbouring month's edge, not on the focused date", () => {
    // The day focus sits on has no counterpart in a 30-day month, so a button
    // that asked "can I land on the 31st of the previous month" would go dead a
    // month early — for a month that has plenty of selectable days in it.
    draw({ value: day(2026, 9, 31), min: day(2026, 7, 17), max: day(2029, 7, 17) });
    expect(screen.getByText("October 2026")).toBeTruthy();
    expect((screen.getByLabelText("Previous month") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("Previous month"));
    expect(screen.getByText("September 2026")).toBeTruthy();
  });
});

describe("choosing a day", () => {
  it("hands back local midnight of the day pressed", () => {
    const onChange = draw();
    fireEvent.click(cell("25 August 2026"));
    expect(onChange).toHaveBeenCalledWith(day(2026, 7, 25));
  });

  it("can be given a day from the month either side without paging", () => {
    const onChange = draw();
    fireEvent.click(cell("2 September 2026"));
    expect(onChange).toHaveBeenCalledWith(day(2026, 8, 2));
  });
});

describe("the keyboard pattern its role promises", () => {
  // `role="grid"` is a specific claim to assistive tech. `Menu` in this same
  // directory shipped `role="menu"` with no key handler at all, so this is the
  // second time the claim has had to be backed by a test rather than a comment.

  it("keeps ONE tab stop, on the day focus sits on", () => {
    draw();
    const tabbable = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("gl-cal-day") && b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("aria-label")).toBe("18 August 2026");
  });

  it("moves by a day and by a week without choosing anything", () => {
    // Focus and selection are different things, or every glance at next month
    // would change what the routine does.
    const onChange = draw();
    fireEvent.keyDown(cell("18 August 2026"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell("19 August 2026"));
    fireEvent.keyDown(cell("19 August 2026"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell("26 August 2026"));
    fireEvent.keyDown(cell("26 August 2026"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(cell("19 August 2026"));
    expect(onChange).not.toHaveBeenCalled();
    expect(cell("18 August 2026").getAttribute("aria-pressed")).toBe("true");
  });

  it("pages a month at a time, and pulls the grid with it", () => {
    draw();
    fireEvent.keyDown(cell("18 August 2026"), { key: "PageDown" });
    expect(screen.getByText("September 2026")).toBeTruthy();
    expect(document.activeElement).toBe(cell("18 September 2026"));
    fireEvent.keyDown(cell("18 September 2026"), { key: "PageUp" });
    expect(screen.getByText("August 2026")).toBeTruthy();
  });

  it("clamps a month page INTO the month rather than rolling past it", () => {
    // 31 January plus a month is 3 March if you only add to the month number,
    // which is not what PageDown from the 31st should do.
    draw({ value: day(2027, 0, 31), min: day(2026, 7, 17), max: day(2029, 7, 17) });
    fireEvent.keyDown(cell("31 January 2027"), { key: "PageDown" });
    expect(document.activeElement).toBe(cell("28 February 2027"));
  });

  it("goes to the ends of the week, Monday first", () => {
    draw();
    fireEvent.keyDown(cell("18 August 2026"), { key: "End" });
    expect(document.activeElement).toBe(cell("23 August 2026"));
    fireEvent.keyDown(cell("23 August 2026"), { key: "Home" });
    expect(document.activeElement).toBe(cell("17 August 2026"));
  });

  it("will not step outside the window", () => {
    // Refusing to leave rather than landing somewhere unpressable is what makes
    // the edge of the horizon legible from the keyboard as well as on screen.
    draw({ value: TODAY });
    fireEvent.keyDown(cell("17 August 2026"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell("17 August 2026"));
    fireEvent.keyDown(cell("17 August 2026"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(cell("17 August 2026"));
  });

  it("does not steal focus when the month is paged with the pointer", () => {
    // Opening a dialog must not drop the caret into a grid of forty-two cells,
    // and neither should pressing the button beside it.
    draw();
    const next = screen.getByLabelText("Next month");
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(next);
  });
});
