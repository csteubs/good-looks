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
      /** RGBA-diff overlay PNG (baseline vs new, changed pixels highlighted). */
      diffPng: Buffer;
    }
  | {
      /** couldn't compare — corrupt/missing image or dimension mismatch. */
      state: "unable";
      reason: string;
    };

/**
 * Compare two PNG buffers.
 * @param threshold percent of pixels (0–100) allowed to change before the
 *   result is flagged "changed". Below/equal → "match".
 * @param sensitivity per-pixel color-distance sensitivity for pixelmatch
 *   (0–1, lower = stricter). Fixed; the user-facing knob is `threshold`.
 */
export function diffPngBuffers(
  baseline: Buffer,
  next: Buffer,
  threshold: number,
  sensitivity = 0.1,
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
    diffPng: PNG.sync.write(diff),
  };
}
