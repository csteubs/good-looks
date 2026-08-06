// Where the insert cursor sits when a trainer session opens.
//
// The cursor decides where the NEXT captured step lands, so getting it wrong is
// silent and destructive in a specific way: you record three clicks at the
// start of a checkout flow and they are appended to the end of the test,
// after the confirmation assertion. Nothing errors. The steps are all there.
// They are simply in the wrong order, and you find out when the test runs.
//
// Opening a session executes exactly ONE thing — the initial navigation — so
// "just past the goto" is the only defensible position. Which index that IS
// depends on the test: one recorded at a window-size preset opens with a
// `viewport` step, so the navigation is at 1 rather than 0.

import { describe, it, expect } from "vitest";

import { initialCursor, type Step } from "./types.js";

function step(type: Step["type"]): Step {
  return { id: type, type, timestamp: 0 } as Step;
}

/** A test of exactly `n` steps that starts, as they all do, with its
 *  navigation. `n === 0` is the empty list, not a bare goto. */
function testOf(n: number): Step[] {
  if (n <= 0) return [];
  return [step("goto"), ...Array.from({ length: n - 1 }, () => step("click"))];
}

describe("initialCursor", () => {
  it("sits between the navigation and the next step when continuing a test", () => {
    // The regression: this used to be the END of the list, so every newly
    // recorded step was appended after the last one no matter where in the
    // flow the browser actually was.
    expect(initialCursor(true, testOf(8))).toBe(1);
  });

  it("does not run past the end of a one-step test", () => {
    expect(initialCursor(true, testOf(1))).toBe(1);
  });

  it("stays at zero when a continued test somehow has no steps", () => {
    // Shouldn't happen — an existing test always has its goto — but a cursor
    // past the end of the list is a crash waiting for the first insert.
    expect(initialCursor(true, [])).toBe(0);
  });

  it("is never past the end, for any step count", () => {
    for (let n = 0; n <= 50; n++) {
      expect(initialCursor(true, testOf(n))).toBeLessThanOrEqual(n);
      expect(initialCursor(false, testOf(n))).toBeLessThanOrEqual(n);
    }
  });

  it("leaves a NEW recording at the end, which is also the start", () => {
    // A new recording has no steps yet; its `goto` is added straight after and
    // advances the cursor through the normal insert path. Both cases end up in
    // the same place, which is the point — one rule, not two.
    expect(initialCursor(false, [])).toBe(0);
  });

  it("sits past the goto when a viewport step comes first", () => {
    // A test recorded at a window-size preset. A cursor hardcoded to 1 would
    // put every newly captured step BETWEEN the viewport and the goto — before
    // the page it was recorded against had been navigated to at all.
    const sized = [step("viewport"), step("goto"), step("click"), step("assert")];
    expect(initialCursor(true, sized)).toBe(2);
  });

  it("finds the navigation however many steps precede it", () => {
    // Nothing today puts two steps before the goto, but the rule is "past the
    // navigation", not "index 2" — pinning the rule rather than this layout.
    const odd = [step("viewport"), step("cookie"), step("goto"), step("click")];
    expect(initialCursor(true, odd)).toBe(3);
  });

  it("does not run past the end when the goto is last", () => {
    const trailing = [step("viewport"), step("goto")];
    expect(initialCursor(true, trailing)).toBe(2);
  });
});
