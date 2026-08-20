// The composer's DIALOG kind: answer + optional prompt text, prompt field
// only for Accept.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { RawStep } from "../lib/recorder-types";
import { StepComposer } from "./step-composer";

vi.mock("../lib/api", () => ({
  api: {
    recorder: { countMatches: vi.fn(async () => 1) },
    tests: { listFlows: async () => [] },
  },
}));

function renderDialog() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="dialog"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={null}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

const submit = () => fireEvent.click(screen.getByRole("button", { name: /add step/i }));

describe("the dialog kind", () => {
  it("submits accept with the prompt text", () => {
    const { onAdd } = renderDialog();
    fireEvent.change(screen.getByLabelText("Prompt text"), { target: { value: "Jane" } });
    submit();
    expect(onAdd.mock.calls[0][0]).toEqual([
      { type: "dialog", dialogAction: "accept", value: "Jane" },
    ]);
  });

  it("dismiss hides the prompt field and submits bare", () => {
    const { onAdd } = renderDialog();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByLabelText("Prompt text")).toBeNull();
    submit();
    expect(onAdd.mock.calls[0][0]).toEqual([{ type: "dialog", dialogAction: "dismiss" }]);
  });

  it("says to place it before the trigger", () => {
    renderDialog();
    expect(screen.getByText(/BEFORE the step that triggers/i)).toBeTruthy();
  });
});
