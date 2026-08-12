// RailFlyout's behaviours.
//
// The one that matters most is the FIRST: the panel must not be a descendant of
// the rail. `SplitView` wraps the sidebar in `overflow-hidden`, so a panel
// rendered in place is clipped at the rail's edge — and jsdom, which has no
// layout engine, reports that clipped menu as perfectly present. Every other
// test in this file would pass against a menu nobody can see. Structure is the
// part of the fix that jsdom CAN observe, so structure is what is pinned.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RailFlyout } from "./rail-flyout";
import { RailRow } from "./rail";

/** The intent delay, from rail-flyout.tsx. Advancing "enough" rather than an
 *  exact value, so a tuning change does not break these. */
const PAST_OPEN_DELAY = 200;
const PAST_CLOSE_DELAY = 300;

function Harness({
  disabled,
  onOpenChange,
}: {
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  return (
    <div className="gl-rail" data-testid="rail">
      <RailFlyout
        label="Branches"
        disabled={disabled}
        {...(onOpenChange ? { onOpenChange } : {})}
        panel={
          <>
            <button type="button" role="menuitem">
              first item
            </button>
            <button type="button" role="menuitem">
              second item
            </button>
          </>
        }
      >
        {(trigger) => <RailRow {...trigger} title="Branches" subtitle="Run a PR of this app" />}
      </RailFlyout>
    </div>
  );
}

function hoverIn(): void {
  fireEvent.pointerEnter(screen.getByRole("button", { name: /Branches/ }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("RailFlyout — where the panel lives", () => {
  it("renders the panel OUTSIDE the rail, so overflow:hidden cannot clip it", async () => {
    // The bug this is the whole file's reason for: SplitView wraps the sidebar
    // in `overflow-hidden`. A panel inside the rail renders, has a size, and is
    // in the accessibility tree — and is almost entirely off screen. jsdom
    // cannot see that; it can see this.
    render(<Harness />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);

    const panel = await screen.findByRole("menu", { name: "Branches" });
    const rail = screen.getByTestId("rail");
    expect(rail.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
  });

  it("is anchored by its BOTTOM edge, so growing taller moves its top up", async () => {
    // The bug: this menu fetches nothing until it is first opened, so it is
    // placed while it still says "Reading branches…" and gets five rows taller
    // a moment later. Pinned by `top`, that growth goes DOWNWARD and the menu
    // is cut off by the bottom of the window — which is exactly what happened
    // on the first cold launch after the merge.
    //
    // jsdom cannot see it. `getBoundingClientRect` returns zeros, so every
    // placement number is 0 and the assertion "it is on screen" is unavailable.
    // What IS observable is which edge the panel is pinned by, and that is the
    // whole of the fix — with `bottom` set and `top` unset, growth is upward as
    // a property of the layout rather than something re-measured after the fact.
    render(<Harness />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);

    const panel = await screen.findByRole("menu");
    expect(panel.style.bottom).not.toBe("");
    expect(panel.style.top).toBe("");
    // And it can never be taller than the space above the row.
    expect(panel.style.maxHeight).not.toBe("");
  });

  it("removes the panel from the document when it closes", async () => {
    // A portal outlives its parent's re-render, so "hidden" is not enough:
    // a left-behind panel keeps its menuitems focusable and tabbable.
    render(<Harness />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);
    expect(await screen.findByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("RailFlyout — hover intent", () => {
  it("does not open the instant the pointer touches the row", () => {
    // Dragging down the rail past this row would otherwise flash a menu open
    // and shut on top of whatever the user was reaching for.
    render(<Harness />);
    hoverIn();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens once the pointer rests", async () => {
    render(<Harness />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("does not open at all if the pointer leaves before the delay", async () => {
    render(<Harness />);
    const row = screen.getByRole("button", { name: /Branches/ });
    fireEvent.pointerEnter(row);
    fireEvent.pointerLeave(row);
    await advance(PAST_OPEN_DELAY);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not close the instant the pointer leaves", async () => {
    render(<Harness />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);
    fireEvent.pointerLeave(screen.getByRole("button", { name: /Branches/ }));
    // Still there: overshooting the row by a few pixels mid-travel must not
    // take the menu away.
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes after the grace period", async () => {
    render(<Harness />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);
    fireEvent.pointerLeave(screen.getByRole("button", { name: /Branches/ }));
    await advance(PAST_CLOSE_DELAY);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays open when the pointer travels into the panel", async () => {
    // The classic "menu closes while you are on your way to it".
    //
    // This test does NOT prove the panel's own pointer handlers are wired:
    // deleting them leaves it green, because React propagates events out of a
    // portal along the React tree, so the wrapper sees the pointer arrive in
    // the panel regardless. What it pins is the BEHAVIOUR, which is the part
    // that matters and which survives either mechanism.
    render(<Harness />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);

    const panel = screen.getByRole("menu");
    fireEvent.pointerLeave(screen.getByRole("button", { name: /Branches/ }));
    fireEvent.pointerEnter(panel);
    await advance(PAST_CLOSE_DELAY);

    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes when the pointer leaves the panel", async () => {
    render(<Harness />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);

    const panel = screen.getByRole("menu");
    fireEvent.pointerEnter(panel);
    fireEvent.pointerLeave(panel);
    await advance(PAST_CLOSE_DELAY);

    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("RailFlyout — dismissal", () => {
  it("closes on a pointerdown elsewhere, not on the click that follows", async () => {
    // `pointerdown`, not `click`: a click fires on release, so a menu that
    // closes on click is still covering the thing being pressed.
    render(
      <>
        <Harness />
        <button type="button">something behind</button>
      </>,
    );
    hoverIn();
    await advance(PAST_OPEN_DELAY);

    fireEvent.pointerDown(screen.getByRole("button", { name: "something behind" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("stays open on a pointerdown INSIDE the panel", async () => {
    // The panel is not a descendant of the wrapper, so a naive "outside" test
    // written against the wrapper alone closes the menu on its own items.
    render(<Harness />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);

    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "first item" }));
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("returns focus to the row when Escape closes it", async () => {
    // Without this the caret is dropped at the top of the document and the next
    // Tab starts over from the beginning.
    render(<Harness />);
    const row = screen.getByRole("button", { name: /Branches/ });
    hoverIn();
    await advance(PAST_OPEN_DELAY);
    screen.getByRole("menuitem", { name: "first item" }).focus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(row));
  });
});

describe("RailFlyout — keyboard", () => {
  it("opens on ArrowRight and puts focus on the first item", async () => {
    // Hover alone would make this mouse-only.
    render(<Harness />);
    const row = screen.getByRole("button", { name: /Branches/ });
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowRight" });

    const first = await screen.findByRole("menuitem", { name: "first item" });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("leaves Enter alone, because the row's own click still navigates", async () => {
    // Hijacking Enter would make the keyboard path disagree with the pointer
    // one, where clicking the row opens the full view.
    render(<Harness />);
    const row = screen.getByRole("button", { name: /Branches/ });
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    await advance(PAST_OPEN_DELAY);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves between items with ArrowDown and ArrowUp", async () => {
    render(<Harness />);
    const row = screen.getByRole("button", { name: /Branches/ });
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowDown" });

    const first = await screen.findByRole("menuitem", { name: "first item" });
    const second = screen.getByRole("menuitem", { name: "second item" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });

  it("wraps at the ends rather than stopping", async () => {
    render(<Harness />);
    const row = screen.getByRole("button", { name: /Branches/ });
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowDown" });
    await screen.findByRole("menu");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "first item" })),
    );

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "second item" }));
  });

  it("closes on ArrowLeft and returns focus to the row", async () => {
    render(<Harness />);
    const row = screen.getByRole("button", { name: /Branches/ });
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowRight" });
    await screen.findByRole("menu");

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowLeft" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(row);
  });
});

describe("RailFlyout — the trigger reports its state", () => {
  it("announces the popup and whether it is open", async () => {
    render(<Harness />);
    const row = screen.getByRole("button", { name: /Branches/ });
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
    expect(row.getAttribute("aria-expanded")).toBe("false");

    hoverIn();
    await advance(PAST_OPEN_DELAY);
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("reports open and close once each", async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);
    expect(onOpenChange.mock.calls).toEqual([[true]]);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[true], [false]]));
  });
});

describe("RailFlyout — disabled", () => {
  it("does not open on hover", async () => {
    render(<Harness disabled />);
    hoverIn();
    await advance(PAST_OPEN_DELAY);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not open on the keyboard either", async () => {
    // Two separate paths into `open`; disabling one and not the other is the
    // easy version of this bug.
    render(<Harness disabled />);
    const row = screen.getByRole("button", { name: /Branches/ });
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowRight" });
    await advance(PAST_OPEN_DELAY);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("still renders the row", async () => {
    render(<Harness disabled />);
    expect(screen.getByRole("button", { name: /Branches/ })).toBeTruthy();
  });
});
