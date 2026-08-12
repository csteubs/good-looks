import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Rail, RailEmpty, RailGroup, RailRow } from "./rail";

describe("<Rail />", () => {
  it("puts the views nav OUTSIDE the scrolling body", () => {
    // THE WHOLE POINT OF THE SLOT. The nav used to be an `mt-auto` block at the
    // end of the library list, which pins it to the bottom only while the
    // library is short — with more tests than fit, Stats/Visual/Batch/Heals
    // scroll away with them.
    //
    // Asserted structurally rather than visually because it CANNOT be asserted
    // visually here: jsdom has no layout engine, so an overflowing list and a
    // short one produce identical boxes, and a rendered "is it at the bottom?"
    // test would pass in both the fixed and the broken case.
    const { container } = render(
      <Rail nav={<button type="button">Stats</button>}>
        <button type="button">A test</button>
      </Rail>,
    );
    const body = container.querySelector(".gl-rail-body") as HTMLElement;
    const nav = container.querySelector(".gl-rail-nav") as HTMLElement;
    expect(nav).not.toBeNull();
    expect(body.contains(nav)).toBe(false);
    expect(screen.getByText("Stats")).toBeTruthy();
  });

  it("orders body, nav, footer", () => {
    const { container } = render(
      <Rail title="Library" nav={<span>nav</span>} footer={<span>foot</span>}>
        <span>body</span>
      </Rail>,
    );
    const kids = [...(container.querySelector(".gl-rail") as HTMLElement).children].map(
      (el) => el.className,
    );
    expect(kids).toEqual([
      "gl-rail-head drag-region",
      "gl-rail-body",
      "gl-rail-nav",
      "gl-rail-foot",
    ]);
  });

  it("omits the header entirely when there is neither title nor actions", () => {
    const { container } = render(<Rail>x</Rail>);
    expect(container.querySelector(".gl-rail-head")).toBeNull();
  });

  it("keeps a drag region on the header", () => {
    // In-flow chrome, not a positioned overlay — the shape
    // `check:clickable-chrome` bans is a `fixed` full-width one, which ate the
    // + button for months.
    const { container } = render(<Rail title="Library" />);
    expect(container.querySelector(".gl-rail-head")?.className).toContain("drag-region");
  });
});

describe("<RailRow />", () => {
  it("activates on a plain click", () => {
    // THE SDK's `SidebarListItem` FIRES ON mouseDown — the AppKit idiom, and a
    // documented trap here: `fireEvent.click` does nothing to it and the
    // assertion reports "0 calls", which reads as a dead handler. Our own row
    // is an ordinary button. REDESIGN §8.2 predicted this swap.
    const onClick = vi.fn();
    render(<RailRow title="Login" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /Login/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does NOT activate on mouseDown alone", () => {
    // The other half of the same change, and the one that is a real behaviour
    // difference rather than a test edit: a press that lands on a row and is
    // dragged off it no longer navigates.
    const onClick = vi.fn();
    render(<RailRow title="Login" onClick={onClick} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: /Login/ }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("marks selection with a bare data-selected, not a stringified false", () => {
    // `[data-selected]` matches an EMPTY attribute, so `data-selected="false"`
    // would style every unselected row as selected — with the neutral
    // treatment that is a whole rail of lifted rows and no error anywhere.
    render(
      <>
        <RailRow title="Chosen" selected />
        <RailRow title="Other" />
      </>,
    );
    expect(screen.getByRole("button", { name: /Chosen/ }).getAttribute("data-selected")).toBe("");
    expect(screen.getByRole("button", { name: /Other/ }).hasAttribute("data-selected")).toBe(false);
  });

  it("announces the selected row as current", () => {
    render(<RailRow title="Chosen" selected />);
    expect(screen.getByRole("button", { name: /Chosen/ }).getAttribute("aria-current")).toBe("true");
  });

  it("takes its hint as a native title without shadowing the row's own label", () => {
    // `title` is the row's LABEL prop here, so the native attribute needs its
    // own name. Getting this wrong would silently drop the tooltip.
    render(<RailRow title="Ollama" hint="Ollama — connection refused" />);
    const row = screen.getByRole("button", { name: /Ollama/ });
    expect(row.getAttribute("title")).toBe("Ollama — connection refused");
    expect(row.textContent).toContain("Ollama");
  });

  it("renders icon, subtitle and accessory when given them, and nothing when not", () => {
    const { container, rerender } = render(<RailRow title="Bare" />);
    expect(container.querySelector(".gl-rail-row-icon")).toBeNull();
    expect(container.querySelector(".gl-rail-row-sub")).toBeNull();
    expect(container.querySelector(".gl-rail-row-accessory")).toBeNull();

    rerender(
      <RailRow
        title="Full"
        icon={<span>i</span>}
        subtitle="example.test"
        accessory={<span>dot</span>}
      />,
    );
    expect(container.querySelector(".gl-rail-row-icon")).not.toBeNull();
    expect(screen.getByText("example.test")).toBeTruthy();
    expect(screen.getByText("dot")).toBeTruthy();
  });

  it("is type=button", () => {
    render(<RailRow title="Login" />);
    expect(screen.getByRole("button", { name: /Login/ }).getAttribute("type")).toBe("button");
  });
});

describe("<RailGroup /> and <RailEmpty />", () => {
  it("names the group so the rail has an outline rather than one long list", () => {
    render(
      <RailGroup label="Views">
        <RailRow title="Stats" />
      </RailGroup>,
    );
    expect(screen.getByRole("group", { name: "Views" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Views" })).toBeTruthy();
  });

  it("renders empty copy as a paragraph", () => {
    render(<RailEmpty>No tests yet.</RailEmpty>);
    expect(screen.getByText("No tests yet.").tagName).toBe("P");
  });
});
