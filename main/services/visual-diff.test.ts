// Tests for pixel diffing.
//
// This decides whether a run is flagged "visual change detected", so both
// failure directions are expensive: a false positive trains users to ignore the
// flag, and a false negative is the regression the feature exists to catch.
// The "unable" outcomes matter just as much — degrading to "can't compare" is
// the deliberate alternative to guessing.

import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { diffPngBuffers, type MaskRect } from "./visual-diff.js";

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
