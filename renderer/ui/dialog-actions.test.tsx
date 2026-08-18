// The composed dialog's action row: what is in it, and that it can wrap.
//
// The bug: in the trainer panel (360 DIP wide → a 296px dialog → 264px of
// content) the exit dialog's footer held "Discard Edits", "Cancel" and
// "Save & Exit" — about 282px of `whitespace-nowrap` buttons in a nowrap flex
// row. `justify-end` anchors the row's END to the container, so the surplus
// hung off the LEFT and the destructive button sat outside the panel, painted
// over the step list behind it. Clicking either Discard or Save Test in the
// trainer put it there.
//
// Two properties hold the fix and they fail independently, so both are pinned
// here and in `check:dialog-footer`:
//
//   1. Cancel is GONE. Every composed dialog renders the close "X" (Radix also
//      closes on Escape and on the overlay click), so it was a third way to do
//      one thing, costing ~75px of a 264px row.
//   2. The footer WRAPS. That is the half that survives someone adding a button
//      back — which is explicitly allowed. Without it, removing Cancel only
//      buys headroom until the next label is longer.
//
// What this file CANNOT do is measure. jsdom has no layout engine and the dom
// project runs with `css: false`, so `flex-wrap` never produces a second row
// here and a `getBoundingClientRect` assertion would read zeros in both the
// fixed and the broken case — passing vacuously forever. The class is asserted
// as a proxy; `e2e/dialog-footer.spec.ts` is the one that lays this out in a
// real browser and checks nothing escapes the panel.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Dialog, DialogActions } from "./index";

function footerEl(): HTMLElement {
  const el = document.querySelector("[data-dialog-footer]");
  if (!el) throw new Error("no [data-dialog-footer] rendered");
  return el as HTMLElement;
}

/** Label text of every button in the footer, in DOM order. */
function footerButtons(): string[] {
  return within(footerEl())
    .getAllByRole("button")
    .map((b) => b.textContent ?? "");
}

function renderExitDialog(extra?: React.ReactNode) {
  const onConfirm = vi.fn();
  const onDiscard = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Save changes to this test?"
      description="You have unsaved edits to this test's steps."
      confirmLabel="Save & Exit"
      confirmVariant="accent"
      onConfirm={onConfirm}
      destructiveAction={{ label: "Discard Edits", onClick: onDiscard }}
    >
      {extra}
    </Dialog>,
  );
  return { onConfirm, onDiscard, onOpenChange };
}

describe("the composed dialog's footer", () => {
  it("renders no Cancel button", () => {
    renderExitDialog();

    // Both spellings of the assertion. The role query is the contract; the
    // text query catches a Cancel that comes back as something other than a
    // button and puts the same width back into the row.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  it("renders only the actions the caller asked for", () => {
    renderExitDialog();

    // Stated as an exhaustive list rather than "contains", so a fourth button
    // added to the shared footer has to come through this test. The footer
    // wraps, so that is a decision to review, not a defect — but silently
    // adding width to a 264px row is how this bug happened.
    expect(footerButtons()).toEqual(["Discard Edits", "Save & Exit"]);
  });

  it("still offers a way out: the close X dismisses the dialog", () => {
    // The load-bearing half of removing Cancel. If this ever stops being
    // rendered, a dialog with a destructive primary action becomes one the
    // user can only answer, and the Cancel removal turns into a trap.
    const { onOpenChange, onConfirm, onDiscard } = renderExitDialog();

    fireEvent.click(screen.getByLabelText("Close"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("wires each action to its own handler", () => {
    const { onConfirm, onDiscard } = renderExitDialog();

    fireEvent.click(screen.getByRole("button", { name: "Discard Edits" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save & Exit" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("does NOT close itself when the confirm resolves — callers close themselves", async () => {
    // THE CONTRACT, stated once. Every caller of `Dialog` was written against
    // an auto-close that does not exist in this tree, which is how a modal and
    // its full-viewport overlay came to sit on top of a started recording for
    // the rest of the session. Restoring auto-close here is not the fix:
    // `IssueComposeDialog` deliberately swallows its errors and must stay open,
    // so a global close would break it. Callers close themselves instead —
    // `check:dialog-close` enumerates the ones that must.
    //
    // Whichever future change flips this contract has to come through this
    // test, and then through every caller that no longer needs its own close.
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn(async () => {});
    render(
      <Dialog
        open
        onOpenChange={onOpenChange}
        title="Start something"
        description="Confirming here does something that outlives the dialog."
        confirmLabel="Start"
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    // Stated as "never with false" rather than "not called at all": the point
    // is that nothing dismissed the dialog, whatever else it may have done.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("lays its buttons out in a row that is allowed to wrap", () => {
    renderExitDialog();

    // `flex-wrap` is the property that makes overflow structurally impossible:
    // buttons that do not fit cost a second row instead of leaving the box.
    // Asserted as a class because jsdom cannot observe the row itself.
    expect(footerEl().className).toContain("flex-wrap");
  });

  it("keeps every action inside the footer, however many there are", () => {
    // The "or any other button" case: a Cancel put back, plus a secondary
    // action, plus long labels — the configuration that overflowed. Nothing may
    // escape the footer element, and the footer must still be a wrapping row.
    render(
      <DialogActions
        onConfirm={vi.fn()}
        confirmLabel="Regenerate script"
        destructiveAction={{ label: "Discard Edits", onClick: vi.fn() }}
        secondaryAction={{ label: "Save steps only", onClick: vi.fn() }}
      />,
    );

    const footer = footerEl();
    expect(footerButtons()).toEqual(["Discard Edits", "Save steps only", "Regenerate script"]);

    // Every button is a DIRECT child, so none of them is positioned out of the
    // flow — an absolutely positioned action would not be wrapped by the row
    // and would go straight back to hanging outside the panel.
    for (const button of within(footer).getAllByRole("button")) {
      expect(button.parentElement).toBe(footer);
      expect(button.className).not.toContain("absolute");
      expect(button.className).not.toContain("fixed");
    }
    expect(footer.className).toContain("flex-wrap");
  });
});
