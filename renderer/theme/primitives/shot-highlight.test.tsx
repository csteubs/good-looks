// jsdom has no layout engine, so these rows cover what it CAN prove: the
// rect→overlay geometry (pure math), the measured/approximate distinction
// (two different visual claims that must never collapse into one), and the
// degradation ladder's renderer half — no rect draws no box, and the caller
// owns the no-shot rung, so this component never receives one. What the box
// LOOKS like is the specimen page's job (`?view=specimen`).

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ShotHighlight, shotHighlightBox } from "./shot-highlight";

const SHOT = "data:image/png;base64,AAAA";

describe("shotHighlightBox", () => {
  it("turns a normalized rect into image-relative percentages", () => {
    expect(shotHighlightBox({ x: 0.1, y: 0.25, w: 0.5, h: 0.05 })).toEqual({
      left: "10%",
      top: "25%",
      width: "50%",
      height: "5%",
    });
  });

  it("clamps to the image — a rect cannot draw outside the shot it annotates", () => {
    expect(shotHighlightBox({ x: -0.2, y: 1.4, w: 2, h: 0.5 })).toEqual({
      left: "0%",
      top: "100%",
      width: "100%",
      height: "50%",
    });
  });
});

describe("ShotHighlight", () => {
  it("draws a measured box, solid — the strong claim", () => {
    const { container } = render(
      <ShotHighlight shot={SHOT} rect={{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }} label={'getByTestId("submit-v2")'} />,
    );
    const box = container.querySelector(".gl-shothl-box");
    expect(box).not.toBeNull();
    expect(box!.classList.contains("gl-shothl-box-approx")).toBe(false);
    expect((box as HTMLElement).style.left).toBe("10%");
    expect(screen.getByText('getByTestId("submit-v2")')).toBeTruthy();
  });

  it("draws a remembered box dashed and marked — a visibly weaker claim", () => {
    const { container } = render(
      <ShotHighlight shot={SHOT} rect={{ x: 0, y: 0, w: 0.5, h: 0.5 }} approximate />,
    );
    const box = container.querySelector(".gl-shothl-box");
    expect(box!.classList.contains("gl-shothl-box-approx")).toBe(true);
    expect((box as HTMLElement).dataset.approximate).toBe("");
  });

  it("no rect renders the bare shot, never an empty box", () => {
    const { container } = render(<ShotHighlight shot={SHOT} caption="the target's latest run" />);
    expect(container.querySelector(".gl-shothl-box")).toBeNull();
    expect(container.querySelector(".gl-shothl-img")).not.toBeNull();
    expect(screen.getByText("the target's latest run")).toBeTruthy();
  });
});
