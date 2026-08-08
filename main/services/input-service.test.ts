// The native half of a `state` step.
//
// Everything here is about a real pointer in the user's live training window,
// which is why the failure modes are worse than a wrong assertion: a press at
// the wrong coordinate is a real click on whatever is there, and a press with
// no release leaves the window in a drag the user then has to discover.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyStateStep,
  isMouseHeld,
  releaseHeldMouse,
  resetInputState,
  toWindowPoint,
  type InputHost,
} from "./input-service.js";
import type { Step } from "../recorder/types.js";

function step(elementState: Step["elementState"]): Step {
  return { id: "s", timestamp: 0, type: "state", elementState } as Step;
}

function host(opts: { zoom?: number; destroyed?: boolean; throws?: boolean } = {}) {
  const sent: { type: string; x: number; y: number; button?: string }[] = [];
  const h: InputHost = {
    isDestroyed: () => opts.destroyed ?? false,
    webContents: {
      sendInputEvent: vi.fn((e) => {
        if (opts.throws) throw new Error("native bridge is gone");
        sent.push(e as { type: string; x: number; y: number; button?: string });
      }),
      getZoomFactor: () => opts.zoom ?? 1,
    },
  };
  return { h, sent };
}

beforeEach(() => {
  resetInputState();
});

describe("toWindowPoint", () => {
  it("scales CSS pixels by the zoom factor", () => {
    expect(toWindowPoint({ x: 100, y: 50 }, 2)).toEqual({ x: 200, y: 100 });
  });

  it("rounds, because sendInputEvent rejects a non-finite coordinate", () => {
    expect(toWindowPoint({ x: 33.3, y: 10.7 }, 1.5)).toEqual({ x: 50, y: 16 });
  });

  it("falls back to 1x for a zoom factor that isn't a usable number", () => {
    // A missing or zero zoom must not collapse every coordinate to the origin —
    // that would silently retarget every hover to the top-left of the page.
    for (const z of [0, -1, NaN, Infinity]) {
      expect(toWindowPoint({ x: 40, y: 20 }, z)).toEqual({ x: 40, y: 20 });
    }
  });
});

describe("hover", () => {
  it("moves the pointer to the reported point", () => {
    const { h, sent } = host();
    const res = applyStateStep(h, step("hover"), { x: 50, y: 10 });
    expect(res.ok).toBe(true);
    expect(sent).toEqual([{ type: "mouseMove", x: 50, y: 10 }]);
  });

  it("applies the window's zoom factor", () => {
    const { h, sent } = host({ zoom: 2 });
    applyStateStep(h, step("hover"), { x: 50, y: 10 });
    expect(sent[0]).toMatchObject({ x: 100, y: 20 });
  });

  it("fails rather than guessing when the page reported no point", () => {
    const { h, sent } = host();
    const res = applyStateStep(h, step("hover"), null);
    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("reports a native failure instead of claiming the pointer moved", () => {
    const { h } = host({ throws: true });
    const res = applyStateStep(h, step("hover"), { x: 1, y: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("native bridge is gone");
  });
});

describe("press and release", () => {
  it("presses at the point the preceding hover established", () => {
    const { h, sent } = host();
    applyStateStep(h, step("hover"), { x: 50, y: 10 });
    const res = applyStateStep(h, step("press"), null);
    expect(res.ok).toBe(true);
    expect(sent[1]).toEqual({ type: "mouseDown", x: 50, y: 10, button: "left", clickCount: 1 });
  });

  it("REFUSES a press with no preceding hover instead of clicking the origin", () => {
    // The most important assertion in this file. sendInputEvent would accept
    // (0, 0) happily, and that is a real left click on the top-left corner of
    // whatever page is loaded — possibly a link, in the user's live window.
    const { h, sent } = host();
    const res = applyStateStep(h, step("press"), null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Hover/);
    expect(sent).toHaveLength(0);
    expect(isMouseHeld()).toBe(false);
  });

  it("tracks the held button across press and release", () => {
    const { h } = host();
    applyStateStep(h, step("hover"), { x: 5, y: 5 });
    expect(isMouseHeld()).toBe(false);
    applyStateStep(h, step("press"), null);
    expect(isMouseHeld()).toBe(true);
    applyStateStep(h, step("release"), null);
    expect(isMouseHeld()).toBe(false);
  });
});

describe("releaseHeldMouse — the stuck-button safety net", () => {
  it("releases a button an aborted replay left held", () => {
    // The real scenario: a css assertion between press and release fails, the
    // replay stops there, and the training window stays open. Without this the
    // user's next click in that window is a drag.
    const { h, sent } = host();
    applyStateStep(h, step("hover"), { x: 20, y: 30 });
    applyStateStep(h, step("press"), null);
    sent.length = 0;

    const logs = releaseHeldMouse(h);

    expect(sent).toEqual([{ type: "mouseUp", x: 20, y: 30, button: "left", clickCount: 1 }]);
    expect(isMouseHeld()).toBe(false);
    expect(logs[0]?.m).toMatch(/Released/);
  });

  it("does nothing when no button is held", () => {
    // It runs in a `finally` on every replay path, so the common case is that
    // there is nothing to do — and it must not emit a stray mouseUp, which
    // would land as a click on whatever is under the pointer.
    const { h, sent } = host();
    expect(releaseHeldMouse(h)).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("is idempotent", () => {
    const { h, sent } = host();
    applyStateStep(h, step("hover"), { x: 1, y: 2 });
    applyStateStep(h, step("press"), null);
    releaseHeldMouse(h);
    sent.length = 0;
    expect(releaseHeldMouse(h)).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("clears the held flag even when the window is already gone", () => {
    // Otherwise the flag survives into the next session and the first
    // releaseHeldMouse there sends a mouseUp nothing pressed.
    const { h } = host();
    applyStateStep(h, step("hover"), { x: 1, y: 2 });
    applyStateStep(h, step("press"), null);
    const { h: dead } = host({ destroyed: true });
    releaseHeldMouse(dead);
    expect(isMouseHeld()).toBe(false);
  });
});

describe("session boundaries", () => {
  it("resetInputState forgets a point measured against the previous page", () => {
    const { h, sent } = host();
    applyStateStep(h, step("hover"), { x: 90, y: 90 });
    resetInputState();
    const res = applyStateStep(h, step("press"), null);
    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(1); // the hover only
  });

  it("refuses everything when the window is closed", () => {
    const { h, sent } = host({ destroyed: true });
    for (const s of ["hover", "press", "release"] as const) {
      expect(applyStateStep(h, step(s), { x: 1, y: 1 }).ok).toBe(false);
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses an unknown state rather than defaulting to one", () => {
    const { h, sent } = host();
    const res = applyStateStep(h, { id: "s", timestamp: 0, type: "state" } as Step, { x: 1, y: 1 });
    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
