// The composer's AI-CHECK kind: a claim, nothing else — no element, no
// value. An empty claim refuses the submit; the copy must say the verdict
// never fails the run (the honesty line the whole feature stands on).

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

function renderAiCheck() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="aiCheck"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={null}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

const addButton = () => screen.getByRole("button", { name: /add step/i }) as HTMLButtonElement;

describe("the ai-check kind", () => {
  it("submits the trimmed claim as the step's text", () => {
    const { onAdd } = renderAiCheck();
    fireEvent.change(screen.getByLabelText("AI check claim"), {
      target: { value: "  the cart badge shows 3  " },
    });
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([{ type: "aiCheck", text: "the cart badge shows 3" }]);
  });

  it("refuses an empty claim", () => {
    renderAiCheck();
    expect(addButton().disabled).toBe(true);
  });

  it("says the verdict never fails the run", () => {
    renderAiCheck();
    expect(screen.getByText(/never fails on the verdict/i)).toBeTruthy();
  });
});
