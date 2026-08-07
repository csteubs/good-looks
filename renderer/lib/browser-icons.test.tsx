// The browser-glyph maps.
//
// These are the kind of tables that rot quietly: a fourth engine added to
// RUN_BROWSERS type-checks against Record<RunBrowser, …> only while both maps
// are literals in this repo — but a MISSING entry renders `undefined` as a
// component, which React throws on at runtime, in whichever view happened to
// show that engine first. Pinning totality here fails at the map instead.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { BROWSER_ICONS, BROWSER_SF_SYMBOLS, BrowserIcon } from "./browser-icons";
import { RUN_BROWSERS, RUN_BROWSER_LABELS } from "./recorder-types";

describe("browser glyph maps", () => {
  it("covers every engine on both surfaces", () => {
    for (const b of RUN_BROWSERS) {
      expect(BROWSER_ICONS[b], `no DOM icon for ${b}`).toBeTruthy();
      expect(BROWSER_SF_SYMBOLS[b], `no SF Symbol for ${b}`).toBeTruthy();
    }
  });

  it("gives each engine a distinct glyph", () => {
    // A shared glyph defeats the entire point: the user is meant to tell the
    // engines apart at a glance, and two identical icons read as one engine.
    const icons = RUN_BROWSERS.map((b) => BROWSER_ICONS[b]);
    const symbols = RUN_BROWSERS.map((b) => BROWSER_SF_SYMBOLS[b]);
    expect(new Set(icons).size).toBe(RUN_BROWSERS.length);
    expect(new Set(symbols).size).toBe(RUN_BROWSERS.length);
  });
});

describe("BrowserIcon", () => {
  it.each(RUN_BROWSERS)("names %s for assistive tech when it stands alone", (b) => {
    render(<BrowserIcon browser={b} />);
    expect(screen.getByRole("img", { name: RUN_BROWSER_LABELS[b] })).toBeTruthy();
  });

  it("titles itself so a hover decodes the icon-only Stats column", () => {
    const { container } = render(<BrowserIcon browser="webkit" />);
    expect(container.querySelector("title")?.textContent).toBe("WebKit");
  });

  it("goes silent when text alongside it already says the engine", () => {
    // Used in Select triggers, where SelectValue renders the name — a labelled
    // icon there would have a screen reader announce "Firefox Firefox".
    render(<BrowserIcon browser="firefox" labelled={false} />);
    expect(screen.queryByRole("img", { name: "Firefox" })).toBeNull();
  });
});
