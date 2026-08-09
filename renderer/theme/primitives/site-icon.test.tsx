import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { SiteIcon, monogramLetters, monogramHue } from "./site-icon";
import { TONE, hexToRgb } from "../tokens";

function icon(): HTMLElement {
  return document.querySelector('[data-gl="site-icon"]') as HTMLElement;
}

describe("SiteIcon — the egress decision", () => {
  it("does not touch the network by default", () => {
    // THE IMPORTANT ONE. The mockup calls a third-party icon service for every
    // non-reserved host in the library, on every render of the sidebar — which
    // sends the hostname of every site under test to someone else. A QA tool's
    // test list routinely names unreleased staging hosts and internal domains,
    // and this app's stated egress posture is one opt-in summary-only webhook.
    render(<SiteIcon host="staging.unreleased-product.example.com" />);
    expect(icon().dataset.kind).toBe("monogram");
    expect(icon().tagName).toBe("SPAN");
  });

  it("fetches a favicon only when explicitly asked", () => {
    render(<SiteIcon host="shop.example.com" favicon />);
    expect(icon().dataset.kind).toBe("favicon");
    expect(icon().getAttribute("src")).toContain("shop.example.com");
  });

  it("keeps reserved names off the network even when favicons are on", () => {
    // There is no third party that knows what `localhost` looks like, and
    // asking would leak that something is being tested locally for no return.
    for (const host of ["localhost", "127.0.0.1", "10.0.0.4", "dev.local", "::1", ""]) {
      const { unmount } = render(<SiteIcon host={host} favicon />);
      expect(icon().dataset.kind, `${host} went to the network`).toBe("monogram");
      unmount();
    }
  });

  it("percent-encodes the host it does send", () => {
    render(<SiteIcon host="a b/../evil" favicon />);
    expect(icon().getAttribute("src")).not.toContain("/../");
  });
});

describe("SiteIcon — never nothing", () => {
  it("prefers a user-supplied image over everything", () => {
    render(<SiteIcon host="shop.example.com" src="/custom.png" favicon />);
    expect(icon().dataset.kind).toBe("custom");
  });

  it("falls back to the monogram when a remote icon fails", () => {
    // A 404 or a blocked request must not leave a hole in the sidebar. This is
    // the whole "never falls through to nothing" contract.
    render(<SiteIcon host="shop.example.com" favicon />);
    expect(icon().dataset.kind).toBe("favicon");
    fireEvent.error(icon());
    expect(icon().dataset.kind).toBe("monogram");
  });

  it("falls back when a custom image fails too", () => {
    render(<SiteIcon host="shop.example.com" src="/gone.png" />);
    fireEvent.error(icon());
    expect(icon().dataset.kind).toBe("monogram");
  });

  it("does not inherit the previous host's failure", () => {
    // Sidebar rows recycle. Without the reset, one broken icon would make every
    // row scrolled into its place render as a monogram.
    const { rerender } = render(<SiteIcon host="a.example.com" favicon />);
    fireEvent.error(icon());
    expect(icon().dataset.kind).toBe("monogram");

    rerender(<SiteIcon host="b.example.com" favicon />);
    expect(icon().dataset.kind).toBe("favicon");
  });
});

describe("the monogram", () => {
  it("takes its letters from the part that distinguishes the row", () => {
    // Half the hosts in a real library share a domain. `shop.example.com` and
    // `docs.example.com` both reading "EX" would make the tiles useless.
    expect(monogramLetters("shop.example.com")).toBe("SH");
    expect(monogramLetters("docs.example.com")).toBe("DO");
    expect(monogramLetters("www.example.com")).toBe("EX");
  });

  it("still produces something for a name it cannot parse", () => {
    expect(monogramLetters("")).toBe("?");
    expect(monogramLetters("...")).toBe(".");
    expect(monogramLetters("127.0.0.1")).toBe("12");
  });

  it("is stable across renders, so the sidebar is learnable", () => {
    // A colour that reshuffled on every launch would train nobody.
    expect(monogramHue("shop.example.com")).toBe(monogramHue("shop.example.com"));
    expect(monogramHue("shop.example.com")).not.toBe(monogramHue("docs.example.com"));
  });

  it("never uses a status hue", () => {
    // Colour means outcome. A site tile in phosphor beside a failing row would
    // be the only green thing on screen and would read as a pass.
    const status = new Set(Object.values(TONE).map((t) => JSON.stringify(hexToRgb(t))));
    for (const host of ["a", "b", "c", "d", "e", "f", "g", "shop.example.com", "docs.x.io"]) {
      expect(status.has(JSON.stringify(hexToRgb(monogramHue(host))))).toBe(false);
    }
  });

  it("is decorative, because the row already names the host in text", () => {
    render(<SiteIcon host="shop.example.com" />);
    expect(icon().getAttribute("aria-hidden")).toBe("true");
  });

  it("scales its letters with the tile", () => {
    render(<SiteIcon host="shop.example.com" size={32} />);
    expect(icon().style.width).toBe("32px");
    expect(icon().style.fontSize).toBe("14px");
  });
});
