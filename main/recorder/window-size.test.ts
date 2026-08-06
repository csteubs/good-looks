// The size a recording is made at, on both of its paths: a preset chosen in
// the New Recording dialog, and the size an existing test was recorded at.
//
// Both feed a native window-creation call AND a `viewport` step that ends up
// interpolated into a generated spec, so a bad value doesn't fail loudly — it
// either opens an unusable window or writes a number into executable source.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

import type { Step } from "./types.js";
import {
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  normalizeViewport,
  recordedViewport,
} from "./window-size.js";

function step(partial: Partial<Step>): Step {
  return { id: "s", type: "click", timestamp: 0, ...partial } as Step;
}

describe("normalizeViewport", () => {
  it("keeps a preset size unchanged", () => {
    expect(normalizeViewport({ width: 390, height: 844 })).toEqual({ width: 390, height: 844 });
  });

  it("treats a missing size as no preset", () => {
    // The trainer's default window size, and no viewport step recorded.
    expect(normalizeViewport(undefined)).toBeNull();
    expect(normalizeViewport(null)).toBeNull();
  });

  it("rejects a non-numeric size", () => {
    // A TypeScript type is not a runtime check: this arrives over IPC, and a
    // string reaching the generator would be interpolated as bare source.
    expect(normalizeViewport({ width: "1280", height: "800" })).toBeNull();
    expect(normalizeViewport({ width: "1280); process.exit(1); //", height: 800 })).toBeNull();
    expect(normalizeViewport("1280x800")).toBeNull();
  });

  it("rejects a non-finite or non-positive size", () => {
    expect(normalizeViewport({ width: NaN, height: 800 })).toBeNull();
    expect(normalizeViewport({ width: Infinity, height: 800 })).toBeNull();
    expect(normalizeViewport({ width: 0, height: 800 })).toBeNull();
    expect(normalizeViewport({ width: -1280, height: 800 })).toBeNull();
  });

  it("rejects a half-specified size rather than guessing the other axis", () => {
    // Guessing would silently record a size the user never chose, and the test
    // would then replay at it forever.
    expect(normalizeViewport({ width: 1280 })).toBeNull();
    expect(normalizeViewport({ height: 800 })).toBeNull();
  });

  it("clamps an out-of-range size into something a window can be", () => {
    expect(normalizeViewport({ width: 10, height: 5 })).toEqual({
      width: MIN_VIEWPORT,
      height: MIN_VIEWPORT,
    });
    expect(normalizeViewport({ width: 99999, height: 99999 })).toEqual({
      width: MAX_VIEWPORT,
      height: MAX_VIEWPORT,
    });
  });

  it("rounds a fractional size", () => {
    // setViewportSize takes integers, and a fractional window size is a
    // half-pixel page the screenshots then differ by.
    expect(normalizeViewport({ width: 1280.4, height: 800.6 })).toEqual({
      width: 1280,
      height: 801,
    });
  });
});

describe("recordedViewport", () => {
  it("finds the size an existing test was recorded at", () => {
    const steps = [
      step({ type: "viewport", width: 390, height: 844 }),
      step({ type: "goto", url: "https://example.com" }),
    ];
    expect(recordedViewport(steps)).toEqual({ width: 390, height: 844 });
  });

  it("takes the FIRST viewport step, not the last", () => {
    // A responsive test resizes part-way through; the window still has to open
    // at the size the run starts with.
    const steps = [
      step({ type: "viewport", width: 1280, height: 800 }),
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "viewport", width: 390, height: 844 }),
    ];
    expect(recordedViewport(steps)).toEqual({ width: 1280, height: 800 });
  });

  it("returns null for a test recorded before window-size presets existed", () => {
    // Every test already on disk looks like this, so the trainer's default
    // window size has to stay a working fallback.
    expect(recordedViewport([step({ type: "goto", url: "https://example.com" })])).toBeNull();
    expect(recordedViewport([])).toBeNull();
  });

  it("skips a viewport step with an unusable size", () => {
    // Stored steps are editable (Edit Steps, and the JSON on disk), so a
    // viewport step is not guaranteed to carry two good numbers.
    const steps = [
      step({ type: "viewport", width: 0, height: 0 }),
      step({ type: "viewport", width: 768, height: 1024 }),
    ];
    expect(recordedViewport(steps)).toEqual({ width: 768, height: 1024 });
  });
});

describe("recorder-service wiring", () => {
  // These two functions only matter if start() actually uses them, and start()
  // is unreachable from a test — it creates a real BrowserWindow. Checked at
  // source level, the approach trainer-window-gate.test.ts already takes for
  // the same reason.
  function serviceSource(): string {
    return readFileSync(new URL("../services/recorder-service.ts", import.meta.url), "utf-8");
  }

  it("records the viewport step BEFORE the goto step", () => {
    // Order is the point. `page.setViewportSize` after `page.goto` means the
    // first paint — and anything the site decides from it, like serving a
    // mobile layout — happens at the runner's default size instead.
    const src = serviceSource();
    const viewportStep = src.indexOf('addStep({ type: "viewport"');
    const gotoStep = src.indexOf('addStep({ type: "goto", url })');
    expect(viewportStep, "no viewport step is recorded for a new recording").toBeGreaterThan(-1);
    expect(gotoStep).toBeGreaterThan(-1);
    expect(viewportStep, "the viewport step is recorded after the goto").toBeLessThan(gotoStep);
  });

  it("sizes the training window's PAGE, not its frame, when a preset is used", () => {
    // Without useContentSize the numbers size the native frame, so the page is
    // short by the title bar — the window would then disagree with the very
    // viewport step the same call just recorded.
    expect(serviceSource()).toContain("useContentSize: !!viewport");
  });

  it("takes an editing session's size from the test rather than the dialog", () => {
    // Re-opening a mobile test in a desktop-width window would capture steps
    // against a layout the test never runs at.
    const src = serviceSource();
    expect(src).toMatch(/editing\s*\?\s*recordedViewport\(existingSteps\)/);
    expect(src, "the dialog's preset is not normalized").toContain(
      "normalizeViewport(params.viewport)",
    );
  });
});
