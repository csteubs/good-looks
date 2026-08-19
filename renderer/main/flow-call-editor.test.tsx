// Component tests for the flow-call parameter dialog.
//
// The rule worth pinning is the empty-field one: an empty input means "follow
// the flow's default", so it must NOT be saved as an override of "". Saving it
// would pin the call to an empty string, and the flow's default changing later
// would silently not apply — the exact confusion the two-layer model exists to
// avoid. The other pins: a secret/captured parameter is never offered a text
// override (that would route a plaintext value where the runtime one belongs),
// and a deleted flow is said out loud rather than rendered as zero parameters.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { Step, TestRecord } from "../lib/recorder-types";
import { FlowCallDialog, paramFields } from "./flow-call-editor";

let flowRecord: TestRecord | null = null;

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      get: async () => flowRecord,
    },
  },
}));

function makeFlow(partial: Partial<TestRecord> = {}): TestRecord {
  return {
    id: "f1",
    name: "Login",
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: "/tmp/f1.spec.ts",
    isFlow: true,
    flowParams: ["email"],
    variables: [{ name: "email", kind: "plain", value: "default@example.com" }],
    ...partial,
  } as TestRecord;
}

function makeCall(partial: Partial<Step> = {}): Step {
  return { id: "s1", type: "runFlow", flowId: "f1", label: "Login", timestamp: 0, ...partial };
}

beforeEach(() => {
  flowRecord = null;
});

describe("FlowCallDialog", () => {
  it("shows each parameter with the flow's default as the placeholder", async () => {
    flowRecord = makeFlow();
    render(
      <FlowCallDialog step={makeCall()} open onOpenChange={() => {}} onSave={() => {}} />,
    );
    const input = (await screen.findByLabelText("Override for email")) as HTMLInputElement;
    expect(input.placeholder).toBe("default: default@example.com");
  });

  it("saves only non-empty overrides — an empty field follows the default", async () => {
    flowRecord = makeFlow({
      flowParams: ["email", "region"],
      variables: [
        { name: "email", kind: "plain", value: "default@example.com" },
        { name: "region", kind: "plain", value: "eu" },
      ],
    });
    const onSave = vi.fn();
    render(<FlowCallDialog step={makeCall()} open onOpenChange={() => {}} onSave={onSave} />);
    const email = await screen.findByLabelText("Override for email");
    fireEvent.change(email, { target: { value: "buyer@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ email: "buyer@example.com" }));
  });

  it("clearing an override reverts the call to the flow's default", async () => {
    flowRecord = makeFlow();
    const onSave = vi.fn();
    render(
      <FlowCallDialog
        step={makeCall({ flowArgs: { email: "pinned@example.com" } })}
        open
        onOpenChange={() => {}}
        onSave={onSave}
      />,
    );
    const input = (await screen.findByLabelText("Override for email")) as HTMLInputElement;
    expect(input.value).toBe("pinned@example.com");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({}));
  });

  it("drops a stale argument for a parameter the flow no longer declares", async () => {
    flowRecord = makeFlow(); // declares only `email`
    const onSave = vi.fn();
    render(
      <FlowCallDialog
        step={makeCall({ flowArgs: { email: "x@example.com", removed: "stale" } })}
        open
        onOpenChange={() => {}}
        onSave={onSave}
      />,
    );
    await screen.findByLabelText("Override for email");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ email: "x@example.com" }));
  });

  it("offers no text override for a secret parameter", async () => {
    flowRecord = makeFlow({
      flowParams: ["email", "password"],
      variables: [
        { name: "email", kind: "plain", value: "default@example.com" },
        { name: "password", kind: "secret" },
      ],
    });
    render(<FlowCallDialog step={makeCall()} open onOpenChange={() => {}} onSave={() => {}} />);
    await screen.findByLabelText("Override for email");
    expect(screen.queryByLabelText("Override for password")).toBeNull();
    expect(screen.getByText(/Resolved at run time/i)).toBeTruthy();
  });

  it("says when the flow can't be found instead of rendering it as parameterless", async () => {
    flowRecord = null;
    render(<FlowCallDialog step={makeCall()} open onOpenChange={() => {}} onSave={() => {}} />);
    expect(await screen.findByText(/can't be found/i)).toBeTruthy();
  });
});

describe("paramFields", () => {
  it("marks secret and captured parameters as non-overridable", () => {
    const fields = paramFields({
      flowParams: ["email", "password", "orderId"],
      variables: [
        { name: "email", kind: "plain", value: "a@b.com" },
        { name: "password", kind: "secret" },
        { name: "orderId", kind: "captured", value: "fallback" },
      ],
    });
    expect(fields).toEqual([
      { name: "email", defaultValue: "a@b.com" },
      { name: "password", defaultValue: null },
      { name: "orderId", defaultValue: null },
    ]);
  });

  it("treats an undeclared parameter as plain with an empty default", () => {
    // The backend auto-declares on setFlow, but records written before that —
    // or by MCP — can still carry a bare name.
    expect(paramFields({ flowParams: ["bare"], variables: [] })).toEqual([
      { name: "bare", defaultValue: "" },
    ]);
  });
});
