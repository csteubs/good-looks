// Tests for the typeface applier.
//
// A `.tsx` DELIBERATELY, and it is not a style choice: `renderer/lib/**/*.test.ts`
// matches vitest's NODE project, which has no `document`, while the dom project
// matches `renderer/**/*.test.tsx`. Named `.ts` this file would run without a
// DOM and fail at the first `document.documentElement` — which reads as a bug
// in the module rather than as a file in the wrong project. (CLAUDE.md.)
//
// WHAT MAKES THIS WORTH TESTING is that every failure here is silent. The
// attribute is read by a CSS selector, and a selector that matches nothing
// styles nothing and reports nothing: the app renders in the default face and
// the setting looks like it does not work.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./api", () => ({
  api: {
    recorder: { getSettings: vi.fn() },
    on: vi.fn(() => () => {}),
  },
}));

import { api } from "./api";
import { applyTypeface, asTypeface, startTypeface } from "./typeface";

const getSettings = api.recorder.getSettings as unknown as ReturnType<typeof vi.fn>;
const on = api.on as unknown as ReturnType<typeof vi.fn>;

/** The push callback `startTypeface` registered, so a broadcast can be
 *  delivered without a backend. */
function pushHandler(): (payload: unknown) => void {
  const call = on.mock.calls[on.mock.calls.length - 1];
  if (!call) throw new Error("nothing subscribed to the appearance push");
  expect(call[0]).toBe("settings:appearanceChanged");
  return call[1] as (payload: unknown) => void;
}

function attr(): string | null {
  return document.documentElement.getAttribute("data-gl-typeface");
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-gl-typeface");
  getSettings.mockReset();
  on.mockReset();
  on.mockReturnValue(() => {});
});

afterEach(() => {
  document.documentElement.removeAttribute("data-gl-typeface");
});

describe("applyTypeface", () => {
  it("writes the chosen face", () => {
    applyTypeface("classic");
    expect(attr()).toBe("classic");
  });

  it("REMOVES the attribute for the default rather than writing it", () => {
    // `:root` already declares the Space pairing, so the untouched app should
    // carry no attribute at all — otherwise there is a boot instant in which
    // the theme is waiting for one, and the default becomes something that has
    // to be written correctly rather than something that cannot be wrong.
    applyTypeface("classic");
    applyTypeface("space");
    expect(attr()).toBeNull();
  });

  it("replaces rather than accumulates", () => {
    applyTypeface("system");
    applyTypeface("classic");
    expect(attr()).toBe("classic");
  });
});

describe("asTypeface", () => {
  it("passes the three it knows", () => {
    for (const t of ["space", "system", "classic"] as const) {
      expect(asTypeface(t), t).toBe(t);
    }
  });

  it("refuses anything else", () => {
    // Second line of defence — the backend validates too. It is not redundant:
    // what arrives here is about to become an attribute value, and a bad one
    // fails by styling nothing.
    for (const bad of ["Space", "comic sans", '" ] {}', "", 1, null, undefined, ["space"], {}]) {
      expect(asTypeface(bad), String(bad)).toBe("space");
    }
  });
});

describe("startTypeface", () => {
  it("applies the stored face on load", async () => {
    getSettings.mockResolvedValue({ uiTypeface: "system" });
    startTypeface();
    await vi.waitFor(() => expect(attr()).toBe("system"));
  });

  it("leaves the app in the default face when the load fails", async () => {
    // A backend that is not answering yet must not leave the app unstyled.
    getSettings.mockRejectedValue(new Error("no backend"));
    startTypeface();
    await Promise.resolve();
    expect(attr()).toBeNull();
  });

  it("follows a change made in another window", async () => {
    getSettings.mockResolvedValue({ uiTypeface: "space" });
    startTypeface();
    pushHandler()({ uiTypeface: "classic" });
    expect(attr()).toBe("classic");
  });

  it("ignores a face the push should never have carried", async () => {
    getSettings.mockResolvedValue({ uiTypeface: "classic" });
    startTypeface();
    await vi.waitFor(() => expect(attr()).toBe("classic"));
    pushHandler()({ uiTypeface: "wingdings" });
    expect(attr()).toBeNull();
  });

  it("survives a push with no payload", () => {
    getSettings.mockResolvedValue({ uiTypeface: "space" });
    startTypeface();
    expect(() => pushHandler()(undefined)).not.toThrow();
  });

  it("stops listening when torn down", () => {
    const off = vi.fn();
    on.mockReturnValue(off);
    getSettings.mockResolvedValue({ uiTypeface: "space" });
    startTypeface()();
    expect(off).toHaveBeenCalled();
  });

  it("does not apply a load that resolves after teardown", async () => {
    // The window is gone; writing to its document element would be writing to
    // a detached one at best.
    let resolve: (v: unknown) => void = () => {};
    getSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    startTypeface()();
    resolve({ uiTypeface: "classic" });
    await Promise.resolve();
    await Promise.resolve();
    expect(attr()).toBeNull();
  });
});
