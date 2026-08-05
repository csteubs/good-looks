// Tests for when the trainer window is shown, and when opening is a failure.
//
// The bug this exists for: creating a test manually against a fast-loading site
// showed the home screen again, with no trainer window and no test created.
// Nothing errored. The app log said "Trainer window failed to open" 3ms after
// the WebView reported that it had FINISHED LOADING.
//
// The cause was ordering. Four signals could show the window, and
// `did-finish-load` wasn't one of them. On a fast page it resolved the load
// await first, the failure check ran with nothing having shown the window, and
// a perfectly good window was closed. A slow page reached the 1.5s fallback
// first and looked fine — so it reproduced only on fast sites, which is exactly
// the sort of thing that reaches a user rather than a developer.
//
// Order is the whole subject, so every arrival order is exercised rather than
// the one that happened to be observed.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";

import {
  createTrainerWindowGate,
  SHOW_SIGNALS,
  type ShowSignal,
} from "./trainer-window-gate.js";

describe("createTrainerWindowGate", () => {
  it("shows the window on ANY single signal", () => {
    // Each of the four is independently sufficient. `load-finished` is the one
    // that was missing, but pinning them individually stops a future edit
    // dropping a different one and reintroducing the same shape of bug.
    for (const signal of SHOW_SIGNALS) {
      const show = vi.fn();
      const gate = createTrainerWindowGate(show);
      gate.signal(signal);
      expect(show, `${signal} did not show the window`).toHaveBeenCalledTimes(1);
      expect(gate.shown).toBe(true);
      expect(gate.shownBy).toBe(signal);
      expect(gate.failed(false), `${signal} was treated as a failure`).toBe(false);
    }
  });

  it("does not report a failure when only the load finished", () => {
    // THE regression, at its smallest. A fast page produces exactly this: the
    // load completes before the readiness events or the fallback timer.
    const gate = createTrainerWindowGate(vi.fn());
    gate.signal("load-finished");
    expect(gate.failed(false)).toBe(false);
  });

  it("reports a failure when nothing ever signalled", () => {
    // The case the check exists for, and it must still work — a window that
    // genuinely never opened has to be caught, or the user waits forever on a
    // "Recording" banner with no window.
    const gate = createTrainerWindowGate(vi.fn());
    expect(gate.failed(false)).toBe(true);
  });

  it("reports a failure when the window was destroyed, even if it showed", () => {
    const gate = createTrainerWindowGate(vi.fn());
    gate.signal("dom-ready");
    expect(gate.failed(true)).toBe(true);
  });

  it("shows exactly once however many signals arrive", () => {
    // All four routinely fire on one open. Calling show() repeatedly would
    // raise and refocus the window several times.
    const show = vi.fn();
    const gate = createTrainerWindowGate(show);
    for (const signal of SHOW_SIGNALS) gate.signal(signal);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("attributes the show to the FIRST signal, in any order", () => {
    // Diagnostic value: "shown by fallback" means the readiness events never
    // fired, which is worth being able to see in a log.
    const orders: ShowSignal[][] = [
      ["ready-to-show", "dom-ready", "load-finished", "fallback"],
      ["load-finished", "dom-ready", "ready-to-show", "fallback"],
      ["fallback", "load-finished", "dom-ready", "ready-to-show"],
      ["dom-ready", "load-finished", "fallback", "ready-to-show"],
    ];
    for (const order of orders) {
      const gate = createTrainerWindowGate(vi.fn());
      for (const signal of order) gate.signal(signal);
      expect(gate.shownBy, `order ${order.join(",")}`).toBe(order[0]);
      expect(gate.failed(false)).toBe(false);
    }
  });

  it("never shows a window that can no longer be shown", () => {
    // The user closed the trainer before anything signalled. Calling show() on
    // a destroyed window throws, and this runs inside the open path.
    const show = vi.fn();
    const gate = createTrainerWindowGate(show, () => false);
    for (const signal of SHOW_SIGNALS) gate.signal(signal);
    expect(show).not.toHaveBeenCalled();
    // And it stays a failure, because nothing was ever shown.
    expect(gate.failed(false)).toBe(true);
  });

  it("can still be shown by a later signal if an early one arrived too soon", () => {
    // canShow is re-evaluated per signal rather than latched, so a window that
    // wasn't ready at ready-to-show time can still be shown at dom-ready.
    const show = vi.fn();
    let ready = false;
    const gate = createTrainerWindowGate(show, () => ready);
    gate.signal("ready-to-show");
    expect(show).not.toHaveBeenCalled();
    ready = true;
    gate.signal("load-finished");
    expect(show).toHaveBeenCalledTimes(1);
    expect(gate.shownBy).toBe("load-finished");
  });
});

describe("recorder-service wiring", () => {
  // The gate above is only useful if recorder-service actually feeds it all
  // four signals. That wiring is unreachable from a test — start() creates a
  // real BrowserWindow — so it's checked at source level, the same approach
  // check:auto-heal-wiring and check:scroll-layout already use for contracts
  // that no runtime test can see.
  function serviceSource(): string {
    const url = new URL("./recorder-service.ts", import.meta.url);
    return readFileSync(url, "utf-8");
  }

  it("signals the gate from every source that can show the window", () => {
    const src = serviceSource();
    for (const signal of SHOW_SIGNALS) {
      expect(src, `nothing signals "${signal}"`).toContain(`gate.signal("${signal}")`);
    }
  });

  it("decides failure through the gate rather than a local flag", () => {
    // The original bug was a bare `!shown` local. Routing the verdict through
    // the gate is what keeps the decision and the signals in one place.
    const src = serviceSource();
    expect(src).toContain("gate.failed(");
    expect(src, "a local `shown` flag is back").not.toMatch(/let shown = false/);
  });

  it("signals load-finished from the load handler, not just on a timer", () => {
    // Specifically the missing signal. Asserting it appears inside finishLoad
    // rather than anywhere in the file, since anywhere else wouldn't fix it.
    const src = serviceSource();
    const start = src.indexOf("const finishLoad = ");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("};", start));
    expect(body).toContain('gate.signal("load-finished")');
  });
});
