// Component tests for the duplicate warning dialog.
//
// The dialog's whole job is to be READ, which makes its failure modes textual
// rather than behavioural: a warning that renders its id instead of its
// sentence, a "Not copied" list that quietly empties, a confirm button that
// stays live through a second click and duplicates twice. None of those throw.

import type * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { DuplicationWarning } from "../lib/duplicate-warnings";
import { NOT_COPIED } from "../lib/duplicate-warnings";
import { DuplicateTestDialog } from "./duplicate-test-dialog";

const WARNINGS: DuplicationWarning[] = [
  { id: "secrets", title: "1 stored secret value", detail: "Copied to the new test as well." },
  { id: "cookies", title: "2 cookie steps", detail: "Copied with their recorded values." },
];

function renderDialog(over: Partial<React.ComponentProps<typeof DuplicateTestDialog>> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <DuplicateTestDialog
      testName="Login"
      warnings={WARNINGS}
      open
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      {...over}
    />,
  );
  return { onConfirm, onOpenChange };
}

/** The dialog's primary action, whatever its current label. */
function confirmButton(): HTMLElement {
  return screen.getByRole("button", { name: /duplicat/i });
}

describe("DuplicateTestDialog", () => {
  it("names the test being copied", () => {
    renderDialog();
    expect(screen.getByText(/Duplicate “Login”\?/)).toBeTruthy();
  });

  it("renders every warning's title AND its detail", () => {
    // A title alone states a fact about the original; the detail is the half
    // that says what duplicating does with it.
    renderDialog();
    for (const w of WARNINGS) {
      expect(screen.getByText(w.title)).toBeTruthy();
      expect(screen.getByText(w.detail)).toBeTruthy();
    }
  });

  it("lists what a copy never inherits", () => {
    renderDialog();
    for (const item of NOT_COPIED) {
      expect(screen.getByText(new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
    }
  });

  it("still shows the 'not copied' list when there are no warnings", () => {
    // The sidebar doesn't open the dialog in this state, but a component that
    // renders an empty shell is one bad guard away from shipping it.
    renderDialog({ warnings: [] });
    expect(screen.getByText(/Not copied/)).toBeTruthy();
  });

  it("calls onConfirm when the primary action is clicked", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables the action while a duplication is in flight", () => {
    // Two clicks would create two copies, numbered [2] and [3], from one
    // decision — and the second only becomes visible in the sidebar.
    const { onConfirm } = renderDialog({ busy: true });
    const button = confirmButton();
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says so while it is working", () => {
    renderDialog({ busy: true });
    expect(screen.getByRole("button", { name: /duplicating/i })).toBeTruthy();
  });

  it("offers a way out that isn't the primary action", () => {
    // That way out is the close "X", not a Cancel button — the composed
    // dialog's footer dropped Cancel because three actions did not fit the
    // trainer panel's 264px row (see renderer/ui/dialog-actions.test.tsx). The
    // property this test exists for is unchanged: a dialog whose only button is
    // the thing it is asking you to agree to is a trap.
    renderDialog();
    expect(screen.getByLabelText("Close")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("renders nothing when closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByText(/Duplicate “Login”\?/)).toBeNull();
  });
});
