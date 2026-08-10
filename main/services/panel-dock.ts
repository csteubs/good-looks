// Where the trainer panel sits relative to the training browser, as pure
// arithmetic.
//
// Extracted from the window code for the same reason `recorder-navigation.ts`
// and `trainer-window-gate.ts` were: the interesting cases are the ones you
// cannot reach by hand. A display too narrow to hold both windows, a browser
// dragged half off the right edge, a monitor whose work area starts at a
// negative x (a second display placed left of the built-in one) — each is one
// call to a pure function here, and none of them needs a window to exist.
//
// There are deliberately TWO operations here, and conflating them is a bug the
// tests caught:
//
//   computeDock         runs ONCE, when docking. It splits the browser's
//                       current footprint into browser + panel — total-
//                       preserving, because the user picked how much screen the
//                       training browser takes and docking a panel is not a
//                       licence to take more.
//
//   computePanelFollow  runs on EVERY move and resize thereafter. It places the
//                       panel against the browser's current edge and does not
//                       touch the browser at all.
//
// One function serving both would re-split an already-split footprint on every
// drag, walking the browser a panel-width narrower each time until it hit its
// floor. It would also fight the user: resizing the browser would be undone by
// the follower a frame later. After the initial dock the browser's geometry is
// the user's business, and the panel's job is only to keep up.

/** A window rectangle in DIP points, matching the SDK's `Rectangle`. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which edge of the training browser the panel is pinned to. */
export type DockSide = "right" | "left";

/** Default panel width — wide enough for a step row's text plus its actions. */
export const PANEL_WIDTH = 360;

/** Below this the step list stops being readable, so it is the floor. */
export const PANEL_MIN_WIDTH = 300;

/**
 * The training browser's floor. Not a cosmetic minimum: below roughly this
 * width most sites flip to a mobile layout, which would silently change what
 * the user is recording against. Refusing to dock is the honest outcome.
 */
export const BROWSER_MIN_WIDTH = 600;

/** Both windows, positioned. */
export interface DockLayout {
  browser: Bounds;
  panel: Bounds;
}

function clamp(value: number, low: number, high: number): number {
  // `high < low` when the work area is smaller than the thing being placed.
  // Prefer the low edge: a window flush to the top-left of the display is
  // recoverable, one placed at a negative offset from it may not be.
  if (high < low) return low;
  return Math.min(high, Math.max(low, value));
}

/** Where the panel ended up, and which side it actually landed on. */
export interface PanelPlacement {
  panel: Bounds;
  side: DockSide;
}

/** Dock-time options. */
export interface DockOptions {
  /**
   * Keep the browser's width exactly, and grow the pair's total footprint by
   * the panel instead of splitting it.
   *
   * For a session recording at a WINDOW SIZE PRESET. The default split rests on
   * "the user picked how much screen the training browser takes, and docking is
   * not a licence to take more" — true when the width is just a window the user
   * dragged, false when it is the page size the test replays at. Taking 360pt
   * from a 390-wide mobile recording would leave the browser rendering one
   * layout while the recorded `viewport` step promises another, which is the
   * exact divergence the preset exists to prevent.
   *
   * Costs the honesty of the "won't fit" answer, not correctness: when the
   * preset plus a panel exceeds the display, this returns `null` and the panel
   * opens undocked rather than quietly resizing what it was told not to.
   */
  preserveBrowserWidth?: boolean;
}

/**
 * Split `browser`'s footprint into a browser and a panel pinned to `side`.
 *
 * The DOCK-TIME operation only — see the note at the top of this file. Once
 * docked, the follower uses `computePanelFollow`, which leaves the browser
 * alone.
 *
 * Returns `null` when the display genuinely cannot hold both at their
 * minimums — the caller must then leave the panel undocked rather than
 * produce an overlapping or off-screen arrangement.
 */
export function computeDock(
  browser: Bounds,
  panelWidth: number,
  workArea: Bounds,
  side: DockSide = "right",
  opts: DockOptions = {},
): DockLayout | null {
  const pw = Math.round(clamp(panelWidth, PANEL_MIN_WIDTH, workArea.width));
  const minTotal = BROWSER_MIN_WIDTH + pw;

  // Not "the panel won't fit" — "this display cannot hold a usable pair".
  if (workArea.width < minTotal) return null;

  // A preserved width is the size the test replays at, so it is not negotiable:
  // if the pair doesn't fit, refuse to dock rather than resize the browser. Not
  // floored at BROWSER_MIN_WIDTH either — a 390-wide mobile preset is BELOW that
  // floor by design, and the floor exists to stop docking from ACCIDENTALLY
  // forcing a mobile layout, not to forbid one the user asked for.
  if (opts.preserveBrowserWidth) {
    const wanted = Math.round(browser.width) + pw;
    if (wanted > workArea.width) return null;
  }

  // Keep the footprint the user already chose, unless that would push the
  // browser under its floor; then grow, but never past the work area.
  const total = opts.preserveBrowserWidth
    ? Math.round(browser.width) + pw
    : Math.round(Math.min(Math.max(browser.width, minTotal), workArea.width));

  const height = Math.round(Math.min(browser.height, workArea.height));
  const y = Math.round(clamp(browser.y, workArea.y, workArea.y + workArea.height - height));
  const x = Math.round(clamp(browser.x, workArea.x, workArea.x + workArea.width - total));

  const browserWidth = total - pw;

  if (side === "left") {
    return {
      panel: { x, y, width: pw, height },
      browser: { x: x + pw, y, width: browserWidth, height },
    };
  }
  return {
    browser: { x, y, width: browserWidth, height },
    panel: { x: x + browserWidth, y, width: pw, height },
  };
}

/**
 * Place the panel flush against the browser's current edge, without moving or
 * resizing the browser.
 *
 * This is what runs on every `move` and `resize`, so it must be cheap, total,
 * and idempotent — re-running it on an already-followed pair reproduces the
 * same rectangle, or the panel would creep on each event.
 *
 * When the preferred side has no room left on the display, it FLIPS to the
 * other side rather than giving up: dragging the browser against the right edge
 * of a monitor is ordinary, and moving the panel to the browser's left keeps
 * both windows whole and visible. Only when neither side fits does it return
 * `null`, which the caller treats as "undock, and say why" — clamping instead
 * would put the panel on top of the page the user is training against, which is
 * the one thing this feature exists to avoid.
 */
export function computePanelFollow(
  browser: Bounds,
  panelWidth: number,
  workArea: Bounds,
  preferred: DockSide = "right",
): PanelPlacement | null {
  const pw = Math.round(clamp(panelWidth, PANEL_MIN_WIDTH, workArea.width));
  const height = Math.round(Math.min(browser.height, workArea.height));
  const y = Math.round(clamp(browser.y, workArea.y, workArea.y + workArea.height - height));

  const order: DockSide[] = preferred === "right" ? ["right", "left"] : ["left", "right"];
  for (const side of order) {
    const x = Math.round(side === "right" ? browser.x + browser.width : browser.x - pw);
    if (x >= workArea.x && x + pw <= workArea.x + workArea.width) {
      return { panel: { x, y, width: pw, height }, side };
    }
  }
  return null;
}

/**
 * Where the panel goes when it opens but CANNOT dock.
 *
 * `computeDock` returning `null` means "this display cannot hold the pair", and
 * the caller's answer is to open the panel undocked. Undocked is not the same
 * as unplaced: leaving the coordinates off hands the decision to the window
 * layer, which centres a new window on the display — dead centre over the page
 * being trained against, which is the single outcome the whole feature exists
 * to avoid. That is what shipped, and it is invisible in every test that only
 * looks at `computeDock`.
 *
 * So: place it deliberately, and prefer in this order.
 *   1. Flush beside the browser, if a whole panel fits there on-screen. Docking
 *      was refused, not "there is nowhere sensible to be" — those are different
 *      questions, and `computePanelFollow` already answers the second.
 *   2. Otherwise against a work-area edge, choosing the edge that covers LESS
 *      of the browser. Some overlap is unavoidable here by definition (a pair
 *      that fitted would have docked); how much of the page it eats is not.
 *
 * The panel keeps the docked geometry otherwise — same top, same height — so a
 * parked panel reads as the panel that would be docked, rather than a stray
 * window that happens to be open.
 */
export function computeParkedPanel(
  browser: Bounds,
  panelWidth: number,
  workArea: Bounds,
  preferred: DockSide = "right",
): Bounds {
  const beside = computePanelFollow(browser, panelWidth, workArea, preferred);
  if (beside) return beside.panel;

  const pw = Math.round(clamp(panelWidth, PANEL_MIN_WIDTH, workArea.width));
  const height = Math.round(Math.min(browser.height, workArea.height));
  const y = Math.round(clamp(browser.y, workArea.y, workArea.y + workArea.height - height));

  const atLeft = Math.round(workArea.x);
  const atRight = Math.round(workArea.x + workArea.width - pw);
  const covered = (x: number): number =>
    Math.max(0, Math.min(x + pw, browser.x + browser.width) - Math.max(x, browser.x));

  const leftCover = covered(atLeft);
  const rightCover = covered(atRight);
  // A tie is the symmetric case (a browser centred on the display), where the
  // two edges are equally good — so the user's preferred side decides, and the
  // result stays on the side a dock would have used.
  const x =
    leftCover === rightCover
      ? preferred === "right"
        ? atRight
        : atLeft
      : leftCover < rightCover
        ? atLeft
        : atRight;

  return { x, y, width: pw, height };
}

/**
 * The browser's bounds after the panel is undocked — it reclaims the width the
 * panel was occupying, so undocking is visually the inverse of docking.
 *
 * Derived from the CURRENT browser bounds rather than a remembered
 * pre-dock rectangle, because the user is free to move and resize the browser
 * while docked; restoring a stale rectangle would teleport the window.
 */
export function computeUndock(
  browser: Bounds,
  panelWidth: number,
  workArea: Bounds,
  side: DockSide = "right",
): Bounds {
  const pw = Math.round(clamp(panelWidth, PANEL_MIN_WIDTH, workArea.width));
  const width = Math.round(Math.min(browser.width + pw, workArea.width));
  // Docking to the left moved the browser right by the panel width; give that
  // back, or undocking would leave the browser shifted a panel-width over.
  const desiredX = side === "left" ? browser.x - pw : browser.x;
  const x = Math.round(clamp(desiredX, workArea.x, workArea.x + workArea.width - width));
  const height = Math.round(Math.min(browser.height, workArea.height));
  const y = Math.round(clamp(browser.y, workArea.y, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

/** Exact rectangle equality, for recognising our own writes coming back. */
export function boundsEqual(a: Bounds | null, b: Bounds | null): boolean {
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Whether a bounds change is the echo of one we just applied.
 *
 * The loop this exists to break is the one mabl shipped: we resize the browser
 * to make room, its `resize` fires, we reposition the panel, the panel's move
 * fires, and round it goes. A flag around the write is not enough on its own —
 * the native side can deliver the event a tick later, after the flag has
 * cleared — so identity is checked against a short time window too.
 *
 * Mirrors `isDuplicateContainment` in `recorder-navigation.ts`, deliberately:
 * the two guards defend the same class of reentrancy.
 */
export function isDuplicateApply(
  last: { bounds: Bounds; at: number } | null,
  bounds: Bounds,
  now: number,
  windowMs = 500,
): boolean {
  return last !== null && boundsEqual(last.bounds, bounds) && now - last.at < windowMs;
}
