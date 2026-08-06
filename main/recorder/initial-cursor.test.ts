// Where the insert cursor sits when a trainer session opens.
//
// The cursor decides where the NEXT captured step lands, so getting it wrong is
// silent and destructive in a specific way: you record three clicks at the
// start of a checkout flow and they are appended to the end of the test,
// after the confirmation assertion. Nothing errors. The steps are all there.
// They are simply in the wrong order, and you find out when the test runs.
//
// Opening a session executes exactly ONE thing — the initial navigation — so
// "just past the goto" is the only defensible position.

import { describe, it, expect } from "vitest";

import { initialCursor } from "./types.js";

describe("initialCursor", () => {
  it("sits between the navigation and the next step when continuing a test", () => {
    // The regression: this used to be the END of the list, so every newly
    // recorded step was appended after the last one no matter where in the
    // flow the browser actually was.
    expect(initialCursor(true, 8)).toBe(1);
  });

  it("does not run past the end of a one-step test", () => {
    expect(initialCursor(true, 1)).toBe(1);
  });

  it("stays at zero when a continued test somehow has no steps", () => {
    // Shouldn't happen — an existing test always has its goto — but a cursor
    // past the end of the list is a crash waiting for the first insert.
    expect(initialCursor(true, 0)).toBe(0);
  });

  it("is never past the end, for any step count", () => {
    for (let n = 0; n <= 50; n++) {
      expect(initialCursor(true, n)).toBeLessThanOrEqual(n);
      expect(initialCursor(false, n)).toBeLessThanOrEqual(n);
    }
  });

  it("leaves a NEW recording at the end, which is also the start", () => {
    // A new recording has no steps yet; its `goto` is added straight after and
    // advances the cursor to 1 through the normal insert path. Both cases end
    // up in the same place, which is the point — one rule, not two.
    expect(initialCursor(false, 0)).toBe(0);
  });
});
