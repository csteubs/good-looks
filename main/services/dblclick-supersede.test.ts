// Which clicks a captured double-click withdraws.
//
// A browser fires `click` twice BEFORE `dblclick`, and each of those clicks has
// already left the page — the console channel emits a click the instant it is
// captured, which is the whole fix for the click that navigates (DECISIONS
// 2026-08-13) and must not be undone by holding one back to see what follows.
// So they are recorded and then withdrawn at the ingest, which is what this
// module decides.
//
// Pure logic, so it runs in the node project: no DOM is involved in deciding
// which two steps to take back.
//
// VERIFIED TO FAIL: with the locator check removed, "leaves a click on a
// DIFFERENT element alone" records the wrong withdrawal; with the `nth` added
// back into the identity, the two-rows case does.

import { describe, expect, it } from "vitest";

import { dropClicksSupersededBy } from "./dblclick-supersede.js";
import type { Step } from "../recorder/types.js";

describe("the clicks a double-click withdraws", () => {
  // The two clicks a browser fires first have ALREADY left the page — the
  // console channel emits a click the instant it is captured, and holding one
  // back to see what follows is exactly what must not happen (it is the fix for
  // the click that navigates). So they are withdrawn at the ingest instead.
  const clickAt = (t: number, v = "row"): Step =>
    ({ id: "c" + t, timestamp: t, type: "click", locator: { k: "testid", v } }) as Step;
  const dbl = (t: number, v = "row"): Step =>
    ({ id: "d", timestamp: t, type: "dblclick", locator: { k: "testid", v } }) as Step;

  it("takes both clicks that preceded it", () => {
    const list = [clickAt(1000), clickAt(1100)];
    expect(dropClicksSupersededBy(dbl(1150), list, 2)).toBe(2);
    expect(list).toEqual([]);
  });

  it("takes at most two, however many are there", () => {
    const list = [clickAt(900), clickAt(1000), clickAt(1100)];
    expect(dropClicksSupersededBy(dbl(1150), list, 3)).toBe(2);
    expect(list.map((s) => s.timestamp)).toEqual([900]);
  });

  it("leaves a click on a DIFFERENT element alone", () => {
    // The case that would be a mis-capture: a double-click on one row must not
    // swallow a deliberate single click on another.
    const list = [clickAt(1000, "other"), clickAt(1100)];
    expect(dropClicksSupersededBy(dbl(1150), list, 2)).toBe(1);
    expect(list.map((s) => s.locator?.v)).toEqual(["other"]);
  });

  it("distinguishes two rows that share a locator but not an index", () => {
    // `healKeyFor` deliberately drops `nth` so an indexed step can heal. Here
    // the index is exactly what tells row 1 from row 2.
    const row = (n: number, t: number): Step =>
      ({ id: "x" + n + t, timestamp: t, type: "click", locator: { k: "testid", v: "row", nth: n } }) as Step;
    const list = [row(0, 1000), row(1, 1100)];
    const dblRow1 = { id: "d", timestamp: 1150, type: "dblclick", locator: { k: "testid", v: "row", nth: 1 } } as Step;
    expect(dropClicksSupersededBy(dblRow1, list, 2)).toBe(1);
    expect(list.map((s) => s.locator?.nth)).toEqual([0]);
  });

  it("leaves a click that is too old alone", () => {
    const list = [clickAt(0), clickAt(100)];
    expect(dropClicksSupersededBy(dbl(5000), list, 2)).toBe(0);
    expect(list).toHaveLength(2);
  });

  it("withdraws from the INSERTION POINT, not the end of the list", () => {
    // The cursor can sit mid-list while a recording extends an existing test.
    const tail = { id: "z", timestamp: 5000, type: "click", locator: { k: "testid", v: "later" } } as Step;
    const list = [clickAt(1000), clickAt(1100), tail];
    expect(dropClicksSupersededBy(dbl(1150), list, 2)).toBe(2);
    expect(list).toEqual([tail]);
  });

  it("claims nothing when the step is not a double-click", () => {
    const list = [clickAt(1000), clickAt(1100)];
    expect(dropClicksSupersededBy(clickAt(1150), list, 2)).toBe(0);
    expect(list).toHaveLength(2);
  });
});
