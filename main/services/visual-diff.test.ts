// Tests for pixel diffing.
//
// This decides whether a run is flagged "visual change detected", so both
// failure directions are expensive: a false positive trains users to ignore the
// flag, and a false negative is the regression the feature exists to catch.
// The "unable" outcomes matter just as much — degrading to "can't compare" is
// the deliberate alternative to guessing.

import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { MAX_REGIONS, diffPngBuffers, type MaskRect } from "./visual-diff.js";

/** Solid-colour PNG. */
function solid(r: number, g: number, b: number, w = 20, h = 20): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** A base image with a differently-coloured rectangle painted into it. */
function withPatch(
  base: [number, number, number],
  patch: [number, number, number],
  rect: { x: number; y: number; w: number; h: number },
  w = 20,
  h = 20,
): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const c = inside ? patch : base;
      png.data[o] = c[0];
      png.data[o + 1] = c[1];
      png.data[o + 2] = c[2];
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const RED = solid(220, 40, 40);
const BLUE = solid(40, 40, 220);

describe("identical images", () => {
  it("matches with a zero ratio", () => {
    const out = diffPngBuffers(RED, RED, 0.1);
    expect(out.state).toBe("match");
    if (out.state !== "unable") {
      expect(out.ratio).toBe(0);
      expect(out.changedPixels).toBe(0);
    }
  });
});

describe("changed images", () => {
  it("flags a wholly different image", () => {
    const out = diffPngBuffers(RED, BLUE, 0.1);
    expect(out.state).toBe("changed");
    if (out.state !== "unable") {
      expect(out.ratio).toBeGreaterThan(0.9);
      expect(out.diffPng.length).toBeGreaterThan(0);
    }
  });

  it("respects the threshold — a small change under it still matches", () => {
    // 4 of 400 pixels = 1%. At a 5% threshold that's noise; at 0.1% it's a
    // change. Same images, opposite verdicts: this is the knob users tune.
    const patched = withPatch([220, 40, 40], [40, 40, 220], { x: 0, y: 0, w: 2, h: 2 });
    expect(diffPngBuffers(RED, patched, 5).state).toBe("match");
    expect(diffPngBuffers(RED, patched, 0.1).state).toBe("changed");
  });

  it("reports the changed-pixel count and total", () => {
    const patched = withPatch([220, 40, 40], [40, 40, 220], { x: 0, y: 0, w: 2, h: 2 });
    const out = diffPngBuffers(RED, patched, 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.totalPixels).toBe(400);
    expect(out.changedPixels).toBe(4);
    expect(out.ratio).toBeCloseTo(0.01, 5);
  });
});

describe("ignore masks", () => {
  const patched = withPatch([220, 40, 40], [40, 40, 220], { x: 0, y: 0, w: 4, h: 4 });

  it("a mask over the changed region makes it compare equal", () => {
    // Dynamic content (clocks, carousels) would otherwise flag every run.
    const mask: MaskRect = { x: 0, y: 0, w: 0.25, h: 0.25 }; // top-left 5x5 of 20x20
    const out = diffPngBuffers(RED, patched, 0.1, 0.1, [mask]);
    expect(out.state).toBe("match");
    if (out.state !== "unable") {
      expect(out.changedPixels).toBe(0);
      expect(out.maskedPixels).toBeGreaterThan(0);
    }
  });

  it("a mask elsewhere does not hide a real change", () => {
    const mask: MaskRect = { x: 0.75, y: 0.75, w: 0.25, h: 0.25 };
    const out = diffPngBuffers(RED, patched, 0.1, 0.1, [mask]);
    expect(out.state).toBe("changed");
  });

  it("no masks means nothing is reported as masked", () => {
    const out = diffPngBuffers(RED, patched, 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.maskedPixels).toBe(0);
  });
});

describe("element-scoped comparison", () => {
  it("compares only the requested region", () => {
    // A change OUTSIDE the element's rect must not flag an element-scoped diff.
    const changedOutside = withPatch([220, 40, 40], [40, 40, 220], { x: 15, y: 15, w: 5, h: 5 });
    const region = {
      baseline: { x: 0, y: 0, w: 0.25, h: 0.25 },
      next: { x: 0, y: 0, w: 0.25, h: 0.25 },
    };
    const out = diffPngBuffers(RED, changedOutside, 0.1, 0.1, [], region);
    expect(out.state).toBe("match");
  });

  it("still flags a change inside the region", () => {
    const changedInside = withPatch([220, 40, 40], [40, 40, 220], { x: 0, y: 0, w: 4, h: 4 });
    const region = {
      baseline: { x: 0, y: 0, w: 0.25, h: 0.25 },
      next: { x: 0, y: 0, w: 0.25, h: 0.25 },
    };
    const out = diffPngBuffers(RED, changedInside, 0.1, 0.1, [], region);
    expect(out.state).toBe("changed");
  });
});

describe("degrading to 'unable' rather than guessing", () => {
  it("reports a size mismatch instead of a false change", () => {
    // A viewport change would otherwise read as "everything changed".
    const out = diffPngBuffers(RED, solid(220, 40, 40, 40, 40), 0.1);
    expect(out.state).toBe("unable");
  });

  it("reports a corrupt image instead of throwing", () => {
    const out = diffPngBuffers(Buffer.from("not a png"), RED, 0.1);
    expect(out.state).toBe("unable");
    if (out.state === "unable") expect(out.reason).toMatch(/decode/i);
  });

  it("handles an empty buffer", () => {
    expect(diffPngBuffers(Buffer.alloc(0), RED, 0.1).state).toBe("unable");
  });
});

// ── "What moved" — region breakdown (REDESIGN §6.6) ────────────────────
//
// A diff map lights every changed pixel with equal weight, so a paragraph's
// worth of font smoothing and a button that moved 40px look identical. These
// pin the properties that make the box list a better answer than the map:
// separate changes stay separate, touching ones merge, and the ranking is by
// how much of the change each box holds.
describe("region breakdown", () => {
  /** An image with any number of patches painted into it. */
  function patched(w: number, h: number, rects: Rect[]): Buffer {
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const inside = rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
        const c: [number, number, number] = inside ? [40, 40, 220] : [220, 40, 40];
        png.data[o] = c[0];
        png.data[o + 1] = c[1];
        png.data[o + 2] = c[2];
        png.data[o + 3] = 255;
      }
    }
    return PNG.sync.write(png);
  }

  const twoPatches = (w: number, h: number, a: Rect, b: Rect) => patched(w, h, [a, b]);
  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  const BIG_RED = solid(220, 40, 40, 200, 200);

  it("reports nothing at all for a clean comparison", () => {
    // Scanning a few million pixels to prove there is nothing there is work
    // with one answer, so it is not done.
    const out = diffPngBuffers(RED, RED, 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.regions).toEqual([]);
    expect(out.regionsOmitted).toBe(0);
  });

  it("keeps two separated changes as two regions", () => {
    // The one thing the diff map cannot say: that this is two things.
    const next = twoPatches(200, 200, { x: 4, y: 4, w: 12, h: 12 }, { x: 150, y: 150, w: 12, h: 12 });
    const out = diffPngBuffers(BIG_RED, next, 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.regions).toHaveLength(2);
  });

  it("merges touching change into ONE region rather than a spray of specks", () => {
    // The whole reason this snaps to a grid first. Per-pixel components on a
    // real screenshot produce hundreds of antialiasing specks, which is the
    // noise the feature exists to see past.
    const next = twoPatches(200, 200, { x: 20, y: 20, w: 40, h: 40 }, { x: 20, y: 20, w: 1, h: 1 });
    const out = diffPngBuffers(BIG_RED, next, 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.regions).toHaveLength(1);
  });

  it("merges a change the fill can only reach by travelling left and up", () => {
    // EVERY RECTANGULAR FIXTURE IS BLIND TO HALF THE FILL. The scan finds the
    // topmost-leftmost cell first, and from there a rectangle — or an L, or an
    // arch — is reachable going only right and down; drop the left and up
    // neighbours and those fixtures still pass. This is a "U" with unequal
    // legs, so the seed is the top of the RIGHT leg and the rest is reachable
    // only by going down, then left, then back up.
    const next = patched(200, 200, [
      { x: 80, y: 16, w: 8, h: 72 }, // right leg
      { x: 16, y: 80, w: 72, h: 8 }, // bottom bar
      { x: 16, y: 40, w: 8, h: 48 }, // left leg, starting lower
    ]);
    const out = diffPngBuffers(BIG_RED, next, 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.regions).toHaveLength(1);
  });

  it("ranks by how much of the change each box holds, largest first", () => {
    const next = twoPatches(200, 200, { x: 4, y: 4, w: 4, h: 4 }, { x: 120, y: 120, w: 40, h: 40 });
    const out = diffPngBuffers(BIG_RED, next, 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.regions[0].pixels).toBeGreaterThan(out.regions[1].pixels);
    expect(out.regions[0].share).toBeGreaterThan(out.regions[1].share);
    // Every changed pixel lands in exactly one region, so the shares are a
    // partition — a box list that does not add up is a box list that is hiding
    // something.
    const total = out.regions.reduce((n, r) => n + r.pixels, 0);
    expect(total).toBe(out.changedPixels);
    expect(out.regions.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1, 5);
  });

  it("measures a box that actually contains the change", () => {
    // Normalized against the compared image, like every other rect in this app
    // — a pixel rectangle would be wrong the moment the viewer letterboxes.
    const next = twoPatches(200, 200, { x: 100, y: 100, w: 40, h: 40 }, { x: 100, y: 100, w: 1, h: 1 });
    const out = diffPngBuffers(BIG_RED, next, 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    const r = out.regions[0];
    expect(r.x).toBeLessThanOrEqual(0.5);
    expect(r.y).toBeLessThanOrEqual(0.5);
    expect(r.x + r.w).toBeGreaterThanOrEqual(0.7);
    expect(r.y + r.h).toBeGreaterThanOrEqual(0.7);
    // And never past the edge, which the last partial row and column can do.
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });

  it("counts the regions it does not list rather than implying there are none", () => {
    // A triage list nobody can read is a diff map with extra steps, so it is
    // capped — but a cap that says nothing reads as "this is everything".
    const png = new PNG({ width: 200, height: 200 });
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        const o = (y * 200 + x) * 4;
        // A widely-spaced dot grid: many separate one-cell regions.
        const dot = x % 20 === 0 && y % 20 === 0;
        png.data[o] = dot ? 40 : 220;
        png.data[o + 1] = 40;
        png.data[o + 2] = dot ? 220 : 40;
        png.data[o + 3] = 255;
      }
    }
    const out = diffPngBuffers(BIG_RED, PNG.sync.write(png), 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.regions).toHaveLength(MAX_REGIONS);
    expect(out.regionsOmitted).toBeGreaterThan(0);
  });

  it("survives a change covering the whole frame", () => {
    // One component over every cell. As recursion this is a stack overflow,
    // which is why the flood fill is iterative.
    const out = diffPngBuffers(BIG_RED, solid(40, 40, 220, 200, 200), 0.1);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.regions).toHaveLength(1);
    expect(out.regions[0].share).toBeCloseTo(1, 5);
  });

  it("does not report a region for pixels an ignore mask equalized", () => {
    // Masked pixels compare equal, so they are not change — and a box drawn
    // over a region the user muted is the app arguing with them.
    const next = twoPatches(200, 200, { x: 4, y: 4, w: 12, h: 12 }, { x: 150, y: 150, w: 12, h: 12 });
    const out = diffPngBuffers(BIG_RED, next, 0.1, 0.1, [{ x: 0, y: 0, w: 0.2, h: 0.2 }]);
    if (out.state === "unable") throw new Error("expected a comparison");
    expect(out.regions).toHaveLength(1);
    expect(out.regions[0].x).toBeGreaterThan(0.5);
  });
});
