// The Refine dialog's custom-locator row — the escape hatch DECISIONS 7491
// removed as the default path, back as the LAST resort under the candidates.
// What's pinned: choosing Custom gates the confirm on a valid draft (an
// invalid draft must not fall back to a candidate silently), and applying
// hands the parent exactly the typed locator.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { PickedElement } from "../lib/recorder-types";
import { RefineSelectorDialog } from "./refine-selector-dialog";

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      countMatches: async () => 1,
    },
  },
}));

const PICKED: PickedElement = {
  tag: "button",
  description: "button#submit",
  candidates: [
    { k: "role", role: "button", name: "Submit" },
    { k: "css", v: "#submit" },
  ],
  css: {},
  attributes: {},
  ambiguous: false,
  contextBaseCount: 1,
  contextSignals: [],
};

function renderDialog() {
  const onApply = vi.fn();
  render(<RefineSelectorDialog picked={PICKED} onApply={onApply} onClose={() => {}} />);
  return { onApply };
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /update selector/i }) as HTMLButtonElement;
}

describe("the candidate path (unchanged)", () => {
  it("applies the selected candidate", () => {
    const { onApply } = renderDialog();
    fireEvent.click(confirmButton());
    expect(onApply).toHaveBeenCalledWith({ k: "role", role: "button", name: "Submit" });
  });
});

describe("the custom row", () => {
  it("disables the confirm until the draft is a valid locator", async () => {
    renderDialog();
    fireEvent.click(screen.getByText(/write a css selector or xpath by hand/i));
    expect(confirmButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Custom locator"), {
      target: { value: "text=nope" },
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
  });

  it("applies the typed locator, not a candidate", async () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByText(/write a css selector or xpath by hand/i));
    fireEvent.change(screen.getByLabelText("Custom locator"), {
      target: { value: "form#login button.primary" },
    });
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(confirmButton());
    expect(onApply).toHaveBeenCalledWith({ k: "css", v: "form#login button.primary" });
  });

  it("switching back to a candidate applies that candidate again", async () => {
    // The radio metaphor must hold: Custom is one option, not a mode the
    // dialog gets stuck in.
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByText(/write a css selector or xpath by hand/i));
    fireEvent.change(screen.getByLabelText("Custom locator"), {
      target: { value: ".x" },
    });
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(screen.getByText('locator("#submit")'));
    fireEvent.click(confirmButton());
    expect(onApply).toHaveBeenCalledWith({ k: "css", v: "#submit" });
  });
});
