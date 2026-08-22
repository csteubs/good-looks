// The Refine dialog's custom-locator row — the escape hatch DECISIONS 7491
// removed as the default path, back as the LAST resort under the candidates.
// What's pinned: choosing Custom gates the confirm on a valid draft (an
// invalid draft must not fall back to a candidate silently), and applying
// hands the parent exactly the typed locator.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { PickedElement } from "../lib/recorder-types";
import { api } from "../lib/api";
import { ambiguousTargetHint } from "./element-context-picker";
import { RefineSelectorDialog } from "./refine-selector-dialog";

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      countMatches: vi.fn(async () => 1),
    },
  },
}));

beforeEach(() => {
  vi.mocked(api.recorder.countMatches).mockReset();
  vi.mocked(api.recorder.countMatches).mockResolvedValue(1);
});

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

describe("position among matches", () => {
  it("applies Last as the model's -1 on the selected candidate", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Last" }));
    fireEvent.click(confirmButton());
    expect(onApply).toHaveBeenCalledWith({
      k: "role",
      role: "button",
      name: "Submit",
      nth: -1,
    });
  });

  it("Auto strips a previously chosen position", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "First" }));
    fireEvent.click(screen.getByRole("radio", { name: "Auto" }));
    fireEvent.click(confirmButton());
    expect(onApply).toHaveBeenCalledWith({ k: "role", role: "button", name: "Submit" });
  });
});

describe("the match-count gate", () => {
  // The same rule the composer applies (step-composer-count-gate.test.tsx):
  // this dialog is the other way an ambiguous locator gets written.
  it("disables Update while the chosen locator matches several elements, and says so", async () => {
    vi.mocked(api.recorder.countMatches).mockResolvedValue(2);
    const { onApply } = renderDialog();
    await screen.findByText(ambiguousTargetHint(2));
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    expect(onApply).not.toHaveBeenCalled();
  });

  it("lifts the refusal once a position is chosen", async () => {
    vi.mocked(api.recorder.countMatches).mockResolvedValue(2);
    const { onApply } = renderDialog();
    await screen.findByText(ambiguousTargetHint(2));
    fireEvent.click(screen.getByText("Last"));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(confirmButton());
    expect(onApply).toHaveBeenCalledWith({ k: "role", role: "button", name: "Submit", nth: -1 });
  });

  it("never blocks on a count it could not take", async () => {
    vi.mocked(api.recorder.countMatches).mockResolvedValue(-1);
    renderDialog();
    await waitFor(() => expect(api.recorder.countMatches).toHaveBeenCalled());
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(screen.queryByText(/the run would refuse it/)).toBeNull();
  });
});
