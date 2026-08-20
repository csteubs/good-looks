// The composer's A11Y kind: one submit inserts the gate with its impact
// floor. No element, no value — the page as a whole is the subject.

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

function renderA11y() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="a11y"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={null}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

describe("the a11y kind", () => {
  it("inserts a gate at the serious floor by default", () => {
    const { onAdd } = renderA11y();
    fireEvent.click(screen.getByRole("button", { name: /add step/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toEqual([{ type: "a11y", a11yImpact: "serious" }]);
  });

  it("says what the gate does and that accepted violations don't fail it", () => {
    renderA11y();
    expect(screen.getByText(/FAILS the test on any new violation/i)).toBeTruthy();
    expect(screen.getByText(/accepted/i)).toBeTruthy();
  });
});
