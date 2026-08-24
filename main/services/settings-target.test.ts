// The Settings deep link's validator.
//
// `settingsTarget` takes a string written into the application MENU and turns
// it into a value the renderer interpolates into a route param. Everything
// about it is a judgement about input the far end must not have to trust, and
// none of that judgement is visible from the screen — a validator that is too
// loose and one that is correct look identical until something builds a path
// with `../` in it.
//
// The renderer's own `paneById(...) ?? board` fallback is the second line of
// defence, not the first, so the interesting cases here are the ones a
// renderer-side fallback would happily absorb.
//
// Carried over from `paneFragment` when Settings stopped being a BrowserWindow
// (docs/plans/settings-view.md). Same inputs, same judgements; the answer is a
// target rather than a URL fragment, so `""` became `null` and `"#cost"` became
// `{ pane: "cost" }`.

import { describe, it, expect } from "vitest";

import { settingsTarget } from "./settings-target";

describe("settingsTarget", () => {
  it("passes a plain pane id through", () => {
    expect(settingsTarget("cost")).toEqual({ pane: "cost" });
    expect(settingsTarget("test-defaults")).toEqual({ pane: "test-defaults" });
  });

  it("carries a topic for the Documentation pane", () => {
    expect(settingsTarget("documentation/setup")).toEqual({
      pane: "documentation",
      topic: "setup",
    });
  });

  it("drops a malformed topic but keeps the pane", () => {
    // The direction that matters. Dropping the whole target would send someone
    // who clicked "Set up the MCP server" to the board, which reads as a broken
    // menu rather than as a rejected argument.
    expect(settingsTarget("documentation/Setup")).toEqual({ pane: "documentation" });
    expect(settingsTarget("documentation/what now")).toEqual({ pane: "documentation" });
  });

  it("refuses anything that is not a pane id", () => {
    for (const bad of [
      "",
      "-leading-dash",
      "UPPER",
      "has space",
      "../../etc/passwd",
      "documentation/../../etc/passwd",
      "a/b/c",
      "pane#fragment",
      "pane?query",
      "x".repeat(80),
      42,
      null,
      undefined,
      { toString: () => "cost" },
    ]) {
      expect(settingsTarget(bad)).toBeNull();
    }
  });

  it("never emits a segment containing a traversal or a separator", () => {
    // The property, stated independently of the cases above: whatever comes
    // back is safe to put in a path.
    for (const input of [
      "documentation/setup",
      "documentation/..",
      "cost",
      "..%2f..%2fetc",
      "documentation/%2e%2e",
    ]) {
      const out = settingsTarget(input);
      if (out === null) continue;
      for (const segment of [out.pane, out.topic ?? "a"]) {
        expect(segment.indexOf("..")).toBe(-1);
        expect(/^[a-z][a-z0-9-]*$/.test(segment)).toBe(true);
      }
    }
  });
});
