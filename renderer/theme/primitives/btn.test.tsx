import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Btn } from "./btn";
import { TONE, hexToRgb } from "../tokens";

/** What jsdom reports back for a colour. It normalises `#rrggbb` and the
 *  8-digit `#rrggbbaa` form to `rgb()`/`rgba()`, so a test asserting the hex it
 *  passed in would fail against a perfectly correct element. Derived from TONE
 *  rather than written out, so retuning a hue does not require editing tests. */
function rgbOf(hex: string): string {
  const [r, g, b] = hexToRgb(hex) as [number, number, number];
  return `rgb(${r}, ${g}, ${b})`;
}

describe("<Btn />", () => {
  it("defaults to ghost, because a screen where every button is lit spends the palette on chrome", () => {
    render(<Btn>Run</Btn>);
    expect(screen.getByRole("button").dataset.tone).toBe("ghost");
  });

  it('defaults type to "button"', () => {
    // The HTML default is `submit`. One of these inside a form would navigate
    // instead of doing its job — and it would work perfectly everywhere else,
    // so it would ship.
    render(<Btn>Run</Btn>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });

  it("lets a caller ask for a submit button anyway", () => {
    render(<Btn type="submit">Save</Btn>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("submit");
  });

  it("tints go from phosphor and stop from red, both derived from TONE", () => {
    const { rerender } = render(<Btn tone="go">Run</Btn>);
    let el = screen.getByRole("button");
    expect(el.style.color).toBe(rgbOf(TONE.phos));
    // Line and fill are the same hue at lower alpha — one hue, two weights.
    expect(el.style.borderColor.startsWith("rgba(")).toBe(true);
    expect(el.style.background.startsWith("rgba(")).toBe(true);

    rerender(<Btn tone="stop">Stop</Btn>);
    el = screen.getByRole("button");
    expect(el.style.color).toBe(rgbOf(TONE.red));
  });

  it("draws the fill fainter than the line", () => {
    // `tone + "55"` over `tone + "12"`. If those two ever swap, the button
    // becomes a solid block with a faint edge and still looks deliberate.
    render(<Btn tone="go">Run</Btn>);
    const el = screen.getByRole("button");
    const alpha = (c: string): number => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(c)?.[1] ?? "1");
    expect(alpha(el.style.background)).toBeLessThan(alpha(el.style.borderColor));
  });

  it("gives ai no inline colour — the holo border is a stylesheet rule, never a text fill", () => {
    // A gradient text fill at 10px with .16em tracking is unreadable, and the
    // design says so at the call site. If this ever gains an inline `color`,
    // that is the change to question.
    render(<Btn tone="ai">Debug</Btn>);
    const el = screen.getByRole("button");
    expect(el.style.color).toBe("");
    expect(el.className).toContain("gl-btn-ai");
  });

  it("passes disabled and onClick through", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Btn onClick={onClick}>Run</Btn>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Btn onClick={onClick} disabled>
        Run
      </Btn>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps a caller's style rather than dropping it for the tint", () => {
    render(
      <Btn tone="go" style={{ width: 120 }}>
        Run
      </Btn>,
    );
    const el = screen.getByRole("button");
    expect(el.style.width).toBe("120px");
    expect(el.style.color).toBe(rgbOf(TONE.phos));
  });
});
