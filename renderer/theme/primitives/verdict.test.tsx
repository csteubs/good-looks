import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { Verdict } from "./verdict";
import { TONE, hexToRgb } from "../tokens";

function rgbOf(hex: string): string {
  const [r, g, b] = hexToRgb(hex) as [number, number, number];
  return `rgb(${r}, ${g}, ${b})`;
}

describe("<Verdict />", () => {
  it("puts the colour on the dot and never on the sentence", () => {
    // Two reasons, and the contrast one is the harder of them: `--gl-red` on
    // `--gl-panel` is fine for a 9px uppercase chip and marginal for a 12.5px
    // sentence. The other is that coloured prose reads as a status rather than
    // as an explanation — the dot says which, the words say why.
    const { container } = render(<Verdict tone="red">The locator matched nothing.</Verdict>);
    const dot = container.querySelector(".gl-verdict-dot") as HTMLElement;
    const text = container.querySelector(".gl-verdict-text") as HTMLElement;
    expect(dot.style.background).toBe(rgbOf(TONE.red));
    expect(text.style.color).toBe("");
  });

  it("hides the dot from assistive technology, since the sentence carries the meaning", () => {
    const { container } = render(<Verdict tone="phos">Everything held.</Verdict>);
    expect((container.querySelector(".gl-verdict-dot") as HTMLElement).getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("renders the detail line only when there is one", () => {
    const { container, rerender } = render(<Verdict tone="amber">Healed.</Verdict>);
    expect(container.querySelector(".gl-verdict-detail")).toBeNull();

    rerender(
      <Verdict tone="amber" detail="Auto-Heal swapped the locator on attempt 2.">
        Healed.
      </Verdict>,
    );
    expect(screen.getByText("Auto-Heal swapped the locator on attempt 2.")).toBeTruthy();
  });

  it("reports its tone as data", () => {
    const { container } = render(<Verdict tone="cyan">Running.</Verdict>);
    expect((container.querySelector('[data-gl="verdict"]') as HTMLElement).dataset.tone).toBe(
      "cyan",
    );
  });
});
