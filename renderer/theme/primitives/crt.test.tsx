import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { CRT } from "./crt";

describe("<CRT />", () => {
  it("leaves the content it is given completely untouched", () => {
    // THE RULE THIS PRIMITIVE EXISTS FOR. Everything shown in a CRT is
    // evidence, and the question being asked of it is "does this look right?".
    // An amber cast from our own chrome is indistinguishable from an amber cast
    // in the page under test — the user would file the bug against their own
    // site. Also pinned at source level by `check:crt-untreated`, because the
    // dom suite runs with `css: false` and cannot see a stylesheet regression.
    const { container } = render(<CRT src="/frame.png" alt="Checkout at 1280×800" />);
    const screenEl = container.querySelector("[data-gl-crt-screen]") as HTMLElement;
    const img = container.querySelector(".gl-crt-img") as HTMLElement;

    for (const el of [screenEl, img]) {
      expect(el.style.filter).toBe("");
      expect(el.style.mixBlendMode).toBe("");
      expect(el.style.opacity).toBe("");
      expect(el.style.backgroundImage).toBe("");
    }
  });

  it("puts nothing over the screen", () => {
    // A sibling overlay inside the screen would tint the frame just as
    // effectively as a filter on it, and would look like a feature.
    const { container } = render(<CRT src="/frame.png" alt="Frame" />);
    const screenEl = container.querySelector("[data-gl-crt-screen]") as HTMLElement;
    expect(screenEl.querySelectorAll(".gl-atmo-layer")).toHaveLength(0);
    expect(screenEl.children).toHaveLength(1);
  });

  it("describes the frame for anyone who cannot see it", () => {
    render(<CRT src="/frame.png" alt="Checkout at 1280×800" />);
    expect(screen.getByAltText("Checkout at 1280×800")).toBeTruthy();
  });

  it("renders an arbitrary frame — a diff layer, a canvas, a mask stack", () => {
    render(
      <CRT>
        <canvas data-testid="diff" />
      </CRT>,
    );
    expect(screen.getByTestId("diff")).toBeTruthy();
  });

  it("renders a caption only when there is one, and as a real figcaption", () => {
    const { container, rerender } = render(<CRT src="/f.png" alt="f" />);
    expect(container.querySelector("figcaption")).toBeNull();

    rerender(<CRT src="/f.png" alt="f" caption="Baseline · chromium · 1280×800" />);
    expect(screen.getByText("Baseline · chromium · 1280×800").tagName).toBe("FIGCAPTION");
  });

  it("is a figure, so the frame and its caption are announced together", () => {
    const { container } = render(<CRT src="/f.png" alt="f" caption="Baseline" />);
    expect((container.firstElementChild as HTMLElement).tagName).toBe("FIGURE");
  });
});
