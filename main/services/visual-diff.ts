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

/** Crop an RGBA image to a normalized region, returning a new PNG. Bounds are
 *  clamped and rounded to whole pixels; an empty result returns null. */
function cropTo(png: PNG, r: MaskRect): PNG | null {
  const x0 = Math.max(0, Math.min(png.width, Math.round(r.x * png.width)));
  const y0 = Math.max(0, Math.min(png.height, Math.round(r.y * png.height)));
  const x1 = Math.max(x0, Math.min(png.width, Math.round((r.x + r.w) * png.width)));
  const y1 = Math.max(y0, Math.min(png.height, Math.round((r.y + r.h) * png.height)));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const src = ((y + y0) * png.width + x0) * 4;
    png.data.copy(out.data, y * width * 4, src, src + width * 4);
  }
  return out;
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
 * @param region component-level diffing: crop each image to the element's
 *   recorded rectangle before comparing, so unrelated page changes don't count.
 *   The two rects are measured independently (baseline run vs this run), so a
 *   size difference means the element moved/resized — reported as "unable"
 *   rather than diffing mismatched crops.
 */
export function diffPngBuffers(
  baseline: Buffer,
  next: Buffer,
  threshold: number,
  sensitivity = 0.1,
  masks: readonly MaskRect[] = [],
  region?: { baseline: MaskRect; next: MaskRect },
): DiffOutcome {
  let a: PNG;
  let b: PNG;
  try {
    a = PNG.sync.read(baseline);
    b = PNG.sync.read(next);
  } catch (err) {
    return { state: "unable", reason: "could not decode image: " + String(err) };
  }
  // Component-level: crop to the element's recorded rectangle in each image.
  let cropMask: ((m: MaskRect) => MaskRect) | null = null;
  if (region) {
    const ca = cropTo(a, region.baseline);
    const cb = cropTo(b, region.next);
    if (!ca || !cb) return { state: "unable", reason: "element region is empty" };
    if (ca.width !== cb.width || ca.height !== cb.height) {
      return {
        state: "unable",
        reason: `element moved or resized (baseline ${ca.width}×${ca.height}, new ${cb.width}×${cb.height})`,
      };
    }
    a = ca;
    b = cb;
    // Masks are page-normalized; re-express them relative to the crop so they
    // still cover the same part of the page.
    const r = region.next;
    cropMask = (m) => ({
      x: (m.x - r.x) / r.w,
      y: (m.y - r.y) / r.h,
      w: m.w / r.w,
      h: m.h / r.h,
    });
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
    const effective = cropMask ? masks.map(cropMask) : masks;
    const seen = new Uint8Array(totalPixels);
    maskedPixels = applyMasks(a, effective, seen);
    applyMasks(b, effective);
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
