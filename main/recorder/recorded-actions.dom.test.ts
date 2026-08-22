// What the recorder makes of a double-click and a drag, against a real DOM.
//
// Both are claims about a SEQUENCE of events, which is the kind of thing a
// mocked page cannot answer: a browser fires two clicks before a dblclick, and
// a drag is a pointerdown, some movement and a pointerup whose meaning depends
// on how far and how long. A test with a stubbed page would assert this file's
// assumptions back at itself.
//
// The right-click is deliberately absent: it cannot be captured from the page
// at all, because that gesture already opens the trainer's own tools menu. It
// is recorded from an item IN that menu instead — see recorder-service.ts.
//
// VERIFIED TO FAIL: with the thresholds removed, "an ordinary click is not a
// drag" records one; with `dropClicksSupersededBy` removed, the double-click
// cases keep the two clicks the browser fired first.

/* global document */

import { describe, expect, it } from "vitest";

import { captureHarness as harness } from "./capture-harness.js";

/** A pointer gesture: press at one point, release at another, `ms` later. */
function drag(
  page: ReturnType<typeof harness>,
  fromSel: string,
  to: { x: number; y: number },
  ms: number,
): void {
  const el = page.el(fromSel);
  const box = { x: 10, y: 10 };
  el.dispatchEvent(
    new page.win.MouseEvent("pointerdown", { bubbles: true, clientX: box.x, clientY: box.y }),
  );
  // The gesture's duration is read from Date.now(), so the release is dispatched
  // against a clock that has moved.
  const realNow = Date.now;
  try {
    const start = realNow();
    Date.now = () => start + ms;
    page.win.dispatchEvent(
      new page.win.MouseEvent("pointerup", { bubbles: true, clientX: to.x, clientY: to.y }),
    );
  } finally {
    Date.now = realNow;
  }
}

describe("double-click", () => {
  it("records a dblclick step", () => {
    const page = harness(`<button id="row" data-testid="row">Row</button>`);
    page.el("#row").dispatchEvent(
      new page.win.MouseEvent("dblclick", { bubbles: true, detail: 2 }),
    );
    expect(page.egress()).toMatchObject([{ type: "dblclick", locator: { v: "row" } }]);
  });

  it("does not record one while recording is paused", () => {
    const page = harness(`<button id="row" data-testid="row">Row</button>`);
    page.setAttr("data-pw-paused", "1");
    page.el("#row").dispatchEvent(
      new page.win.MouseEvent("dblclick", { bubbles: true, detail: 2 }),
    );
    expect(page.egress()).toEqual([]);
  });
});

describe("drag", () => {
  const BOARD = `
    <div id="card" data-testid="card" style="position:absolute;left:0;top:0;width:40px;height:40px">Card</div>
    <div id="done" data-testid="done" style="position:absolute;left:200px;top:0;width:40px;height:40px">Done</div>
  `;

  /** jsdom has no layout, so `elementFromPoint` answers null for everything.
   *  The drop target is decided by it, so the test supplies one. */
  function withDropTarget(page: ReturnType<typeof harness>, selector: string): void {
    page.doc.elementFromPoint = () => page.doc.querySelector(selector);
  }

  it("records a gesture that is far enough and slow enough", () => {
    const page = harness(BOARD);
    withDropTarget(page, "#done");
    drag(page, "#card", { x: 210, y: 10 }, 600);
    expect(page.egress()).toMatchObject([
      { type: "drag", locator: { v: "card" }, toLocator: { v: "done" } },
    ]);
  });

  it("does NOT record an ordinary click as a degenerate drag", () => {
    // The whole reason the thresholds exist: a click is a pointerdown and a
    // pointerup on the same spot, and without them every click would also
    // record a drag onto whatever was underneath.
    const page = harness(BOARD);
    withDropTarget(page, "#done");
    drag(page, "#card", { x: 12, y: 11 }, 600);
    expect(page.egress().filter((s) => s.type === "drag")).toEqual([]);
  });

  it("does NOT record a gesture that was too quick", () => {
    const page = harness(BOARD);
    withDropTarget(page, "#done");
    drag(page, "#card", { x: 210, y: 10 }, 100);
    expect(page.egress().filter((s) => s.type === "drag")).toEqual([]);
  });

  it("does NOT record a drag onto the element it started from", () => {
    // A dragged element often follows the pointer, so the thing under the
    // cursor at release is frequently the source itself. That is a step that
    // does nothing.
    const page = harness(BOARD);
    withDropTarget(page, "#card");
    drag(page, "#card", { x: 210, y: 10 }, 600);
    expect(page.egress().filter((s) => s.type === "drag")).toEqual([]);
  });

  it("does not record one while recording is paused", () => {
    const page = harness(BOARD);
    withDropTarget(page, "#done");
    page.setAttr("data-pw-paused", "1");
    drag(page, "#card", { x: 210, y: 10 }, 600);
    expect(page.egress()).toEqual([]);
  });
});
