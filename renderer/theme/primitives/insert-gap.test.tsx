import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { InsertGap } from "./insert-gap";

describe("<InsertGap />", () => {
  it("reports where a step inserted here would land", () => {
    const onInsert = vi.fn();
    render(<InsertGap index={3} onInsert={onInsert} label="Insert step after step 3" />);
    fireEvent.click(screen.getByRole("button"));
    expect(onInsert).toHaveBeenCalledWith(3);
  });

  it("names its position", () => {
    // A column of identical unlabelled "insert" buttons is unusable with a
    // screen reader — every one of them announces the same thing.
    render(<InsertGap index={3} label="Insert step after step 3" />);
    expect(screen.getByRole("button", { name: "Insert step after step 3" })).toBeTruthy();
  });

  it("marks the active insert point as data, not as a class the caller invents", () => {
    const { rerender } = render(<InsertGap index={0} label="Insert at the start" />);
    expect(screen.getByRole("button").dataset.active).toBeUndefined();

    rerender(<InsertGap index={0} active label="Insert at the start" />);
    expect(screen.getByRole("button").dataset.active).toBe("true");
  });

  it("keeps a fixed footprint whether or not it is active", () => {
    // If the element grew, hovering between steps 3 and 4 would push every row
    // below down and move the row you were aiming at out from under the cursor.
    // The rule inside changes; the box does not.
    const { rerender } = render(<InsertGap index={1} label="Insert" />);
    const inline = screen.getByRole("button").getAttribute("style");
    rerender(<InsertGap index={1} active label="Insert" />);
    expect(screen.getByRole("button").getAttribute("style")).toBe(inline);
  });

  it("is a real button, so Tab and Enter work with nothing wired up", () => {
    render(<InsertGap index={1} label="Insert" />);
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });

  it("does not throw without a handler", () => {
    // The trainer renders these before it knows whether inserting is allowed.
    render(<InsertGap index={1} label="Insert" />);
    expect(() => fireEvent.click(screen.getByRole("button"))).not.toThrow();
  });

  it("hides the rule from assistive technology", () => {
    const { container } = render(<InsertGap index={1} label="Insert" />);
    expect(
      (container.querySelector(".gl-insert-gap-rule") as HTMLElement).getAttribute("aria-hidden"),
    ).toBe("true");
  });
});
