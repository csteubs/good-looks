// The size a recording is made at.
//
// Two things need it and they must agree: the trainer window has to OPEN at
// that size, and the recorded test has to REPLAY at it. If only the window is
// sized, a test recorded at a mobile width runs at Playwright's own default
// (1280×720) and hits a desktop layout it never saw — the preset would be
// cosmetic. So a chosen size is also recorded as a `viewport` step, and that
// step is what an editing session sizes its window from.
//
// The numbers arrive from the renderer over IPC and end up (a) in a native
// window-creation call and (b) interpolated into a generated spec, so they are
// normalized here rather than trusted — see the capture-boundary rules in
// CLAUDE.md. This module is deliberately free of SDK imports so it can be
// tested directly.

import type { Step } from "./types.js";

export interface Viewport {
  width: number;
  height: number;
}

/** Smallest sensible page width/height. Below this the trainer's own chrome
 *  leaves no usable page area, and no real device is narrower. */
export const MIN_VIEWPORT = 200;

/** Ceiling on a requested size. Well past any real display, so it only ever
 *  catches a bogus value; the native layer clamps a window that doesn't fit
 *  the actual screen. */
export const MAX_VIEWPORT = 4000;

function clampAxis(n: number): number {
  return Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(n)));
}

/**
 * Turn an untrusted `{ width, height }` into a usable viewport, or null.
 *
 * Null means "no preset" — the caller keeps the trainer's default window size
 * and records no viewport step. Anything non-finite, non-numeric or missing an
 * axis is null too: a half-specified size is a bug somewhere upstream, and
 * guessing the other axis would silently record a size nobody chose.
 */
export function normalizeViewport(input: unknown): Viewport | null {
  if (!input || typeof input !== "object") return null;
  const { width, height } = input as { width?: unknown; height?: unknown };
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width: clampAxis(width), height: clampAxis(height) };
}

/**
 * The size an existing test was recorded at, from its first `viewport` step.
 *
 * First rather than last: a test may set the viewport again part-way through
 * (a responsive-layout check), but the window has to open at the size the run
 * starts with. Returns null when the test predates window-size presets, which
 * is why the trainer's default size has to stay a working fallback.
 */
export function recordedViewport(steps: readonly Step[]): Viewport | null {
  for (const step of steps) {
    if (step.type !== "viewport") continue;
    const vp = normalizeViewport({ width: step.width, height: step.height });
    if (vp) return vp;
  }
  return null;
}
