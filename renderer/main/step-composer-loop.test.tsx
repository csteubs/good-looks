// The composer's LOOP kind: one submit inserts the repeat block's two halves
// together, count clamped. The pair-insertion idiom is the condition kind's —
// the user drags steps between the halves afterwards — and the clamp here is
// the first of the three independent guards on a numeral that lands in the
// generated spec bare (boundary and generator are the other two).

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

function renderLoop() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="loop"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={null}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /add step/i }));
}

describe("the loop kind", () => {
  it("inserts the pair together with the typed count", () => {
    const { onAdd } = renderLoop();
    fireEvent.change(screen.getByLabelText("Loop count"), { target: { value: "5" } });
    submit();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toEqual([
      { type: "loop", loopCount: 5 },
      { type: "endLoop" },
    ]);
  });

  it("clamps garbage and out-of-range counts instead of refusing", () => {
    const { onAdd } = renderLoop();
    fireEvent.change(screen.getByLabelText("Loop count"), { target: { value: "9999" } });
    submit();
    expect((onAdd.mock.calls[0][0] as RawStep[])[0].loopCount).toBe(500);
  });

  it("says the preview walks the body once", () => {
    renderLoop();
    expect(screen.getByText(/preview walks the body once/i)).toBeTruthy();
  });
});
