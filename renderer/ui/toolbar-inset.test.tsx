// The Toolbar must reserve space for a pinned sidebar toggle — and only when
// one is actually there.
//
// The bug this pins: `SplitView.SidebarToggle` is absolutely positioned over
// the top-left of the primary pane, and Toolbar used to clear it with a
// `window-controls-inset` class that the SDK defined and the port did not carry
// across. The class resolved to NOTHING, so the button rendered on top of the
// first letter of every view title in the main window — "Stats", "Visual",
// "Batch run", "Heals", and each test's name.
//
// The mirrored bug is just as easy to ship: the settings window runs the same
// SplitView and the same Toolbar with NO pinned toggle, so a blanket inset
// would indent its title by 44px to clear a button that is not there. Both
// directions are asserted below.
//
// Asserted on `data-toggle-inset` rather than computed padding on purpose: the
// dom project runs with `css: false` (vitest.config.ts), so Tailwind utilities
// never produce real values here and a `paddingLeft` assertion would read
// "0px" in both the fixed and the broken case — passing vacuously forever.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SplitView, Toolbar, ToolbarContent, ToolbarTitle } from "./index";

function toolbarEl(): HTMLElement {
  const el = document.querySelector("[data-toolbar]");
  if (!el) throw new Error("no [data-toolbar] rendered");
  return el as HTMLElement;
}

const title = (
  <ToolbarContent>
    <ToolbarTitle>Stats</ToolbarTitle>
  </ToolbarContent>
);

describe("Toolbar inset for the pinned sidebar toggle", () => {
  it("reserves space when a pinned toggle is mounted in the pane", () => {
    render(
      <SplitView sidebar={<div>library</div>} storageKey="test-with-toggle">
        <SplitView.SidebarToggle aria-label="Toggle sidebar" />
        <Toolbar>{title}</Toolbar>
      </SplitView>,
    );

    // The toggle really is rendered — otherwise this test would pass for the
    // wrong reason the day the toggle stops being mounted.
    expect(screen.getByLabelText("Toggle sidebar")).toBeTruthy();
    expect(toolbarEl().hasAttribute("data-toggle-inset")).toBe(true);
    expect(toolbarEl().className).toContain("pl-11");
  });

  it("does NOT reserve space when the pane has no toggle (the settings shape)", () => {
    render(
      <SplitView sidebar={<div>panes</div>} storageKey="test-no-toggle">
        <Toolbar>{title}</Toolbar>
      </SplitView>,
    );

    expect(screen.queryByLabelText("Toggle sidebar")).toBeNull();
    expect(toolbarEl().hasAttribute("data-toggle-inset")).toBe(false);
    expect(toolbarEl().className).not.toContain("pl-11");
  });

  it('honours inset="none" as an opt-out even with a toggle present', () => {
    render(
      <SplitView sidebar={<div>library</div>} storageKey="test-opt-out">
        <SplitView.SidebarToggle aria-label="Toggle sidebar" />
        <Toolbar inset="none">{title}</Toolbar>
      </SplitView>,
    );

    expect(toolbarEl().hasAttribute("data-toggle-inset")).toBe(false);
  });

  it("renders outside a SplitView without throwing, and without the inset", () => {
    // Toolbar is chrome; it must not require a SplitView ancestor. `useSplitView`
    // throws by design, so Toolbar reads the context optionally.
    expect(() => render(<Toolbar>{title}</Toolbar>)).not.toThrow();
    expect(toolbarEl().hasAttribute("data-toggle-inset")).toBe(false);
  });

  it('does not reserve space for a toggle that is not floating over the pane (pinned={false})', () => {
    // `pinned` was accepted and IGNORED until the redesign's shell had
    // somewhere better to put this button (the top strip's leading slot, in
    // flow). The registration has to follow the position: a toggle that is not
    // overlapping the pane needs no space reserved, and an unconditional
    // register would leave every title in the app indented for a button that
    // moved.
    render(
      <SplitView sidebar={<div>library</div>} storageKey="test-unpinned">
        <SplitView.SidebarToggle aria-label="Toggle sidebar" pinned={false} />
        <Toolbar>{title}</Toolbar>
      </SplitView>,
    );

    expect(screen.getByLabelText("Toggle sidebar")).toBeTruthy();
    expect(toolbarEl().hasAttribute("data-toggle-inset")).toBe(false);
    expect(screen.getByLabelText("Toggle sidebar").className).not.toContain("absolute");
  });

  it("drops the inset again when the toggle unmounts", () => {
    // Guards the registration counter: a toggle that goes away must give the
    // space back, or a view that hides its toggle keeps a 44px hole.
    const { rerender } = render(
      <SplitView sidebar={<div>library</div>} storageKey="test-unmount">
        <SplitView.SidebarToggle aria-label="Toggle sidebar" />
        <Toolbar>{title}</Toolbar>
      </SplitView>,
    );
    expect(toolbarEl().hasAttribute("data-toggle-inset")).toBe(true);

    rerender(
      <SplitView sidebar={<div>library</div>} storageKey="test-unmount">
        <Toolbar>{title}</Toolbar>
      </SplitView>,
    );
    expect(toolbarEl().hasAttribute("data-toggle-inset")).toBe(false);
  });
});

describe("SplitView header slot", () => {
  it("spans the panes rather than sitting inside one", () => {
    // The redesign's top strip runs across the whole window — wordmark over
    // the rail, breadcrumb over the content — so it cannot be a child of the
    // primary pane. Rendering it as a SIBLING above the SplitView would put it
    // outside the context, where its rail handle (`useSplitView`) throws.
    const { container } = render(
      <SplitView header={<div data-testid="strip">strip</div>} sidebar={<div>library</div>}>
        <div>content</div>
      </SplitView>,
    );
    const root = container.firstElementChild as HTMLElement;
    const strip = screen.getByTestId("strip");
    // Direct child of the root, and first: the panes are in their own row below.
    expect(strip.parentElement).toBe(root);
    expect(root.firstElementChild).toBe(strip);
    expect(strip.contains(screen.getByText("library"))).toBe(false);
    expect(strip.contains(screen.getByText("content"))).toBe(false);
  });

  it("gives the header the SplitView context", () => {
    // The whole reason it is a slot. A toggle in the header collapses the rail
    // and outlives it.
    render(
      <SplitView
        header={<SplitView.SidebarToggle aria-label="Toggle sidebar" pinned={false} />}
        sidebar={<div>library</div>}
        storageKey="test-header-ctx"
      >
        <div>content</div>
      </SplitView>,
    );
    expect(screen.getByText("library")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Toggle sidebar"));
    expect(screen.queryByText("library")).toBeNull();
    expect(screen.getByLabelText("Toggle sidebar")).toBeTruthy();
  });

  it("renders nothing extra when no header is passed", () => {
    const { container } = render(
      <SplitView sidebar={<div>library</div>}>
        <div>content</div>
      </SplitView>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.children).toHaveLength(1);
  });
});
