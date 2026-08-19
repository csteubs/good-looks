import { describe, it, expect } from "vitest";

import { fillWorkArea } from "./window-fill.js";

// The main window's floor at 100%, which is what the caller passes.
const MIN = { width: 960, height: 456 };

describe("fillWorkArea", () => {
  it("fills a work area exactly", () => {
    // A 16" MacBook Pro: 1728×1117 with the menu bar taken off the top and the
    // Dock off the bottom. The window is that rectangle, not a fraction of it.
    expect(fillWorkArea({ x: 0, y: 37, width: 1728, height: 1055 }, MIN)).toEqual({
      x: 0,
      y: 37,
      width: 1728,
      height: 1055,
    });
  });

  it("opens on the work area's origin, not the display's", () => {
    // y is 37 above, and it is not zero on any Mac: a window at y=0 is a window
    // whose title bar is under the menu bar. The x case is the second display
    // placed LEFT of the built-in one, where the origin is negative and a
    // window that ignored it would open on the wrong screen.
    const bounds = fillWorkArea({ x: -1920, y: 25, width: 1920, height: 1055 }, MIN);
    expect(bounds.x).toBe(-1920);
    expect(bounds.y).toBe(25);
  });

  it("keeps the layout floor when the display is smaller than it", () => {
    // The floor is a measurement of what the widest toolbar needs, so it beats
    // the display: a window that fits the screen but cannot lay `Run test` out
    // is the failure the floor exists to prevent. Electron would clamp the size
    // up regardless — doing it here is what keeps the POSITION coherent with
    // the size, rather than leaving a window centred half off two edges.
    const bounds = fillWorkArea({ x: 0, y: 25, width: 800, height: 400 }, MIN);
    expect(bounds.width).toBe(960);
    expect(bounds.height).toBe(456);
    // And the overflow goes off the right and bottom, so the title bar and the
    // sidebar — what you reach for to move or resize it — stay reachable.
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(25);
  });

  it("clamps each axis independently", () => {
    // A wide, short work area (a display in a stand under a menu bar and a big
    // Dock): the width is the screen's, the height is the floor's. Clamping
    // both together on either axis's failure would waste most of the screen.
    const bounds = fillWorkArea({ x: 0, y: 25, width: 2560, height: 300 }, MIN);
    expect(bounds.width).toBe(2560);
    expect(bounds.height).toBe(456);
  });

  it("returns whole points", () => {
    // A fractional display scale can put a fraction in the work area, and
    // Electron rounds window bounds itself — so an un-rounded width here is a
    // window one point narrower than the arithmetic above claims, which is
    // exactly the kind of off-by-one an assertion on `toEqual` would chase.
    const bounds = fillWorkArea({ x: 0.5, y: 25.4, width: 1512.7, height: 944.2 }, MIN);
    expect(bounds).toEqual({ x: 1, y: 25, width: 1513, height: 944 });
  });

  it("is not affected by the floor when the display clears it", () => {
    const bounds = fillWorkArea({ x: 0, y: 25, width: 1440, height: 875 }, MIN);
    expect(bounds.width).toBe(1440);
    expect(bounds.height).toBe(875);
  });
});
