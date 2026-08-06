// Dock geometry for the trainer panel.
//
// Two invariants carry the whole feature and neither is visible by reading the
// arithmetic: the two windows NEVER OVERLAP (the panel exists so you can see
// the page while you edit steps — a panel covering the thing under test is
// worse than no panel), and neither window is ever placed OUTSIDE THE WORK
// AREA (a panel off the right edge of a display is unrecoverable from inside
// the panel). Both are asserted as properties, over every case, rather than
// checked case by case — a future rule change that breaks either one should
// fail here regardless of which input exposed it.
//
// The third thing under test is the reentrancy guard. The loop it breaks is one
// mabl actually shipped ("resizing the browser while training resulted in an
// endless loop that hangs the product"), and it is silent: nothing errors, the
// app just wedges.

import { describe, it, expect } from "vitest";

import {
  BROWSER_MIN_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH,
  boundsEqual,
  computeDock,
  computePanelFollow,
  computeUndock,
  isDuplicateApply,
  type Bounds,
  type DockLayout,
  type DockSide,
} from "./panel-dock.js";

/** A generous single 1920×1080 display with the macOS menu bar excluded. */
const WORK_AREA: Bounds = { x: 0, y: 25, width: 1920, height: 1055 };

/** The trainer window's creation size, from `recorder-service.ts`. */
const BROWSER: Bounds = { x: 100, y: 100, width: 1200, height: 820 };

function right(b: Bounds): number {
  return b.x + b.width;
}
function bottom(b: Bounds): number {
  return b.y + b.height;
}

/** The two invariants, asserted on every layout this file produces. */
function expectSaneLayout(layout: DockLayout | null, workArea: Bounds = WORK_AREA): DockLayout {
  expect(layout).not.toBeNull();
  const { browser, panel } = layout as DockLayout;

  // Never overlap: whichever is on the left must end exactly where the other
  // begins. Equality (not just "no overlap") also pins that we leave no gap.
  const [first, second] = browser.x <= panel.x ? [browser, panel] : [panel, browser];
  expect(right(first)).toBe(second.x);

  for (const b of [browser, panel]) {
    expect(b.x).toBeGreaterThanOrEqual(workArea.x);
    expect(b.y).toBeGreaterThanOrEqual(workArea.y);
    expect(right(b)).toBeLessThanOrEqual(right(workArea));
    expect(bottom(b)).toBeLessThanOrEqual(bottom(workArea));
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
  }
  return layout as DockLayout;
}

describe("computeDock", () => {
  it("splits the browser's own footprint rather than growing it", () => {
    const { browser, panel } = expectSaneLayout(
      computeDock(BROWSER, PANEL_WIDTH, WORK_AREA),
    );
    // The pair occupies exactly what the browser occupied before. Docking a
    // panel is not a licence to take more of the user's screen.
    expect(browser.width + panel.width).toBe(BROWSER.width);
    expect(browser.x).toBe(BROWSER.x);
    expect(panel.width).toBe(PANEL_WIDTH);
  });

  it("pins the panel to the browser's right edge by default", () => {
    const { browser, panel } = expectSaneLayout(computeDock(BROWSER, PANEL_WIDTH, WORK_AREA));
    expect(panel.x).toBe(right(browser));
  });

  it("puts the panel first when docked left, and does not overlap", () => {
    const { browser, panel } = expectSaneLayout(
      computeDock(BROWSER, PANEL_WIDTH, WORK_AREA, "left"),
    );
    expect(panel.x).toBe(BROWSER.x);
    expect(browser.x).toBe(right(panel));
  });

  it("matches the panel's height and top to the browser's", () => {
    const { browser, panel } = expectSaneLayout(computeDock(BROWSER, PANEL_WIDTH, WORK_AREA));
    expect(panel.y).toBe(browser.y);
    expect(panel.height).toBe(browser.height);
  });

  it("grows the pair rather than starving the browser below its floor", () => {
    // A browser barely wider than the panel: keeping the footprint would leave
    // it ~340px, which is a phone layout, not the site under test.
    const narrow: Bounds = { ...BROWSER, width: 700 };
    const { browser, panel } = expectSaneLayout(computeDock(narrow, PANEL_WIDTH, WORK_AREA));
    expect(browser.width).toBe(BROWSER_MIN_WIDTH);
    expect(browser.width + panel.width).toBeGreaterThan(narrow.width);
  });

  it("refuses to dock when the display cannot hold both at their minimums", () => {
    const tiny: Bounds = { x: 0, y: 0, width: BROWSER_MIN_WIDTH + PANEL_MIN_WIDTH - 1, height: 800 };
    expect(computeDock(BROWSER, PANEL_WIDTH, tiny)).toBeNull();
  });

  it("docks at exactly the minimum viable display width", () => {
    const exact: Bounds = { x: 0, y: 0, width: BROWSER_MIN_WIDTH + PANEL_MIN_WIDTH, height: 800 };
    const { browser, panel } = expectSaneLayout(computeDock(BROWSER, PANEL_MIN_WIDTH, exact), exact);
    expect(browser.width).toBe(BROWSER_MIN_WIDTH);
    expect(panel.width).toBe(PANEL_MIN_WIDTH);
  });

  it("pulls the pair back on-screen when the browser hangs off the right edge", () => {
    const hanging: Bounds = { ...BROWSER, x: 1700 };
    const { browser, panel } = expectSaneLayout(computeDock(hanging, PANEL_WIDTH, WORK_AREA));
    // Flush to the right edge — the invariant check already proved it is inside.
    expect(right(panel)).toBe(right(WORK_AREA));
    expect(browser.x).toBeLessThan(hanging.x);
  });

  it("respects a work area that does not start at the origin", () => {
    // A second display placed left of and above the built-in one: negative
    // origins are the case that catches code assuming 0,0.
    const secondary: Bounds = { x: -1920, y: -200, width: 1920, height: 1080 };
    const onIt: Bounds = { x: -1800, y: -100, width: 1200, height: 820 };
    expectSaneLayout(computeDock(onIt, PANEL_WIDTH, secondary), secondary);
  });

  it("clamps a browser taller than the work area instead of overflowing it", () => {
    const tall: Bounds = { ...BROWSER, y: 0, height: 2000 };
    const { browser, panel } = expectSaneLayout(computeDock(tall, PANEL_WIDTH, WORK_AREA));
    expect(browser.height).toBe(WORK_AREA.height);
    expect(panel.height).toBe(WORK_AREA.height);
  });

  it("holds both invariants while the browser is dragged across the display", () => {
    // Stands in for the follower running on every `move`: whatever the drag
    // does, the layout it produces must still be legal.
    for (let x = -400; x <= 2200; x += 100) {
      for (const side of ["right", "left"] as DockSide[]) {
        expectSaneLayout(computeDock({ ...BROWSER, x }, PANEL_WIDTH, WORK_AREA, side));
      }
    }
  });

  it("holds both invariants while the browser is resized", () => {
    for (let width = 400; width <= 2400; width += 100) {
      const layout = computeDock({ ...BROWSER, x: 0, width }, PANEL_WIDTH, WORK_AREA);
      expectSaneLayout(layout);
    }
  });

  it("never places a panel narrower than its floor, however small the ask", () => {
    const { panel } = expectSaneLayout(computeDock(BROWSER, 10, WORK_AREA));
    expect(panel.width).toBe(PANEL_MIN_WIDTH);
  });
});

// A session recording at a window-size preset. The browser's width is then the
// size the generated test replays at, not a footprint the user dragged, so the
// default split would leave the page rendering at one width while the recorded
// `viewport` step promises another — the two features cancelling out silently,
// which is the whole failure mode the preset exists to prevent.
describe("computeDock with a preserved browser width", () => {
  const KEEP = { preserveBrowserWidth: true };

  it("leaves the browser's width exactly alone", () => {
    const { browser, panel } = expectSaneLayout(
      computeDock(BROWSER, PANEL_WIDTH, WORK_AREA, "right", KEEP),
    );
    expect(browser.width).toBe(BROWSER.width);
    expect(panel.width).toBe(PANEL_WIDTH);
  });

  it("grows the pair's footprint instead of splitting it", () => {
    // The inverse of the default's total-preserving rule, stated directly.
    const { browser, panel } = expectSaneLayout(
      computeDock(BROWSER, PANEL_WIDTH, WORK_AREA, "right", KEEP),
    );
    expect(browser.width + panel.width).toBe(BROWSER.width + PANEL_WIDTH);
  });

  it("keeps a width BELOW the browser floor, which a mobile preset is", () => {
    // 390×844 is the Mobile preset and is far under BROWSER_MIN_WIDTH. The
    // floor stops docking from ACCIDENTALLY forcing a mobile layout; it must not
    // override one the user explicitly asked to record at.
    const mobile: Bounds = { x: 100, y: 100, width: 390, height: 844 };
    expect(mobile.width).toBeLessThan(BROWSER_MIN_WIDTH);
    const { browser } = expectSaneLayout(computeDock(mobile, PANEL_WIDTH, WORK_AREA, "right", KEEP));
    expect(browser.width).toBe(390);
  });

  it("refuses to dock rather than resize a browser it was told not to", () => {
    // The honest outcome when the preset plus a panel exceeds the display: the
    // caller opens the panel undocked, which it already knows how to do.
    const narrowDisplay: Bounds = { x: 0, y: 0, width: 1400, height: 900 };
    const wide: Bounds = { x: 0, y: 0, width: 1280, height: 800 };
    expect(computeDock(wide, PANEL_WIDTH, narrowDisplay, "right", KEEP)).toBeNull();
    // …and the default split still docks there, so this is the flag's doing and
    // not the display simply being too small for anything.
    expectSaneLayout(computeDock(wide, PANEL_WIDTH, narrowDisplay), narrowDisplay);
  });

  it("still refuses on a display too small for a usable pair at all", () => {
    const tiny: Bounds = { x: 0, y: 0, width: 500, height: 800 };
    expect(computeDock(BROWSER, PANEL_WIDTH, tiny, "right", KEEP)).toBeNull();
  });

  it("preserves the width docking to either side", () => {
    for (const side of ["left", "right"] as DockSide[]) {
      const { browser } = expectSaneLayout(
        computeDock(BROWSER, PANEL_WIDTH, WORK_AREA, side, KEEP),
      );
      expect(browser.width, `side ${side}`).toBe(BROWSER.width);
    }
  });

  it("pulls the pair back on-screen without shrinking the browser", () => {
    // A browser dragged against the right edge: the pair has to move left to
    // fit, but moving is free — resizing is what would break the recording.
    const hanging: Bounds = { x: 1700, y: 100, width: 1280, height: 800 };
    const { browser, panel } = expectSaneLayout(
      computeDock(hanging, PANEL_WIDTH, WORK_AREA, "right", KEEP),
    );
    expect(browser.width).toBe(1280);
    expect(right(panel)).toBeLessThanOrEqual(right(WORK_AREA));
  });
});

describe("computePanelFollow", () => {
  /** The docked starting arrangement every follow case begins from. */
  const DOCKED = computeDock(BROWSER, PANEL_WIDTH, WORK_AREA) as DockLayout;

  it("reproduces the docked panel when nothing has moved", () => {
    // The join between the two operations. If dock and follow disagreed, the
    // panel would jump the instant the user first touched the browser.
    const placed = computePanelFollow(DOCKED.browser, PANEL_WIDTH, WORK_AREA);
    expect(placed?.panel).toEqual(DOCKED.panel);
    expect(placed?.side).toBe("right");
  });

  it("is idempotent — following an already-followed pair does not creep", () => {
    // This is the regression that killed the single-function design: the
    // follower re-runs on every move and resize, including ones its own writes
    // provoke, so a rule that drifts by even a pixel per pass walks the windows
    // across the screen.
    let browser = DOCKED.browser;
    const first = computePanelFollow(browser, PANEL_WIDTH, WORK_AREA);
    for (let i = 0; i < 20; i++) {
      const again = computePanelFollow(browser, PANEL_WIDTH, WORK_AREA);
      expect(again?.panel).toEqual(first?.panel);
      browser = { ...browser };
    }
  });

  it("leaves the browser's own geometry alone", () => {
    // After docking, how big the browser is is the user's business. The old
    // design re-split the footprint here and silently undid their resize.
    const widened: Bounds = { ...DOCKED.browser, width: DOCKED.browser.width + 200 };
    const placed = computePanelFollow(widened, PANEL_WIDTH, WORK_AREA);
    expect(placed?.panel.x).toBe(widened.x + widened.width);
    expect(placed?.panel.width).toBe(PANEL_WIDTH);
  });

  it("tracks the browser's top and height", () => {
    const moved: Bounds = { ...DOCKED.browser, y: 300, height: 500 };
    const placed = computePanelFollow(moved, PANEL_WIDTH, WORK_AREA);
    expect(placed?.panel.y).toBe(300);
    expect(placed?.panel.height).toBe(500);
  });

  it("flips to the browser's left when the right edge has no room", () => {
    // Dragging the browser against the right edge of a monitor is ordinary.
    // Clamping the panel back would drop it on top of the page under test —
    // the exact thing this feature exists to prevent — so it moves instead.
    const flushRight: Bounds = { x: 1100, y: 100, width: 820, height: 820 };
    const placed = computePanelFollow(flushRight, PANEL_WIDTH, WORK_AREA);
    expect(placed?.side).toBe("left");
    expect(placed?.panel.x).toBe(flushRight.x - PANEL_WIDTH);
  });

  it("flips to the right when docked left and the left edge runs out", () => {
    const flushLeft: Bounds = { x: 0, y: 100, width: 820, height: 820 };
    const placed = computePanelFollow(flushLeft, PANEL_WIDTH, WORK_AREA, "left");
    expect(placed?.side).toBe("right");
    expect(placed?.panel.x).toBe(flushLeft.width);
  });

  it("gives up when neither side fits, rather than covering the page", () => {
    // A browser spanning the whole work area. Returning null is the caller's
    // cue to undock and say why.
    const fullWidth: Bounds = { x: 0, y: 25, width: 1920, height: 1055 };
    expect(computePanelFollow(fullWidth, PANEL_WIDTH, WORK_AREA)).toBeNull();
  });

  it("never overlaps the browser or leaves the work area, wherever it is dragged", () => {
    for (let x = -200; x <= 2000; x += 60) {
      const browser: Bounds = { x, y: 100, width: 900, height: 820 };
      const placed = computePanelFollow(browser, PANEL_WIDTH, WORK_AREA);
      if (placed === null) continue; // caller undocks; nothing to place
      const { panel } = placed;
      expect(panel.x).toBeGreaterThanOrEqual(WORK_AREA.x);
      expect(right(panel)).toBeLessThanOrEqual(right(WORK_AREA));
      // Flush to one edge or the other, never across the browser.
      const flush = panel.x === right(browser) || right(panel) === browser.x;
      expect(flush).toBe(true);
    }
  });
});

describe("computeUndock", () => {
  it("gives the browser back the width the panel was using", () => {
    const { browser } = expectSaneLayout(computeDock(BROWSER, PANEL_WIDTH, WORK_AREA));
    const restored = computeUndock(browser, PANEL_WIDTH, WORK_AREA);
    expect(restored).toEqual(BROWSER);
  });

  it("undoes the rightward shift that docking left applied", () => {
    const { browser } = expectSaneLayout(
      computeDock(BROWSER, PANEL_WIDTH, WORK_AREA, "left"),
    );
    const restored = computeUndock(browser, PANEL_WIDTH, WORK_AREA, "left");
    expect(restored).toEqual(BROWSER);
  });

  it("restores from where the browser is NOW, not where it was docked", () => {
    // The user is free to drag the browser while docked. Restoring a remembered
    // pre-dock rectangle would teleport it back across the screen.
    const { browser } = expectSaneLayout(computeDock(BROWSER, PANEL_WIDTH, WORK_AREA));
    const moved: Bounds = { ...browser, x: browser.x + 300, y: browser.y + 120 };
    const restored = computeUndock(moved, PANEL_WIDTH, WORK_AREA);
    expect(restored.x).toBe(moved.x);
    expect(restored.y).toBe(moved.y);
    expect(restored.width).toBe(moved.width + PANEL_WIDTH);
  });

  it("keeps the restored browser inside the work area", () => {
    const flushRight: Bounds = { x: 1500, y: 100, width: 400, height: 820 };
    const restored = computeUndock(flushRight, PANEL_WIDTH, WORK_AREA);
    expect(restored.x).toBeGreaterThanOrEqual(WORK_AREA.x);
    expect(right(restored)).toBeLessThanOrEqual(right(WORK_AREA));
  });
});

describe("boundsEqual", () => {
  it("is false when either side is null", () => {
    expect(boundsEqual(null, BROWSER)).toBe(false);
    expect(boundsEqual(BROWSER, null)).toBe(false);
    expect(boundsEqual(null, null)).toBe(false);
  });

  it("compares by value, not identity", () => {
    expect(boundsEqual(BROWSER, { ...BROWSER })).toBe(true);
  });

  it("notices a change in any single field", () => {
    for (const key of ["x", "y", "width", "height"] as (keyof Bounds)[]) {
      expect(boundsEqual(BROWSER, { ...BROWSER, [key]: BROWSER[key] + 1 })).toBe(false);
    }
  });
});

describe("isDuplicateApply", () => {
  it("suppresses the echo of a write we just made", () => {
    expect(isDuplicateApply({ bounds: BROWSER, at: 1000 }, { ...BROWSER }, 1100)).toBe(true);
  });

  it("lets a genuinely different rectangle through", () => {
    const moved = { ...BROWSER, x: BROWSER.x + 1 };
    expect(isDuplicateApply({ bounds: BROWSER, at: 1000 }, moved, 1100)).toBe(false);
  });

  it("lets the same rectangle through once the window has passed", () => {
    // Otherwise dragging a window away and back would be ignored forever.
    expect(isDuplicateApply({ bounds: BROWSER, at: 1000 }, { ...BROWSER }, 1600)).toBe(false);
  });

  it("suppresses nothing when there is no prior write", () => {
    expect(isDuplicateApply(null, BROWSER, 1000)).toBe(false);
  });
});
