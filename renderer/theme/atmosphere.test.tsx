// The atmosphere layer: the motion floor, the roots, and the three layers.
//
// The floor is the part worth the most care. `prefers-reduced-motion: reduce`
// has to CLAMP the app to `calm` and never to anything louder — and the
// asymmetry (a user who chose `still` keeps it) is the kind of rule that reads
// as a bug to whoever simplifies it later, so it is pinned explicitly in both
// directions rather than assumed from the implementation.

import { render, screen } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";

import { Atmosphere, resolveAtmo, ATMO_DEFAULT, GLITCH_DEFAULT } from "./atmosphere";
import type { AtmoLevel } from "./atmosphere";

/** Drive the OS preference. jsdom answers every media query with `false`, so a
 *  test that did not do this would only ever exercise the un-clamped path —
 *  and would pass just as happily with the floor deleted. */
function setReducedMotion(reduce: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  setReducedMotion(false);
  delete document.documentElement.dataset.atmo;
  delete document.documentElement.dataset.glitch;
});

describe("resolveAtmo", () => {
  it("passes every level through when the OS has asked for nothing", () => {
    for (const level of ["alive", "calm", "still"] as AtmoLevel[]) {
      expect(resolveAtmo(level, false)).toBe(level);
    }
  });

  it("clamps alive to calm when reduced motion is requested", () => {
    expect(resolveAtmo("alive", true)).toBe("calm");
  });

  it("leaves still alone under reduced motion — the floor only makes it quieter", () => {
    // The asymmetry, stated. Clamping `still` UP to `calm` would be a
    // one-character change that restores motion to the person who asked for
    // least, and every other assertion here would still pass.
    expect(resolveAtmo("still", true)).toBe("still");
  });

  it("leaves calm alone, which is already the floor", () => {
    expect(resolveAtmo("calm", true)).toBe("calm");
  });
});

describe("the shipped defaults", () => {
  // REDESIGN §0 pins these. They are read by the Appearance pane (A4) and by
  // the shell, so a change here is a product decision, not a tidy-up.
  it("are calm motion and echo glitch", () => {
    expect(ATMO_DEFAULT).toBe("calm");
    expect(GLITCH_DEFAULT).toBe("echo");
  });
});

describe("<Atmosphere />", () => {
  it("puts the effective level and the glitch mode on the document root", () => {
    render(<Atmosphere level="alive" />);
    expect(document.documentElement.dataset.atmo).toBe("alive");
    expect(document.documentElement.dataset.glitch).toBe("echo");
  });

  it("publishes the CLAMPED level, not the requested one", () => {
    // The whole point of resolving before writing: atmosphere.css and the
    // settings pane both read this attribute, and an attribute that said
    // `alive` while the app was visibly calm would make the setting a lie.
    setReducedMotion(true);
    render(<Atmosphere level="alive" />);
    expect(document.documentElement.dataset.atmo).toBe("calm");
  });

  it("clears the roots on unmount", () => {
    const view = render(<Atmosphere level="still" />);
    expect(document.documentElement.dataset.atmo).toBe("still");
    view.unmount();
    expect(document.documentElement.dataset.atmo).toBeUndefined();
    expect(document.documentElement.dataset.glitch).toBeUndefined();
  });

  it("draws grain and vignette, which are fixed treatments rather than settings", () => {
    render(<Atmosphere />);
    expect(document.querySelector('[data-gl-atmo="grain"]')).not.toBeNull();
    expect(document.querySelector('[data-gl-atmo="vignette"]')).not.toBeNull();
  });

  it("draws no scanlines by default", () => {
    // The CRT overlay is the one layer that costs legibility, so REDESIGN §0
    // ships it off. A default flip here changes what every screenshot in the
    // app looks like.
    render(<Atmosphere />);
    expect(document.querySelector('[data-gl-atmo="scanlines"]')).toBeNull();
  });

  it("draws scanlines when the CRT setting is on", () => {
    render(<Atmosphere crt />);
    expect(document.querySelector('[data-gl-atmo="scanlines"]')).not.toBeNull();
  });

  it("portals the layers to the body rather than nesting them in the caller", () => {
    // Every layer is `position: fixed`, and a fixed element inside an ancestor
    // carrying transform/filter positions against THAT ancestor instead of the
    // viewport. This design is built on both properties, so the layers have to
    // escape whatever they were mounted inside.
    const { container } = render(<Atmosphere crt />);
    expect(container.querySelector("[data-gl-atmo]")).toBeNull();
    expect(document.body.querySelector("[data-gl-atmo]")).not.toBeNull();
  });

  it("hides every layer from assistive technology", () => {
    // Three empty divs covering the viewport, announced. `aria-hidden` is what
    // keeps a screen reader out of decoration it can do nothing with.
    render(<Atmosphere crt />);
    const layers = document.querySelectorAll("[data-gl-atmo]");
    expect(layers).toHaveLength(3);
    for (const layer of layers) {
      expect(layer.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("renders nothing the user can reach", () => {
    // A guard against the layers ever gaining content: they are chrome, and
    // anything findable by role inside them would be unreachable anyway,
    // sitting under `pointer-events: none`.
    render(<Atmosphere crt />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
