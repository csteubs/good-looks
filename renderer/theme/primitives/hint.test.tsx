// Hint — the theme's tooltip. What jsdom can prove here is exactly the half
// that matters: that the child stays itself, that it carries NO native title
// (the thing that stopped being a tooltip on macOS), and that FOCUS opens the
// words — the keyboard path, and the only opener jsdom can drive. A pointer
// cannot open a Radix tooltip under jsdom; the browser preview is where hover
// is looked at.

import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Hint } from "./hint";

describe("<Hint />", () => {
  it("renders its child as itself, wired as the trigger, with no native title", () => {
    render(
      <Hint text="Only the pixels that changed">
        <button type="button" className="gl-segmented-item">
          Diff
        </button>
      </Hint>,
    );
    const btn = screen.getByRole("button", { name: "Diff" });
    expect(btn.className).toBe("gl-segmented-item");
    expect(btn.getAttribute("data-state")).toBe("closed");
    expect(btn.getAttribute("title")).toBeNull();
    // Closed means closed: the words are not in the document until opened.
    expect(screen.queryByText("Only the pixels that changed")).toBeNull();
  });

  it("opens on focus and closes on blur, without renaming the trigger", async () => {
    render(
      <Hint text="Only the pixels that changed">
        <button type="button">Diff</button>
      </Hint>,
    );
    const btn = screen.getByRole("button", { name: "Diff" });
    fireEvent.focus(btn);
    const tip = (await screen.findAllByText("Only the pixels that changed"))[0];
    expect(tip.closest(".gl-hint")).not.toBeNull();
    // The hint DESCRIBES the control; its accessible name is still its label.
    expect(screen.getByRole("button", { name: "Diff" })).toBe(btn);
    fireEvent.blur(btn);
    await waitFor(() => expect(screen.queryByText("Only the pixels that changed")).toBeNull());
  });

  it("passes the child through untouched when there is no text", () => {
    const { container } = render(
      <Hint>
        <button type="button">Bare</button>
      </Hint>,
    );
    expect(container.innerHTML).toBe('<button type="button">Bare</button>');
    const { container: empty } = render(
      <Hint text="">
        <span>Bare too</span>
      </Hint>,
    );
    expect(empty.innerHTML).toBe("<span>Bare too</span>");
  });

  it("keeps the child's own handlers and ref", () => {
    // `asChild` merges the tooltip's handlers onto the child rather than
    // wrapping it, so a click still reaches the child and a ref still lands on
    // the DOM node — which `RailFlyout` relies on to return focus to a row.
    const onClick = vi.fn();
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <Hint text="t">
        <button type="button" ref={ref} onClick={onClick}>
          Go
        </button>
      </Hint>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ref.current?.tagName).toBe("BUTTON");
  });
});
