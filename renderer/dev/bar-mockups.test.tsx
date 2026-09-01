// Smoke coverage for the bar mockup lab (`/?view=bar-lab`).
//
// The lab is preview-only scaffolding, so this pins only what would make a
// review session silently wrong: all three directions mount, the state
// switcher actually changes what a frame shows (the armed transient appears
// WITHOUT any primary control unmounting — the reflow defect the directions
// exist to fix), the suggestion strip is opt-in, and a `?dir=` deep link
// narrows the page to the direction being screenshotted.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { BarLab } from "./bar-mockups";

function section(id: "a" | "b" | "c"): HTMLElement {
  const el = document.querySelector(`[data-direction="${id}"]`);
  if (!el) throw new Error(`direction section ${id} not rendered`);
  return el as HTMLElement;
}

describe("BarLab", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders all three directions, each with a wide and a 360px frame", () => {
    render(<BarLab />);
    expect(screen.getByText(/Direction A — ToolTiles/)).toBeTruthy();
    expect(screen.getByText(/Direction B — two-zone bar/)).toBeTruthy();
    expect(screen.getByText(/Direction C — command-box-first/)).toBeTruthy();
    for (const id of ["a", "b", "c"] as const) {
      const s = within(section(id));
      expect(s.getAllByText("main window")).toHaveLength(1);
      expect(s.getAllByText(/docked panel · 360px/)).toHaveLength(1);
    }
  });

  it("arming an assert shows the transient without unmounting a primary control (direction B)", () => {
    render(<BarLab />);
    const b = within(section("b"));
    // Segmented is plain buttons with aria-pressed, so a bare click drives it.
    const before = b.getAllByRole("button", { name: /assert\b/i }).length;
    fireEvent.click(b.getByRole("button", { name: "Armed assert" }));
    // Two frames, so the armed prompt and the strictness toggle appear twice.
    expect(b.getAllByText(/click an element in the browser/i)).toHaveLength(2);
    expect(b.getAllByRole("button", { name: "Soft" })).toHaveLength(2);
    // The primary row did not lose its assert trigger in either frame.
    expect(b.getAllByRole("button", { name: /assert\b/i }).length).toBeGreaterThanOrEqual(before);
  });

  it("the suggestion strip is opt-in and appears in both frames when enabled", () => {
    render(<BarLab />);
    const a = within(section("a"));
    expect(a.queryByText(/AI · opt-in/)).toBeNull();
    fireEvent.click(a.getByLabelText(/Suggestion strip/i));
    expect(a.getAllByText(/AI · opt-in/)).toHaveLength(2);
  });

  it("the agent state shows the run pane with its stop control and proposal card", () => {
    render(<BarLab />);
    const c = within(section("c"));
    fireEvent.click(c.getByRole("button", { name: "Agent run" }));
    expect(c.getAllByText(/verified, inserted/).length).toBeGreaterThanOrEqual(2);
    expect(c.getAllByRole("button", { name: /stop/i })).toHaveLength(2);
    expect(c.getAllByText(/Proposed assertion/)).toHaveLength(2);
  });

  it("?dir= narrows the page to one direction and ?state= preseeds it", () => {
    window.history.replaceState({}, "", "/?view=bar-lab&dir=b&state=armed");
    render(<BarLab />);
    expect(screen.getByText(/Direction B — two-zone bar/)).toBeTruthy();
    expect(screen.queryByText(/Direction A — ToolTiles/)).toBeNull();
    expect(screen.getAllByText(/click an element in the browser/i)).toHaveLength(2);
  });
});
