// What a window opens at when it should fill the display, as pure arithmetic.
//
// Split out of `main/index.ts` for the reason `panel-dock.ts` was split out of
// the trainer's window code: the cases worth checking are the ones you cannot
// reach by hand. A work area whose origin is negative (a second display placed
// left of the built-in one), and — the one that decides the shape of this
// function — a display SMALLER than the window's own layout floor. A 1280×800
// external at 125% has a work area narrower than the main window's 1200-point
// floor, and the floor is a measurement of what the widest toolbar needs, so it
// wins: a window that fits the screen but cannot lay `Run test` out is the bug
// the floor exists to prevent.
//
// When the floor does win, the overflow is pushed off the RIGHT and BOTTOM
// rather than centred, because anchoring at the work area's origin keeps the
// title bar and the sidebar — what the user reaches for to move or resize the
// window — on screen.

import type { Bounds } from "./panel-dock.js";

/** A window size in DIP points. */
export interface Size {
  width: number;
  height: number;
}

/**
 * The bounds a window fills `workArea` at, never smaller than `min`.
 *
 * Both arguments are in the points a window is sized in — `min` is a CSS-pixel
 * floor already through `scaled()`, and a display's work area is measured in
 * points to begin with. Neither is scaled here.
 */
export function fillWorkArea(workArea: Bounds, min: Size): Bounds {
  return {
    x: Math.round(workArea.x),
    y: Math.round(workArea.y),
    width: Math.round(Math.max(workArea.width, min.width)),
    height: Math.round(Math.max(workArea.height, min.height)),
  };
}
