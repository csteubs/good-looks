import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Menu } from "./menu";
import { MenuItem } from "./menu-item";

// `Menu` shipped in B3 with no test file at all — `MenuItem` had one, the box it
// goes in did not. That gap is the reason the keyboard hole below survived
// review: the primitive's own header enumerates the four behaviours it owns, and
// everything NOT on that list was unowned and unasserted.
//
// The four documented behaviours are pinned here alongside the keyboard pattern
// its ARIA roles promise. `role="menu"` + `role="menuitem"` is a specific claim
// to assistive tech — that arrow keys move between items — and the menu made
// that claim while ArrowDown did nothing. Verified against the real app with
// CDP-level key events before this was written, because a synthetic
// KeyboardEvent dispatched at the wrong node reports the same "nothing
// happened" as a missing handler and cannot tell you which one you have.

function items(): HTMLElement[] {
  return screen.getAllByRole("menuitem");
}

/** Assert focus by ELEMENT IDENTITY, never by matching the active element's
 *  text.
 *
 *  `document.activeElement` is `document.body` when nothing has focus, and
 *  `body.textContent` contains every label in the tree — so
 *  `expect(active.textContent).toContain("4 at once")` passes while focus has
 *  not moved at all. Written that way first, and the ArrowDown and Home/End
 *  cases below both passed against a component with no key handler whatsoever.
 *  They would have shipped green over the exact hole they were written for. */
function expectFocused(index: number, label: string): void {
  const active = document.activeElement;
  expect(active).not.toBe(document.body);
  expect(active).toBe(items()[index]);
  // Belt and braces: identity is the real assertion, this only makes a failure
  // legible when the indices drift.
  expect(items()[index].textContent).toContain(label);
}

function renderMenu(onSelect = vi.fn(), selectedLabel = "2 at once") {
  render(
    <Menu value={selectedLabel} label="How many tests to run at once">
      {(close) =>
        ["Off", "2 at once", "4 at once", "8 at once"].map((label) => (
          <MenuItem
            key={label}
            label={label}
            consequence={`consequence for ${label}`}
            selected={label === selectedLabel}
            onSelect={() => {
              onSelect(label);
              close();
            }}
          />
        ))
      }
    </Menu>,
  );
  return { onSelect, trigger: screen.getByRole("button", { name: "How many tests to run at once" }) };
}

describe("<Menu /> — the four behaviours it documents owning", () => {
  it("reports aria-expanded on the trigger, both ways", () => {
    const { trigger } = renderMenu();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    // Without the return, a keyboard user is dropped at the top of the document
    // and the next Tab starts from the beginning.
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a pointerdown outside, not a click", () => {
    // `pointerdown`, not `click`: a click fires after the pointer comes up, so a
    // menu that closes on click is still open while the user is already pressing
    // the thing behind it.
    const { trigger } = renderMenu();
    fireEvent.click(trigger);

    fireEvent.click(document.body);
    expect(screen.queryByRole("menu")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes when an item is chosen, and reports the choice", () => {
    // A menu that stays open after a choice reads as though the choice did not
    // take.
    const { trigger, onSelect } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /4 at once/ }));

    expect(onSelect).toHaveBeenCalledWith("4 at once");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("<Menu /> — the keyboard pattern its roles promise", () => {
  it("moves focus to the item in force when it opens", () => {
    // Not the first item: a native menu opens with the current value under the
    // cursor, and `MenuItem` already marks it with aria-current. Opening on
    // "Off" when the batch is set to 2 invites an accidental change of a
    // setting the user only came to look at.
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    expectFocused(1, "2 at once");
    expect(document.activeElement?.getAttribute("aria-current")).toBe("true");
  });

  it("falls back to the first item when nothing is in force", () => {
    render(
      <Menu value="—" label="Scope">
        {() => ["a", "b"].map((l) => <MenuItem key={l} label={l} />)}
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Scope" }));
    expectFocused(0, "a");
  });

  it("walks items with ArrowDown and ArrowUp, wrapping at both ends", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");

    // opens on "2 at once", index 1
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expectFocused(2, "4 at once");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expectFocused(3, "8 at once");
    // wraps forward
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expectFocused(0, "Off");
    // wraps back
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expectFocused(3, "8 at once");
  });

  it("jumps to the ends with Home and End", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "End" });
    expectFocused(3, "8 at once");
    fireEvent.keyDown(menu, { key: "Home" });
    expectFocused(0, "Off");
  });

  it("keeps exactly one item tabbable, so Tab leaves the menu instead of walking it", () => {
    // Before the pattern landed every item was tabIndex 0, which is how the menu
    // stayed operable at all — Tab walked the list. That is the anti-pattern the
    // menu role exists to avoid: it makes a four-option menu four stops on the
    // way to the next control.
    const { trigger } = renderMenu();
    fireEvent.click(trigger);

    const tabbable = items().filter((el) => el.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("aria-current")).toBe("true");
    expect(items().filter((el) => el.tabIndex === -1)).toHaveLength(3);
  });

  it("closes on Tab so focus lands after the trigger, not in a menu left open behind it", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not swallow Tab's default, which would trap focus in a closed menu", () => {
    // Closing on Tab is only correct if Tab still MOVES. preventDefault here
    // would shut the menu and strand the caret on the trigger, which reads as a
    // dead Tab key.
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    menu.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
