// Tests for the interface-scale service.
//
// The behaviour under test is small and the failure it prevents is not: this is
// the only thing standing between a stored number and every app window's zoom
// factor. What matters here is not that a number is passed along, it is WHICH
// windows it is passed to, and that a window which reloads does not quietly
// return to 100%.
//
// The training browser is not visible from the service, which is the design:
// `applyUiScaleToAllWindows` names the app's own windows (the main window and
// whatever registered as an aux window) rather than asking Electron for all of
// them, so there is no path by which the recording window could be picked up.
// The last describe below pins that as a structural fact.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { recorderSettingsStore } from "./recorder-settings-store.js";
import { setMainWindow, registerAuxWindow, unregisterAuxWindow } from "./app-window.js";
import { applyUiScaleToAllWindows, attachUiScale, scaled } from "./ui-scale.js";
import type { ZoomableWindow } from "./ui-scale.js";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-ui-scale-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

/** A window that records what it was told, and hands back the `did-finish-load`
 *  listener so a reload can be simulated without a browser. */
function fakeWindow(destroyed = false, size: [number, number] = [10_000, 10_000]) {
  const factors: number[] = [];
  const mins: Array<[number, number]> = [];
  const sizes: Array<[number, number]> = [];
  let current: [number, number] = size;
  let onLoad: (() => void) | null = null;
  const win = {
    isDestroyed: () => destroyed,
    setMinimumSize: (w: number, h: number) => void mins.push([w, h]),
    getSize: () => [current[0], current[1]],
    setSize: (w: number, h: number) => {
      current = [w, h];
      sizes.push([w, h]);
    },
    webContents: {
      setZoomFactor: (f: number) => void factors.push(f),
      on: (_event: "did-finish-load", listener: () => void) => {
        onLoad = listener;
        return undefined;
      },
    },
  };
  return { win: win as ZoomableWindow, factors, mins, sizes, reload: () => onLoad?.() };
}

beforeAll(() => {
  recorderSettingsStore.set({ uiScale: 1 });
});

afterEach(() => {
  setMainWindow(null);
  recorderSettingsStore.set({ uiScale: 1 });
});

describe("attachUiScale", () => {
  it("draws the window at the stored scale straight away", () => {
    recorderSettingsStore.set({ uiScale: 1.25 });
    const { win, factors } = fakeWindow();
    attachUiScale(win);
    expect(factors).toEqual([1.25]);
  });

  it("re-applies after a reload", () => {
    // Chromium resets the zoom factor across a navigation. Without the
    // did-finish-load listener the app snaps back to 100% on the dev server's
    // full reload or after a renderer crash — silently, and only sometimes,
    // which is the hardest kind of this bug to believe a report of.
    recorderSettingsStore.set({ uiScale: 0.9 });
    const { win, factors, reload } = fakeWindow();
    attachUiScale(win);
    reload();
    expect(factors).toEqual([0.9, 0.9]);
  });

  it("picks up a scale changed since the window opened", () => {
    // The listener reads the store when it fires, not when it was registered.
    const { win, factors, reload } = fakeWindow();
    attachUiScale(win);
    recorderSettingsStore.set({ uiScale: 1.1 });
    reload();
    expect(factors).toEqual([1, 1.1]);
  });

  it("leaves a destroyed window alone", () => {
    const { win, factors } = fakeWindow(true);
    attachUiScale(win);
    expect(factors).toEqual([]);
  });

  it("survives a webContents that throws", () => {
    // A window that cannot be zoomed is a window at 100%, which is legible.
    // Throwing would take down whatever was creating it — the main window, at
    // boot — and turn a display preference into a launch failure.
    const win = {
      isDestroyed: () => false,
      setMinimumSize: () => {},
      getSize: () => [1000, 700],
      setSize: () => {},
      webContents: {
        setZoomFactor: () => {
          throw new Error("render frame was disposed");
        },
        on: () => undefined,
      },
    } as ZoomableWindow;
    expect(() => attachUiScale(win)).not.toThrow();
  });
});

describe("the layout floor moves with the scale", () => {
  // THE CORRECTNESS CASE, not a nicety. `main/index.ts` fixes the main window's
  // minimum at 960 against a measured requirement — the widest toolbar needs
  // ~928px of viewport or `Run test` leaves the window with nowhere to scroll
  // it back from. That measurement is in CSS pixels. A floor left in physical
  // points is 768 CSS pixels at 125%: the promise lapses at exactly the setting
  // someone turns up because they are struggling to read the app.

  it("converts a CSS-pixel floor into points at the current scale", () => {
    recorderSettingsStore.set({ uiScale: 1.25 });
    const { win, mins } = fakeWindow();
    attachUiScale(win, { width: 960, height: 456 });
    expect(mins).toEqual([[1200, 570]]);
  });

  it("is the identity at 100%", () => {
    const { win, mins } = fakeWindow();
    attachUiScale(win, { width: 960, height: 456 });
    expect(mins).toEqual([[960, 456]]);
  });

  it("re-applies the floor when the scale changes", () => {
    const { win, mins } = fakeWindow();
    setMainWindow(win as never);
    attachUiScale(win, { width: 620, height: 420 });
    recorderSettingsStore.set({ uiScale: 1.1 });
    applyUiScaleToAllWindows();
    expect(mins).toEqual([
      [620, 420],
      [682, 462],
    ]);
  });

  it("grows a window that the new floor left underneath it", () => {
    // THE BUG THIS EXISTS FOR, found by measuring the running app rather than
    // by any test: `setMinimumSize` constrains dragging and, on macOS, does not
    // resize a window already smaller than the new minimum. So the settings
    // window — open, at 760 points, while the scale went to 125% — stayed at
    // 608 CSS pixels, under the 620 its own layout declares. The e2e case for a
    // NEWLY opened window passed the whole time, which is how this would have
    // shipped.
    const { win, sizes } = fakeWindow(false, [760, 560]);
    setMainWindow(win as never);
    attachUiScale(win, { width: 620, height: 420 });
    recorderSettingsStore.set({ uiScale: 1.25 });
    applyUiScaleToAllWindows();
    expect(sizes).toEqual([[775, 560]]);
  });

  it("does not shrink a window that is already big enough", () => {
    // The height above stayed at 560 for this reason: growing past the floor is
    // the user's business, and a scale change must not undo a window they sized.
    const { win, sizes } = fakeWindow(false, [1600, 1200]);
    setMainWindow(win as never);
    attachUiScale(win, { width: 620, height: 420 });
    recorderSettingsStore.set({ uiScale: 1.25 });
    applyUiScaleToAllWindows();
    expect(sizes).toEqual([]);
  });

  it("leaves a window that declared no floor alone", () => {
    // The trainer panel is this case: its minimum IS its docked width, latched
    // for the session, and re-applying a scaled one mid-session would rewrite
    // the number the dock arithmetic assumes is fixed.
    const { win, mins } = fakeWindow();
    setMainWindow(win as never);
    attachUiScale(win);
    recorderSettingsStore.set({ uiScale: 1.25 });
    applyUiScaleToAllWindows();
    expect(mins).toEqual([]);
  });
});

describe("scaled", () => {
  it("is the identity at 100%", () => {
    expect(scaled(360)).toBe(360);
  });

  it("rounds to whole points — a window cannot be 449.9 wide", () => {
    recorderSettingsStore.set({ uiScale: 1.25 });
    expect(scaled(360)).toBe(450);
    recorderSettingsStore.set({ uiScale: 1.1 });
    expect(scaled(457)).toBe(503);
  });
});

describe("applyUiScaleToAllWindows", () => {
  it("reaches the main window and every aux window", () => {
    recorderSettingsStore.set({ uiScale: 1.1 });
    const main = fakeWindow();
    const panel = fakeWindow();
    setMainWindow(main.win as never);
    registerAuxWindow(panel.win as never);
    try {
      applyUiScaleToAllWindows();
      expect(main.factors).toEqual([1.1]);
      expect(panel.factors).toEqual([1.1]);
    } finally {
      unregisterAuxWindow(panel.win as never);
    }
  });

  it("does nothing when no window is open", () => {
    expect(() => applyUiScaleToAllWindows()).not.toThrow();
  });

  it("applies the stored value, not one it was handed", () => {
    // The handler calls this AFTER the store has validated and merged the
    // patch, so a refused value must not reach a window. Passing the number in
    // as an argument is what would let it.
    recorderSettingsStore.set({ uiScale: 9 as never });
    const main = fakeWindow();
    setMainWindow(main.win as never);
    applyUiScaleToAllWindows();
    expect(main.factors).toEqual([1]);
  });
});

describe("what it does not touch", () => {
  it("cannot enumerate windows, because it never imports the class that can", async () => {
    // The training browser is a BrowserWindow like any other. A helper that
    // scaled "all windows" would resize the page under test — changing what a
    // responsive site renders, what a click lands on, and what a visual
    // baseline captures. The recording window is deliberately unreachable from
    // here, and this is the structural fact that keeps it so: with no
    // `BrowserWindow` in scope there is no `getAllWindows` to call.
    //
    // Asserted on IMPORTS rather than on the string "getAllWindows", which the
    // file's own header comment contains — a source scan that matches prose
    // fails for the wrong reason and gets deleted rather than fixed.
    const src = await fs.promises.readFile(
      path.join(process.cwd(), "main/services/ui-scale.ts"),
      "utf-8",
    );
    const imports = src.split("\n").filter((l) => l.startsWith("import "));
    expect(imports.join("\n")).not.toContain("BrowserWindow");
  });

  // This used to assert that `recorder-service.ts` did not import this module at
  // all, which was a clean way to state "the training browser is never scaled" for
  // as long as that window was a single webContents holding the page.
  //
  // The URL strip ended that: the recorder window now contains an app-owned view
  // as well as the page, and the strip is app chrome that SHOULD scale with the
  // rest of the app — a 36px bar with 11px type does not stay legible at 125% when
  // everything around it grows. So the import is legitimate now, and the assertion
  // moved to the thing that actually matters and was only ever implied before: the
  // PAGE is not scaled. Zooming it would change what a responsive site renders,
  // what a click lands on, and what a visual baseline captures — a reading
  // preference silently rewriting the test.
  it("is applied to the recorder's URL strip but never to the page", async () => {
    const src = await fs.promises.readFile(
      path.join(process.cwd(), "main/services/recorder-service.ts"),
      "utf-8",
    );
    expect(src).toContain("chromeView.webContents.setZoomFactor(uiScale())");
    expect(src).not.toContain("pageView.webContents.setZoomFactor");
    // No blanket application either — `applyUiScaleToAllWindows` walks the app's
    // own windows, and a recorder that called it would be reaching for exactly the
    // "scale everything" helper this module refuses to provide.
    expect(src).not.toContain("applyUiScaleToAllWindows");
  });
});

// Keep the temp dir out of the way of whatever runs next.
afterEach(() => vi.restoreAllMocks());
