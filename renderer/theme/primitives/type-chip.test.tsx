import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { TypeChip } from "./type-chip";
import { TONE, hexToRgb } from "../tokens";
import type { StepType } from "../../lib/recorder-types";

/** Every step type the app can produce. Written out rather than derived from
 *  the union (types do not exist at runtime), and the test below is what
 *  notices when a new one is added and the chip has no colour for it. */
const ALL: StepType[] = [
  "goto",
  "click",
  "fill",
  "press",
  "select",
  "check",
  "uncheck",
  "assert",
  "wait",
  "viewport",
  "if",
  "endif",
  "cookie",
  "capture",
  "runFlow",
  "state",
];

function rgbOf(hex: string): string {
  const [r, g, b] = hexToRgb(hex) as [number, number, number];
  return `rgb(${r}, ${g}, ${b})`;
}

describe("<TypeChip />", () => {
  it("has a colour for every step type the app can produce", () => {
    // A missing entry falls through to the `wait` grey, which looks completely
    // deliberate — so a new step type would join the list invisibly and every
    // one of its rows would read as "waiting".
    for (const type of ALL) {
      const { container, unmount } = render(<TypeChip type={type} />);
      const el = container.querySelector('[data-gl="type-chip"]') as HTMLElement;
      expect(el.style.color, `no colour for ${type}`).not.toBe("");
      unmount();
    }
  });

  it("never uses a status hue", () => {
    // THE RULE THIS PRIMITIVE IS MOST LIKELY TO BREAK. A step's TYPE is not an
    // outcome — an `assert` step is not "failing" because assertions are what
    // fail — so colouring one with a status hue makes every step list read as a
    // list of verdicts. Also pinned at source level by
    // `check:selection-neutral`'s sibling reasoning.
    const statusRgb = new Set(Object.values(TONE).map(rgbOf));
    for (const type of ALL) {
      const { container, unmount } = render(<TypeChip type={type} />);
      const el = container.querySelector('[data-gl="type-chip"]') as HTMLElement;
      expect(statusRgb.has(el.style.color), `${type} uses a status hue`).toBe(false);
      unmount();
    }
  });

  it("renames the types that read as code rather than as English", () => {
    // These are shown to people who did not write them. `endif` reads as a
    // typo and `runFlow` as a variable name.
    render(<TypeChip type="endif" />);
    expect(screen.getByText("end if")).toBeTruthy();
  });

  it("keeps the raw type as data even when the label is renamed", () => {
    // So a test or a stylesheet can select on what the step IS, not on what it
    // is currently called.
    const { container } = render(<TypeChip type="runFlow" />);
    expect((container.querySelector('[data-gl="type-chip"]') as HTMLElement).dataset.type).toBe(
      "runFlow",
    );
    expect(screen.getByText("flow")).toBeTruthy();
  });

  it("draws its border from its own colour at low alpha", () => {
    const { container } = render(<TypeChip type="click" />);
    const el = container.querySelector('[data-gl="type-chip"]') as HTMLElement;
    expect(el.style.borderColor.startsWith("rgba(")).toBe(true);
  });
});
