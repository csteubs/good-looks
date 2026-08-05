// Component tests for the step editor.
//
// The editor works on a DRAFT: nothing is written until Save, so Cancel must
// discard every edit and Save must persist exactly what's on screen. That
// draft/commit boundary is the whole contract, and getting it wrong destroys
// the user's recorded test rather than merely misbehaving.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { Step, StepType } from "../lib/recorder-types";
import { EditStepsView } from "./edit-steps-view";

function step(id: string, partial: Partial<Step> & { type: StepType }): Step {
  return { id, timestamp: 0, ...partial } as Step;
}

const STEPS: Step[] = [
  step("a", { type: "goto", url: "https://example.com" }),
  step("b", { type: "click", locator: { k: "role", role: "button", name: "Submit" } }),
  step("c", { type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.test" }),
];

function renderEditor(steps: Step[] = STEPS) {
  const onCancel = vi.fn();
  const onSave = vi.fn(async (_s: Step[]) => {});
  render(<EditStepsView steps={steps} onCancel={onCancel} onSave={onSave} />);
  return { onCancel, onSave };
}

describe("rendering", () => {
  it("lists the steps it was given", () => {
    renderEditor();
    expect(screen.getByText(/example\.com/)).toBeTruthy();
    expect(screen.getByText(/Submit/)).toBeTruthy();
  });

  it("renders an empty step list without crashing", () => {
    expect(() => renderEditor([])).not.toThrow();
  });
});

describe("the draft/commit boundary", () => {
  it("saves the current draft", async () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("saves a deletion", async () => {
    const { onSave } = renderEditor();
    const deletes = screen.getAllByLabelText(/delete step/i);
    fireEvent.click(deletes[1]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("Cancel discards edits without saving", async () => {
    // The destructive direction: an edit that survives a Cancel silently
    // rewrites a recorded test the user chose not to change.
    const { onCancel, onSave } = renderEditor();
    fireEvent.click(screen.getAllByLabelText(/delete step/i)[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not mutate the steps it was handed", async () => {
    // The caller's array is live app state; mutating it would apply edits even
    // after a Cancel.
    const original = STEPS.map((s) => ({ ...s }));
    const { onSave } = renderEditor(original);
    fireEvent.click(screen.getAllByLabelText(/delete step/i)[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    expect(original.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});

describe("reordering", () => {
  it("moves a step and saves the new order", async () => {
    const { onSave } = renderEditor();
    const grips = screen.getAllByLabelText(/drag to reorder/i);

    // Drag the third step onto the first.
    fireEvent.dragStart(grips[2]);
    fireEvent.dragEnter(grips[0]);
    fireEvent.dragEnd(grips[2]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps every step when reordering", async () => {
    const { onSave } = renderEditor();
    const grips = screen.getAllByLabelText(/drag to reorder/i);
    fireEvent.dragStart(grips[0]);
    fireEvent.dragEnter(grips[2]);
    fireEvent.dragEnd(grips[0]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0].map((s) => s.id).sort();
    expect(saved).toEqual(["a", "b", "c"]);
  });

  it("is a no-op when a step is dropped on itself", async () => {
    const { onSave } = renderEditor();
    const grips = screen.getAllByLabelText(/drag to reorder/i);
    fireEvent.dragStart(grips[1]);
    fireEvent.dragEnter(grips[1]);
    fireEvent.dragEnd(grips[1]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
