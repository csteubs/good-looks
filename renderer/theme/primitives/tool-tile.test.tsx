// ToolTile — the fold contract and the treatments, at the primitive level.
// The strips' behaviour (membership, gating, what each tile does) is pinned
// in the two view suites; here is only what every consumer inherits.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolTile } from "./tool-tile";

describe("ToolTile", () => {
  it("unfolded shows the name AND the one-line what", () => {
    render(<ToolTile mark={<svg />} name="Assert" what="Pin what must be true" />);
    expect(screen.getByText("Assert")).toBeTruthy();
    expect(screen.getByText("Pin what must be true")).toBeTruthy();
  });

  it("folded hides the what but keeps it reachable as the title", () => {
    // The same sentence, one hover away rather than gone — and the reason
    // TILE_COPY is exported: a string only reachable by hover is one this
    // test file can only assert against the attribute.
    render(<ToolTile folded mark={<svg />} name="Assert" what="Pin what must be true" />);
    expect(screen.queryByText("Pin what must be true")).toBeNull();
    expect(screen.getByRole("button", { name: "Assert" }).getAttribute("title")).toBe(
      "Pin what must be true",
    );
  });

  it("an explicit title wins over the folded what", () => {
    render(<ToolTile folded mark={<svg />} name="Replay" what="short" title="the long sentence" />);
    expect(screen.getByRole("button", { name: "Replay" }).getAttribute("title")).toBe(
      "the long sentence",
    );
  });

  it("draws the caret only when asked — a tile that opens a menu says so", () => {
    const { container, rerender } = render(<ToolTile mark={<svg />} name="Assert" caret />);
    expect(container.querySelector(".gl-tooltile-caret")).not.toBeNull();
    rerender(<ToolTile mark={<svg />} name="Replay" />);
    expect(container.querySelector(".gl-tooltile-caret")).toBeNull();
  });

  it("wears the holo treatment for tone=ai and never a bare colour class", () => {
    const { container } = render(<ToolTile tone="ai" mark={<svg />} name="AI" />);
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("gl-tooltile-ai");
    expect(btn?.getAttribute("data-tone")).toBe("ai");
  });

  it("is a real button with type=button, so a surrounding form cannot submit it", () => {
    render(<ToolTile mark={<svg />} name="Add step" />);
    expect(screen.getByRole("button", { name: "Add step" }).getAttribute("type")).toBe("button");
  });

  it("an aria-label overrides the visible name as the accessible name", () => {
    // The panel's short "Add" keeps the full accessible name this way.
    render(<ToolTile folded mark={<svg />} name="Add" aria-label="Add step" />);
    expect(screen.getByRole("button", { name: "Add step" })).toBeTruthy();
  });
});
