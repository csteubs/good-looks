// The composer's API kind. The property worth pinning: a malformed piece —
// a bad header line, an out-of-range status, an invalid capture name —
// refuses the WHOLE submit rather than silently dropping the piece, because
// a step that quietly lost its Authorization header fails somewhere else
// with an error about the wrong thing.

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

function renderApi() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="api"
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
const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("the api kind", () => {
  it("builds the full step from the form", () => {
    const { onAdd } = renderApi();
    type(/request url/i, "https://api.example.com/users");
    type(/request headers/i, "Content-Type: application/json\nX-Trace: abc");
    type(/request body/i, '{"name":"Ada"}');
    type(/expected status/i, "201");
    type(/capture variable/i, "userId");
    type(/capture json path/i, "data.id");
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      {
        type: "api",
        apiMethod: "GET",
        url: "https://api.example.com/users",
        apiHeaders: { "Content-Type": "application/json", "X-Trace": "abc" },
        apiBody: '{"name":"Ada"}',
        expectStatus: 201,
        captureVar: "userId",
        capturePath: "data.id",
      },
    ]);
  });

  it("stays unsubmittable without a URL", () => {
    renderApi();
    expect(addButton().disabled).toBe(true);
  });

  it("refuses the whole submit on a malformed header line", () => {
    renderApi();
    type(/request url/i, "https://x.test/");
    expect(addButton().disabled).toBe(false);
    type(/request headers/i, "this line has no colon");
    expect(addButton().disabled).toBe(true);
  });

  it("refuses an out-of-range status and an invalid capture name", () => {
    renderApi();
    type(/request url/i, "https://x.test/");
    type(/expected status/i, "42");
    expect(addButton().disabled).toBe(true);
    type(/expected status/i, "204");
    expect(addButton().disabled).toBe(false);
    type(/capture variable/i, "not a name");
    expect(addButton().disabled).toBe(true);
  });
});
