// The composer's DOWNLOAD kind. What matters is the emitted RawStep's shape:
// a blank filename means "any download" (the await is the assertion), the
// exact toggle only exists once there is a name to be exact about, and the
// save-to-variable name is gated to identifiers before it ever leaves the
// panel — the generator gates again, but a value the UI refuses is one the
// user gets to fix while still looking at it.

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

function renderDownload() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="download"
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

describe("the download kind", () => {
  it("emits an any-download step when everything is blank", () => {
    const { onAdd } = renderDownload();
    submit();
    expect(onAdd.mock.calls[0][0]).toEqual([{ type: "download" }]);
  });

  it("carries the filename, and exact only when chosen", () => {
    const { onAdd } = renderDownload();
    fireEvent.change(screen.getByLabelText("Expected filename"), {
      target: { value: "report.csv" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /exact name/i }));
    submit();
    expect(onAdd.mock.calls[0][0]).toEqual([
      { type: "download", value: "report.csv", downloadMatch: "exact" },
    ]);
  });

  it("keeps a valid variable name and drops an invalid one", () => {
    const { onAdd } = renderDownload();
    fireEvent.change(screen.getByLabelText("Download filename variable"), {
      target: { value: "exportName" },
    });
    submit();
    expect((onAdd.mock.calls[0][0] as RawStep[])[0].captureVar).toBe("exportName");
    const second = renderDownload();
    fireEvent.change(screen.getAllByLabelText("Download filename variable")[1], {
      target: { value: "not a name" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /add step/i })[1]);
    expect((second.onAdd.mock.calls[0][0] as RawStep[])[0].captureVar).toBeUndefined();
  });
});
