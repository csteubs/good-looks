// The Settings deep link's validator.
//
// `paneFragment` takes a string that CROSSED IPC from a renderer process and
// concatenates it into the URL a window loads. Everything about it is a
// judgement about untrusted input, and none of that judgement is visible from
// the screen — a fragment that validates too loosely and one that validates
// correctly look identical until something builds a URL with `../` in it.
//
// The pane's own `paneById(...) ?? DEFAULT_PANE_ID` fallback is the second line
// of defence, not the first, so the interesting cases here are the ones a
// renderer-side fallback would happily absorb.

import { describe, it, expect } from "vitest";

import { paneFragment } from "./settings-window";

describe("paneFragment", () => {
  it("passes a plain pane id through", () => {
    expect(paneFragment("cost")).toBe("#cost");
    expect(paneFragment("test-defaults")).toBe("#test-defaults");
  });

  it("carries a topic for the Documentation pane", () => {
    expect(paneFragment("documentation/setup")).toBe("#documentation/setup");
  });

  it("drops a malformed topic but keeps the pane", () => {
    // The direction that matters. Dropping the whole fragment would send
    // someone who clicked "Set up the MCP server" to Appearance, which reads as
    // a broken menu rather than as a rejected argument.
    expect(paneFragment("documentation/../../etc/passwd")).toBe("");
    expect(paneFragment("documentation/Setup")).toBe("#documentation");
    expect(paneFragment("documentation/what now")).toBe("#documentation");
  });

  it("refuses anything that is not a pane id", () => {
    for (const bad of [
      "",
      "-leading-dash",
      "UPPER",
      "has space",
      "../../etc/passwd",
      "a/b/c",
      "pane#fragment",
      "pane?query",
      "x".repeat(80),
      42,
      null,
      undefined,
      { toString: () => "cost" },
    ]) {
      expect(paneFragment(bad)).toBe("");
    }
  });

  it("never emits a fragment containing a traversal or a second hash", () => {
    // The property, stated independently of the cases above: whatever comes
    // back is safe to concatenate onto a URL.
    for (const input of [
      "documentation/setup",
      "documentation/..",
      "cost",
      "..%2f..%2fetc",
      "documentation/%2e%2e",
    ]) {
      const out = paneFragment(input);
      expect(out.indexOf("..")).toBe(-1);
      expect(out.split("#").length).toBeLessThanOrEqual(2);
      expect(/^(#[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?)?$/.test(out)).toBe(true);
    }
  });
});
