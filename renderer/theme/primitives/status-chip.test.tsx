import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { StatusChip } from "./status-chip";
import { TONE, hexToRgb } from "../tokens";

function rgbOf(hex: string): string {
  const [r, g, b] = hexToRgb(hex) as [number, number, number];
  return `rgb(${r}, ${g}, ${b})`;
}

describe("<StatusChip />", () => {
  it("takes its colour from the tone, line over fill", () => {
    render(<StatusChip tone="phos">Passed</StatusChip>);
    const el = screen.getByText("Passed");
    expect(el.style.color).toBe(rgbOf(TONE.phos));
    const alpha = (c: string): number => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(c)?.[1] ?? "1");
    expect(alpha(el.style.background)).toBeLessThan(alpha(el.style.borderColor));
  });

  it("reports its tone as data, so a screen's status vocabulary is assertable", () => {
    render(<StatusChip tone="red">Failed</StatusChip>);
    expect(screen.getByText("Failed").dataset.tone).toBe("red");
  });

  it("renders a neutral chip with no tone colour at all", () => {
    // "Never run" and "Skipped" are real states that are not results. Giving
    // them a hue would be the chip claiming an outcome that did not happen.
    render(<StatusChip>Never</StatusChip>);
    const el = screen.getByText("Never");
    expect(el.style.color).toBe("");
    expect(el.dataset.tone).toBe("neutral");
  });

  it("draws running with the holo treatment and no status hue", () => {
    // Running is the ABSENCE of an outcome, not one of them. A green or amber
    // chip on a row still in flight reads as a row that has finished and
    // reported something.
    render(<StatusChip running>Running</StatusChip>);
    const el = screen.getByText("Running");
    expect(el.className).toContain("gl-status-chip-running");
    expect(el.style.color).toBe("");
    expect(el.dataset.tone).toBe("running");
  });

  it("lets running override a tone rather than combining them", () => {
    // A chip cannot be reporting an outcome and waiting for one at once. If
    // both were applied the holo border would sit over a green fill, which
    // reads as "passed, and also still going".
    render(
      <StatusChip tone="phos" running>
        Running
      </StatusChip>,
    );
    const el = screen.getByText("Running");
    expect(el.style.background).toBe("");
    expect(el.dataset.tone).toBe("running");
  });

  it("only animates when it is actually running", () => {
    const { rerender } = render(
      <StatusChip tone="phos" animated>
        Passed
      </StatusChip>,
    );
    // A finished chip has nothing to drift about; the animation would be motion
    // that reports nothing, which is exactly what `calm` exists to stop.
    expect(screen.getByText("Passed").getAttribute("data-gl-motion")).toBeNull();

    rerender(
      <StatusChip running animated>
        Running
      </StatusChip>,
    );
    expect(screen.getByText("Running").getAttribute("data-gl-motion")).toBe("ambient");
  });

  it("marks the drift as ambient, so `calm` can stop it and status motion survives", () => {
    render(
      <StatusChip running animated>
        Running
      </StatusChip>,
    );
    // Unmarked motion survives `calm` by design. The holo drift is decoration —
    // the WORD is what reports the state — so it has to carry the marker or a
    // reduced-motion user keeps a permanently sliding gradient.
    expect(screen.getByText("Running").getAttribute("data-gl-motion")).toBe("ambient");
  });

  it("is not a live region", () => {
    // These sit in tables of dozens. A live region would read the entire status
    // column aloud every time a filter repainted the list.
    render(<StatusChip tone="red">Failed</StatusChip>);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
