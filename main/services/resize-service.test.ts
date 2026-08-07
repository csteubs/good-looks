// Tests for applying a `viewport` step during trainer replay.
//
// The failure this guards is silent by construction: before resize-service
// existed the trainer reported a viewport step as `ok: true` and did nothing,
// so the step list said "passed" while every later step ran at the wrong size.
// A test that only checks the return value would still pass against that bug —
// so these assert the WINDOW was resized and that the log says what happened.

import { describe, it, expect, vi } from "vitest";

import type { Step } from "../recorder/types.js";
import {
  applyViewportStep,
  formatResizeLog,
  PAGE_METRICS_SCRIPT,
  type ResizeHost,
} from "./resize-service.js";

function step(partial: Partial<Step>): Step {
  return { id: "s1", timestamp: 0, type: "viewport", ...partial } as Step;
}

/** A stand-in training window that records what it was asked to become. */
function host(overrides: Partial<ResizeHost> = {}): ResizeHost & { calls: [number, number][] } {
  const calls: [number, number][] = [];
  let size: [number, number] = [1200, 820];
  return {
    calls,
    isDestroyed: () => false,
    setContentSize(width: number, height: number) {
      calls.push([width, height]);
      size = [width, height];
    },
    getContentSize: () => size,
    ...overrides,
  };
}

const noPage = async () => ({ innerWidth: 390, innerHeight: 800 });

describe("applyViewportStep", () => {
  it("actually resizes the window to the step's size", async () => {
    const win = host();
    const res = await applyViewportStep(win, step({ width: 390, height: 844 }), noPage);
    expect(res.ok).toBe(true);
    expect(win.calls).toEqual([[390, 844]]);
  });

  it("logs the requested, window and page sizes together", async () => {
    // All three, because they disagree in ways that each mean something: the
    // OS clamps the window, and the scrollbar shrinks the page. A log with only
    // the requested size asserts the one thing that may not have happened.
    const win = host();
    const res = await applyViewportStep(win, step({ width: 390, height: 844 }), noPage);
    const text = res.logs.map((l) => l.m).join("\n");
    expect(text).toContain("390x844");
    expect(text).toContain("window 390x844");
    expect(text).toContain("page 390x800");
  });

  it("reads the page's own dimensions with the shared script", async () => {
    const evaluate = vi.fn(noPage);
    await applyViewportStep(host(), step({ width: 800, height: 600 }), evaluate);
    expect(evaluate).toHaveBeenCalledWith(PAGE_METRICS_SCRIPT);
  });

  it("warns when the display refused the requested size", async () => {
    // A 1440-wide step on a 1280-wide laptop records one size and replays at
    // another. Silence here is what makes that look like a flaky test.
    const win = host({ getContentSize: () => [1280, 800] });
    const res = await applyViewportStep(win, step({ width: 1440, height: 900 }), noPage);
    expect(res.ok).toBe(true);
    expect(res.logs.some((l) => l.level === "warn")).toBe(true);
    expect(res.logs.map((l) => l.m).join("\n")).toContain("window 1280x800");
  });

  it("does not warn when the window reached the requested size", async () => {
    const res = await applyViewportStep(host(), step({ width: 390, height: 844 }), noPage);
    expect(res.logs.some((l) => l.level === "warn")).toBe(false);
  });

  it("still succeeds when the page can't be measured", async () => {
    // The resize already happened. Failing the step because the readback threw
    // would report a resize that worked as one that didn't.
    const win = host();
    const res = await applyViewportStep(win, step({ width: 390, height: 844 }), async () => {
      throw new Error("Execution context was destroyed");
    });
    expect(res.ok).toBe(true);
    expect(win.calls).toEqual([[390, 844]]);
    expect(res.logs.map((l) => l.m).join("\n")).toContain("page unknown");
  });

  it("fails cleanly when the training window is gone", async () => {
    const res = await applyViewportStep(null, step({ width: 390, height: 844 }), noPage);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not open/i);
  });

  it("fails cleanly when the window is destroyed mid-replay", async () => {
    const win = host({ isDestroyed: () => true });
    const res = await applyViewportStep(win, step({ width: 390, height: 844 }), noPage);
    expect(res.ok).toBe(false);
    expect(win.calls).toEqual([]);
  });

  it("refuses a step with no usable size instead of guessing one", async () => {
    const win = host();
    const res = await applyViewportStep(win, step({ width: 390 }), noPage);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/width and height/i);
    expect(win.calls).toEqual([]);
  });

  it("clamps a size the same way the session-open path does", async () => {
    // Both routes go through normalizeViewport, so a step and a preset can
    // never resolve to different window sizes.
    const win = host();
    await applyViewportStep(win, step({ width: 10, height: 99999 }), noPage);
    expect(win.calls).toEqual([[200, 4000]]);
  });

  it("reports a failing setContentSize rather than throwing into the replay loop", async () => {
    const win = host({
      setContentSize: () => {
        throw new Error("window is not resizable");
      },
    });
    const res = await applyViewportStep(win, step({ width: 390, height: 844 }), noPage);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not resizable");
  });
});

describe("formatResizeLog", () => {
  it("says 'page unknown' rather than inventing a measurement", () => {
    expect(formatResizeLog({ width: 390, height: 844 }, [390, 844], null)).toContain("page unknown");
  });
});
