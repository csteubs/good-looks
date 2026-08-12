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

/**
 * One measured area of change. REDESIGN §6.6, "what moved".
 *
 * Geometry is NORMALIZED (0–1) against the compared image, the same convention
 * as `VisualMask` and `ReplayStep.rect`, so the renderer can lay a box over the
 * frame at whatever size it happens to be drawn — a pixel rectangle would be
 * wrong the moment the viewer letterboxes.
 */
export interface DiffRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Changed pixels inside this box. */
  pixels: number;
  /** This box's share of ALL changed pixels, 0–1. What ranks the list. */
  share: number;
}

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
      /** Where the change is, largest first. Empty for a clean comparison. */
      regions: DiffRegion[];
      /** Regions found beyond `MAX_REGIONS` and folded away, so the UI can say
       *  "and 12 smaller" instead of implying the list is everything. */
      regionsOmitted: number;
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

// ── "What moved" — region breakdown (REDESIGN §6.6) ──────────────────
//
// A diff map is exact and nearly useless for triage: it lights every changed
// pixel with equal weight, so a font-smoothing shift across a paragraph and a
// button that moved 40px look identical. This turns the same pixels into a
// handful of MEASURED BOXES, ranked by how much of the change each holds, which
// is the form the question "what moved?" actually has an answer in.
//
// A COARSE GRID, NOT PER-PIXEL CONNECTED COMPONENTS, and that is the whole
// design. Per-pixel components on a 1280×3000 screenshot produce hundreds of
// one- and two-pixel specks from antialiasing — which is exactly the noise this
// exists to see past, reproduced in a new shape and with a ranking that puts
// real change below it. Snapping to a grid first merges a paragraph's worth of
// smoothing into one region and keeps a moved button its own, at a fraction of
// the memory: 40×95 cells rather than 3.8M pixels.

/** Target grid resolution along the image's longer edge. */
const GRID_CELLS = 48;
/** …and a floor, so a small element-scoped crop is not one single cell. */
const MIN_CELL_PX = 8;
/** How many regions are reported. The rest are counted, not listed — a triage
 *  list nobody can read is a diff map with extra steps. */
export const MAX_REGIONS = 8;

/**
 * Which pixels pixelmatch called changed, read back off the overlay it drew.
 *
 * IT IS READ FROM COLOUR, WHICH IS SAFE ONLY BECAUSE OF AN INVARIANT WE PIN.
 * pixelmatch draws unchanged pixels as GREYSCALE (it writes one luminance value
 * to r, g and b) and changed ones in `diffColor` / `aaColor`. So "r, g and b are
 * not all equal" identifies a changed pixel exactly — provided both marker
 * colours are non-grey, which is why `diffPngBuffers` passes them explicitly
 * rather than trusting the library's defaults to stay red and yellow.
 *
 * The alternative was a second `pixelmatch` pass with `diffMask`, which doubles
 * the most expensive step of capture to recover information the first pass
 * already wrote down.
 */
function changedCells(
  diff: PNG,
  cellPx: number,
): { counts: Int32Array; cols: number; rows: number } {
  const { width, height, data } = diff;
  const cols = Math.max(1, Math.ceil(width / cellPx));
  const rows = Math.max(1, Math.ceil(height / cellPx));
  const counts = new Int32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const cy = Math.floor(y / cellPx) * cols;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      if (r === data[i + 1] && r === data[i + 2]) continue; // grey ⇒ unchanged
      counts[cy + Math.floor(x / cellPx)]++;
    }
  }
  return { counts, cols, rows };
}

/**
 * Merge touching changed cells into boxes, largest first.
 *
 * Four-neighbour rather than eight: diagonal-only contact means two changes
 * that meet at a corner, which reads as two things to a person looking at the
 * page. Iterative flood fill rather than recursion — a full-page change is one
 * component covering every cell, and that is a stack overflow as recursion.
 */
function clusterRegions(
  counts: Int32Array,
  cols: number,
  rows: number,
  cellPx: number,
  width: number,
  height: number,
  changedPixels: number,
): { regions: DiffRegion[]; omitted: number } {
  const seen = new Uint8Array(cols * rows);
  const found: DiffRegion[] = [];
  const stack: number[] = [];

  for (let start = 0; start < counts.length; start++) {
    if (seen[start] === 1 || counts[start] === 0) continue;
    seen[start] = 1;
    stack.push(start);
    let minCol = cols;
    let maxCol = -1;
    let minRow = rows;
    let maxRow = -1;
    let pixels = 0;

    while (stack.length > 0) {
      const cell = stack.pop() as number;
      const col = cell % cols;
      const row = (cell - col) / cols;
      pixels += counts[cell];
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;

      if (col > 0) push(cell - 1);
      if (col < cols - 1) push(cell + 1);
      if (row > 0) push(cell - cols);
      if (row < rows - 1) push(cell + cols);
    }

    // Cell bounds → pixels → normalized, clamped to the image: the last row and
    // column are partial whenever the size is not a multiple of the cell.
    const x0 = (minCol * cellPx) / width;
    const y0 = (minRow * cellPx) / height;
    const x1 = Math.min(1, ((maxCol + 1) * cellPx) / width);
    const y1 = Math.min(1, ((maxRow + 1) * cellPx) / height);
    found.push({
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
      pixels,
      share: changedPixels > 0 ? pixels / changedPixels : 0,
    });
  }

  function push(cell: number): void {
    if (seen[cell] === 1 || counts[cell] === 0) return;
    seen[cell] = 1;
    stack.push(cell);
  }

  found.sort((a, b) => b.pixels - a.pixels);
  return {
    regions: found.slice(0, MAX_REGIONS),
    omitted: Math.max(0, found.length - MAX_REGIONS),
  };
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
      // PINNED, NOT DEFAULTED. `changedCells` identifies a changed pixel by it
      // not being grey, which holds only while both markers are non-grey — and
      // "pixelmatch changed a default colour" is a silent way to make every
      // region vanish. These are the library's own defaults, written down.
      diffColor: [255, 0, 0],
      aaColor: [255, 255, 0],
    });
  } catch (err) {
    return { state: "unable", reason: "diff failed: " + String(err) };
  }

  const ratio = changedPixels / totalPixels;
  const pct = ratio * 100;
  // Only for a comparison that found something. A clean frame has no regions,
  // and scanning a few million pixels to prove it is work with one answer.
  const cellPx = Math.max(MIN_CELL_PX, Math.ceil(Math.max(width, height) / GRID_CELLS));
  const { regions, omitted } =
    changedPixels > 0
      ? (() => {
          const grid = changedCells(diff, cellPx);
          return clusterRegions(
            grid.counts,
            grid.cols,
            grid.rows,
            cellPx,
            width,
            height,
            changedPixels,
          );
        })()
      : { regions: [], omitted: 0 };

  return {
    state: pct > threshold ? "changed" : "match",
    ratio,
    changedPixels,
    totalPixels,
    maskedPixels,
    diffPng: PNG.sync.write(diff),
    regions,
    regionsOmitted: omitted,
  };
}
