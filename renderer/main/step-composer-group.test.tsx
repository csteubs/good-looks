// The composer's GROUP kind: one submit inserts the named pair — the loop
// kind's idiom, so the halves can never drift apart.

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

function renderGroup() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="group"
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

describe("the group kind", () => {
  it("inserts the named pair together", () => {
    const { onAdd } = renderGroup();
    fireEvent.change(screen.getByLabelText("Group name"), { target: { value: "Log in" } });
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      { type: "group", label: "Log in" },
      { type: "endGroup" },
    ]);
  });

  it("refuses an empty name", () => {
    renderGroup();
    expect(addButton().disabled).toBe(true);
  });

  it("says it is organization only", () => {
    renderGroup();
    expect(screen.getByText(/organization only, nothing runs/i)).toBeTruthy();
  });
});
