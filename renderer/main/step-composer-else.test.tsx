// The condition kind's ELSE checkbox. One submit inserts the whole shape —
// if/else/endif with the box ticked, the plain pair without — so the two
// halves can never be inserted separately and drift out of pairing.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { PickedElement, RawStep } from "../lib/recorder-types";
import { StepComposer } from "./step-composer";

vi.mock("../lib/api", () => ({
  api: {
    recorder: { countMatches: vi.fn(async () => 1) },
    tests: { listFlows: async () => [] },
  },
}));

function picked(): PickedElement {
  return {
    tag: "button",
    description: "button.btn",
    candidates: [{ k: "testid", v: "banner" }],
    css: {},
    attributes: {},
    ambiguous: false,
    contextBaseCount: 1,
    contextSignals: [],
  };
}

function renderCondition() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="condition"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={picked()}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /add step/i }));
}

describe("the condition kind's else checkbox", () => {
  it("inserts the plain pair when unticked", () => {
    const { onAdd } = renderCondition();
    submit();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect((onAdd.mock.calls[0][0] as RawStep[]).map((s) => s.type)).toEqual(["if", "endif"]);
  });

  it("rides the else along when ticked", () => {
    const { onAdd } = renderCondition();
    fireEvent.click(screen.getByLabelText("Include an ELSE branch"));
    submit();
    const steps = onAdd.mock.calls[0][0] as RawStep[];
    expect(steps.map((s) => s.type)).toEqual(["if", "else", "endif"]);
    // The else itself carries nothing — no condition, no locator. Its meaning
    // is entirely positional.
    expect(steps[1]).toEqual({ type: "else" });
  });
});
