// Page-level screenshot diffing (Phase 3 of the visual-testing roadmap).
//
// Pure-JS pipeline — pngjs decodes PNG → RGBA, pixelmatch compares pixel-by-
// pixel and paints an overlay. No native bindings (deliberate: native image
// libs are a code-signing/notarization hazard across Intel/Apple Silicon).
//
// Every failure path degrades to { state: "unable", reason } — a corrupt image,
// a decode error, or a size mismatch (e.g. a viewport/responsive change) must
// NEVER crash a run or false-flag a visual change.

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** Result of comparing one new screenshot against its pinned baseline. */
export type DiffOutcome =
  | {
      state: "match" | "changed";
      /** fraction of pixels that changed, 0–1. */
      ratio: number;
      changedPixels: number;
      totalPixels: number;
      /** pixels covered by ignore masks (already equalized, so never counted
       *  as changed). Surfaced so the UI can say how much was ignored. */
      maskedPixels: number;
      /** RGBA-diff overlay PNG (baseline vs new, changed pixels highlighted). */
      diffPng: Buffer;
    }
  | {
      /** couldn't compare — corrupt/missing image or dimension mismatch. */
      state: "unable";
      reason: string;
    };

/** A normalized (0–1) rectangle to ignore. Mirrors VisualMask's geometry
 *  without dragging the whole record type into this pure module. */
export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Solid fill painted over masked regions. The exact color is irrelevant —
 *  what matters is that BOTH images get the same one, so those pixels compare
 *  equal and can never be counted as changed. */
const MASK_FILL: [number, number, number, number] = [0, 0, 0, 255];

/** Paint every mask into an RGBA buffer in place, returning how many distinct
 *  pixels were covered (overlapping masks are counted once, via `seen`). */
function applyMasks(
  png: PNG,
  masks: readonly MaskRect[],
  seen?: Uint8Array,
): number {
  let painted = 0;
  const { width, height, data } = png;
  for (const m of masks) {
    // Normalized → pixel bounds, clamped to the image so an out-of-range or
    // inverted mask can't read/write outside the buffer.
    const x0 = Math.max(0, Math.min(width, Math.round(m.x * width)));
    const y0 = Math.max(0, Math.min(height, Math.round(m.y * height)));
    const x1 = Math.max(x0, Math.min(width, Math.round((m.x + m.w) * width)));
    const y1 = Math.max(y0, Math.min(height, Math.round((m.y + m.h) * height)));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const px = y * width + x;
        const i = px * 4;
        data[i] = MASK_FILL[0];
        data[i + 1] = MASK_FILL[1];
        data[i + 2] = MASK_FILL[2];
        data[i + 3] = MASK_FILL[3];
        if (seen) {
          if (seen[px] === 0) {
            seen[px] = 1;
            painted++;
          }
        } else {
          painted++;
        }
      }
    }
  }
  return painted;
}

/**
 * Compare two PNG buffers.
 * @param threshold percent of pixels (0–100) allowed to change before the
 *   result is flagged "changed". Below/equal → "match".
 * @param sensitivity per-pixel color-distance sensitivity for pixelmatch
 *   (0–1, lower = stricter). Fixed; the user-facing knob is `threshold`.
 * @param masks normalized regions to ignore. Both images are painted with the
 *   same solid fill there, so masked pixels always compare equal — the ratio
 *   stays "changed pixels ÷ all pixels" with no special-casing downstream.
 */
export function diffPngBuffers(
  baseline: Buffer,
  next: Buffer,
  threshold: number,
  sensitivity = 0.1,
  masks: readonly MaskRect[] = [],
): DiffOutcome {
  let a: PNG;
  let b: PNG;
  try {
    a = PNG.sync.read(baseline);
    b = PNG.sync.read(next);
  } catch (err) {
    return { state: "unable", reason: "could not decode image: " + String(err) };
  }
  if (a.width !== b.width || a.height !== b.height) {
    return {
      state: "unable",
      reason: `size mismatch (baseline ${a.width}×${a.height}, new ${b.width}×${b.height})`,
    };
  }
  const { width, height } = a;
  const totalPixels = width * height;
  if (totalPixels === 0) return { state: "unable", reason: "empty image" };

  // Equalize masked regions BEFORE comparing. Done on the decoded copies, so
  // the stored screenshots and baselines are never modified.
  let maskedPixels = 0;
  if (masks.length > 0) {
    const seen = new Uint8Array(totalPixels);
    maskedPixels = applyMasks(a, masks, seen);
    applyMasks(b, masks);
  }

  const diff = new PNG({ width, height });
  let changedPixels: number;
  try {
    changedPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
      threshold: sensitivity,
    });
  } catch (err) {
    return { state: "unable", reason: "diff failed: " + String(err) };
  }

  const ratio = changedPixels / totalPixels;
  const pct = ratio * 100;
  return {
    state: pct > threshold ? "changed" : "match",
    ratio,
    changedPixels,
    totalPixels,
    maskedPixels,
    diffPng: PNG.sync.write(diff),
  };
}
