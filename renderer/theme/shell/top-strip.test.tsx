import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ChromeButton, TopStrip, WORDMARK } from "./top-strip";

describe("<TopStrip />", () => {
  it("always names the app", () => {
    render(<TopStrip />);
    expect(screen.getByText(WORDMARK)).toBeTruthy();
  });

  it("renders the trail in order, separated", () => {
    render(<TopStrip crumbs={[{ label: "Home" }, { label: "Stats" }]} />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    // Normalised: the separators are their own elements, so the raw
    // textContent is "Home/Stats" with no spaces of its own.
    expect(nav.textContent?.replace(/\s+/g, "")).toBe("Home/Stats");
  });

  it("makes an intermediate segment a button and navigates from it", () => {
    const go = vi.fn();
    render(<TopStrip crumbs={[{ label: "Home", onClick: go }, { label: "Stats" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("never makes the LAST segment a button, even when handed one", () => {
    // A link to the page you are already on is a control that does nothing —
    // the same rule the empty ⌘K slot is there for, one size down. The prop
    // being ignored rather than rejected matters: the caller derives the trail
    // in a loop and should not have to special-case its own tail.
    const go = vi.fn();
    render(<TopStrip crumbs={[{ label: "Home", onClick: go }]} />);
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    expect(screen.getByText("Home")).toBeTruthy();
  });

  it("marks only the last segment as the current page", () => {
    render(<TopStrip crumbs={[{ label: "Home", onClick: vi.fn() }, { label: "Stats" }]} />);
    expect(screen.getByText("Stats").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Home").getAttribute("aria-current")).toBeNull();
  });

  it("hides the separators from assistive tech", () => {
    // A screen reader reading "Home slash Stats" is reading punctuation. The
    // trail's structure is carried by the nav landmark and aria-current.
    render(<TopStrip crumbs={[{ label: "Home" }, { label: "Stats" }]} />);
    for (const sep of screen.getAllByText("/")) {
      expect(sep.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("renders no breadcrumb nav at all when there is nothing to say", () => {
    render(<TopStrip />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("keeps two segments that read the same", () => {
    // A test can be called "Stats". Keyed by label alone, React would drop one
    // of them and the trail would silently lose a step.
    render(<TopStrip crumbs={[{ label: "Stats", onClick: vi.fn() }, { label: "Stats" }]} />);
    expect(screen.getAllByText("Stats")).toHaveLength(2);
  });

  it("fills the command and ticker slots only when given something", () => {
    // THE SLOTS ARE EMPTY UNTIL §6.7 AND §6.8, and that is the decision this
    // pins. A ⌘K hint that opens no palette teaches a shortcut that answers
    // with silence; a disabled one ships a permanently greyed control for a
    // feature nobody asked for. Both are worse than nothing, so "nothing" has
    // to be the rendered result — not a placeholder that later gets forgotten.
    const { container, rerender } = render(<TopStrip />);
    const tail = container.querySelector(".gl-strip-tail") as HTMLElement;
    expect(tail.childElementCount).toBe(0);

    rerender(<TopStrip command={<span>⌘K</span>} ticker={<span>1 running</span>} />);
    expect(screen.getByText("⌘K")).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
  });

  it("puts the leading slot before the wordmark", () => {
    // The rail handle lives here, and it has to be the leftmost thing in the
    // window — it is the affordance for a rail that may not be on screen.
    const { container } = render(<TopStrip leading={<button type="button">handle</button>} />);
    const strip = container.querySelector(".gl-strip") as HTMLElement;
    expect(strip.firstElementChild?.className).toContain("gl-strip-lead");
  });
});

describe("<ChromeButton />", () => {
  it("carries its label as the accessible name and shows it as a hint on focus, never as a native title", async () => {
    // Two readers, one string: `aria-label` for assistive tech, a `Hint` for
    // the eye. The `title` this used to carry as well is pinned ABSENT — on
    // macOS under the pinned Electron it showed once and then rarely
    // (primitives/hint.tsx), and an icon-only control with no working hint is
    // an unlabelled button to a mouse.
    render(<ChromeButton label="Settings">x</ChromeButton>);
    const btn = screen.getByRole("button", { name: "Settings" });
    expect(btn.getAttribute("title")).toBeNull();
    expect(btn.getAttribute("data-state")).toBe("closed");
    fireEvent.focus(btn);
    expect((await screen.findAllByText("Settings")).some((el) => el.closest(".gl-hint"))).toBe(true);
    expect(screen.getByRole("button", { name: "Settings" })).toBe(btn);
  });

  it("is a plain button, so a plain click activates it", () => {
    const onClick = vi.fn();
    render(<ChromeButton label="Add test" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("defaults to type=button", () => {
    // Inside a form, a bare <button> submits it. The rail header's + is exactly
    // the shape that would land in one.
    render(<ChromeButton label="Add test" />);
    expect(screen.getByRole("button", { name: "Add test" }).getAttribute("type")).toBe("button");
  });
});
