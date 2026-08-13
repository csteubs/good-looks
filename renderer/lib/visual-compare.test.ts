// Wipe and Blink's two decisions. REDESIGN §6.6.
//
// Both would be silent if wrong. A divider that can reach the edge leaves no
// handle to drag it back with and the mode reads as broken; a Blink that keeps
// alternating under reduced motion is involuntary full-frame motion shown to
// exactly the person who asked not to see it.

import { describe, expect, it } from "vitest";

import {
  BLINK_MS,
  WIPE_MARGIN_PCT,
  blinkIntervalMs,
  clampWipe,
  wipeAfterKey,
  wipeFromPointer,
} from "./visual-compare";

describe("blink", () => {
  it("alternates at the plan's rate, well under the flashing threshold", () => {
    expect(blinkIntervalMs(false)).toBe(BLINK_MS);
    // 3Hz is the photosensitivity threshold. 600ms is 1.67Hz.
    expect(1000 / BLINK_MS).toBeLessThan(3);
  });

  it("becomes a MANUAL toggle under reduced motion rather than switching off", () => {
    // The alternation is not decoration on top of the information, it IS the
    // information — a Blink that does not blink is a mode that does nothing. So
    // the capability is kept and only the involuntariness is removed.
    expect(blinkIntervalMs(true)).toBeNull();
  });
});

describe("the wipe divider", () => {
  it("never reaches either edge", () => {
    // Flush to an edge there is no handle left in the frame to drag back with:
    // the control disappears into the bezel and the mode looks broken.
    expect(clampWipe(0)).toBe(WIPE_MARGIN_PCT);
    expect(clampWipe(100)).toBe(100 - WIPE_MARGIN_PCT);
    expect(clampWipe(-40)).toBe(WIPE_MARGIN_PCT);
    expect(clampWipe(140)).toBe(100 - WIPE_MARGIN_PCT);
  });

  it("leaves a legitimate position alone", () => {
    expect(clampWipe(50)).toBe(50);
    expect(clampWipe(12.5)).toBe(12.5);
  });

  it("centres rather than jumping when the number is not a number", () => {
    expect(clampWipe(Number.NaN)).toBe(50);
  });

  it("maps a pointer across the frame's box", () => {
    const box = { left: 100, width: 400 };
    expect(wipeFromPointer(300, box)).toBe(50);
    expect(wipeFromPointer(200, box)).toBe(25);
  });

  it("survives a frame that has not been laid out yet", () => {
    // Not hypothetical: the frame is an image, and for one paint before it
    // loads its box is zero-wide. Dividing by that yields Infinity, which the
    // clamp would pin to the right margin — so the first drag of every session
    // would jump.
    expect(wipeFromPointer(300, { left: 0, width: 0 })).toBe(50);
  });

  it("moves on the arrow keys, coarse with shift", () => {
    // Mouse-only would make the one control on this screen that needs a steady
    // hand unusable without one.
    expect(wipeAfterKey(50, "ArrowLeft", false)).toBe(45);
    expect(wipeAfterKey(50, "ArrowRight", false)).toBe(55);
    expect(wipeAfterKey(50, "ArrowRight", true)).toBe(75);
  });

  it("jumps to either end on Home and End, still inside the margin", () => {
    expect(wipeAfterKey(50, "Home", false)).toBe(WIPE_MARGIN_PCT);
    expect(wipeAfterKey(50, "End", false)).toBe(100 - WIPE_MARGIN_PCT);
  });

  it("reports null for a key it does not handle, so the caller can let it through", () => {
    expect(wipeAfterKey(50, "a", false)).toBeNull();
    expect(wipeAfterKey(50, "Tab", false)).toBeNull();
  });
});
