import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { MenuItem } from "./menu-item";
import { TONE, hexToRgb } from "../tokens";

/** Does this style text mention that hue, in EITHER notation?
 *
 *  jsdom normalises `color` and `background` to `rgb()`/`rgba()` but leaves
 *  `box-shadow` exactly as written, so a check for one form alone is either a
 *  false failure or — far worse — a negative assertion that can never fire. The
 *  "selection is never a status hue" test below is exactly that shape, and it
 *  passed vacuously until this helper existed. */
function mentions(styleText: string, hex: string): boolean {
  const [r, g, b] = hexToRgb(hex) as [number, number, number];
  return (
    styleText.toLowerCase().includes(hex.toLowerCase()) || styleText.includes(`rgb(${r}, ${g}, ${b})`)
  );
}

describe("<MenuItem />", () => {
  it("shows the consequence unconditionally, with no hover and no disclosure", () => {
    // THE WHOLE POINT OF THIS PRIMITIVE. The honest description of concurrency
    // 8 is that a laptop will thrash and report failures it caused — a failure
    // mode indistinguishable from a flaky suite, costing an afternoon. The
    // number cannot say that; a second line can, and only if it is on screen at
    // the moment of choosing.
    //
    // It is also the only way this copy is testable: Radix tooltips cannot be
    // opened under jsdom at all, so hover-only text would be unassertable as
    // well as unread.
    render(
      <MenuItem
        label="8"
        consequence="A laptop will thrash and report failures it caused."
      />,
    );
    expect(screen.getByText("A laptop will thrash and report failures it caused.")).toBeTruthy();
  });

  it("renders without a consequence when there genuinely is none", () => {
    const { container } = render(<MenuItem label="Rename" />);
    expect(container.querySelector(".gl-menu-item-consequence")).toBeNull();
  });

  it("gives danger the same red inset rail a failing row uses", () => {
    // Same vocabulary everywhere: "this can bite you" should not be reinvented
    // per surface.
    render(<MenuItem label="Delete test" danger />);
    const el = screen.getByRole("menuitem");
    expect(el.style.boxShadow).toContain("inset 2px 0 0");
    expect(mentions(el.style.boxShadow, TONE.red)).toBe(true);
    expect(el.dataset.danger).toBe("true");
  });

  it("marks the choice in force with aria-current, not aria-selected", () => {
    // This is "the one currently in effect", not a selection within a listbox,
    // and assistive technology says the two differently.
    render(<MenuItem label="4" selected />);
    const el = screen.getByRole("menuitem");
    expect(el.getAttribute("aria-current")).toBe("true");
    expect(el.getAttribute("aria-selected")).toBeNull();
  });

  it("fires on click and not when disabled", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<MenuItem label="4" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("menuitem"));
    expect(onSelect).toHaveBeenCalledTimes(1);

    rerender(<MenuItem label="4" onSelect={onSelect} disabled />);
    fireEvent.click(screen.getByRole("menuitem"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("is a real button, so keyboard activation works without being wired up", () => {
    render(<MenuItem label="4" />);
    expect(screen.getByRole("menuitem").tagName).toBe("BUTTON");
    expect(screen.getByRole("menuitem").getAttribute("type")).toBe("button");
  });

  it("uses no status hue for the selected state", () => {
    // Selection is neutral. On a menu sitting over a failing run, a green
    // "current" row would be a second thing claiming an outcome.
    render(<MenuItem label="4" selected />);
    const el = screen.getByRole("menuitem");
    for (const tone of Object.values(TONE)) {
      expect(mentions(el.style.boxShadow, tone), `selection used ${tone}`).toBe(false);
    }
  });
});
