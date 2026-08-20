// The composer's UPLOAD kind: stage through the picker, submit only with an
// element AND a staged file — an upload step with either missing is one the
// generator refuses, so the Add button must never offer it.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { PickedElement, RawStep } from "../lib/recorder-types";
import { StepComposer } from "./step-composer";

const stageUpload = vi.fn(async () => ({
  relPath: "uploads/t-1/report.csv" as string | undefined,
  name: "report.csv" as string | undefined,
  canceled: undefined as boolean | undefined,
  problem: undefined as string | undefined,
}));

vi.mock("../lib/api", () => ({
  api: {
    recorder: {
      countMatches: vi.fn(async () => 1),
      stageUpload: () => stageUpload(),
    },
    tests: { listFlows: async () => [] },
  },
}));

function picked(): PickedElement {
  return {
    tag: "input",
    description: "input[type=file]",
    candidates: [{ k: "testid", v: "avatar" }],
    css: {},
    attributes: {},
    ambiguous: false,
    contextBaseCount: 1,
    contextSignals: [],
  };
}

function renderUpload(el: PickedElement | null = picked()) {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="upload"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={el}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

const addButton = () => screen.getByRole("button", { name: /add step/i }) as HTMLButtonElement;

describe("the upload kind", () => {
  it("stays unsubmittable until a file is staged, then emits the staged path", async () => {
    const { onAdd } = renderUpload();
    expect(addButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /choose file/i }));
    await waitFor(() => expect(screen.getByText("report.csv")).toBeTruthy());
    expect(addButton().disabled).toBe(false);
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      {
        type: "upload",
        locator: { k: "testid", v: "avatar" },
        value: "uploads/t-1/report.csv",
      },
    ]);
  });

  it("stays unsubmittable with a file but no element", async () => {
    renderUpload(null);
    fireEvent.click(screen.getByRole("button", { name: /choose file/i }));
    await waitFor(() => expect(screen.getByText("report.csv")).toBeTruthy());
    expect(addButton().disabled).toBe(true);
  });

  it("says nothing changed when the picker was cancelled", async () => {
    stageUpload.mockResolvedValueOnce({
      canceled: true,
      relPath: undefined,
      name: undefined,
      problem: undefined,
    });
    renderUpload();
    fireEvent.click(screen.getByRole("button", { name: /choose file/i }));
    await waitFor(() => expect(stageUpload).toHaveBeenCalled());
    expect(screen.getByText(/no file staged yet/i)).toBeTruthy();
  });
});
