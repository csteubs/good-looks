// Tests for the flow-argument form and its one load-bearing rule: a BLANK
// field means "argument not supplied", so its key must be ABSENT from the
// stored flowArgs — the generator treats any supplied string (including "")
// as the caller's answer, and only an absent key falls back to the flow's
// default. `collectFlowArgs` owns that rule for both the composer and the
// step row's dialog; the generator side of the same contract is pinned in
// main/services/flow-binding.test.ts.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Step } from "../lib/recorder-types";
import type { FlowInfo } from "../lib/api";
import { collectFlowArgs, FlowArgsDialog } from "./flow-args-fields";

let flowList: FlowInfo[] = [];

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      listFlows: async () => flowList,
    },
  },
}));

describe("collectFlowArgs", () => {
  it("keeps only filled-in values for declared parameters", () => {
    expect(
      collectFlowArgs(["email", "password"], { email: "a@b.com", password: "" }),
    ).toEqual({ email: "a@b.com" });
  });

  it("drops values for parameters the flow does not declare", () => {
    // Stale args survive on a step after the flow's parameter list changes;
    // saving through this rule prunes them instead of carrying them forever.
    expect(collectFlowArgs(["email"], { email: "x", ghost: "y" })).toEqual({ email: "x" });
  });

  it("returns an empty object when everything is blank", () => {
    expect(collectFlowArgs(["a", "b"], { a: "", b: "" })).toEqual({});
  });
});

function makeStep(partial: Partial<Step> = {}): Step {
  return {
    id: "s1",
    timestamp: 0,
    type: "runFlow",
    flowId: "f1",
    label: "Login",
    ...partial,
  } as Step;
}

function renderDialog(step: Step, onSave = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <FlowArgsDialog step={step} open onOpenChange={() => {}} onSave={onSave} />
    </QueryClientProvider>,
  );
  return { onSave };
}

describe("FlowArgsDialog", () => {
  it("renders one field per declared parameter, prefilled from the step", async () => {
    flowList = [
      {
        id: "f1",
        name: "Login",
        flowParams: ["email", "password"],
        paramDefaults: { email: "default@x.com", password: "" },
      },
    ];
    renderDialog(makeStep({ flowArgs: { email: "caller@x.com" } }));
    const email = await screen.findByLabelText("Flow argument email");
    expect((email as HTMLInputElement).value).toBe("caller@x.com");
    // The default is placeholder text — visible as the fallback, never data.
    expect((email as HTMLInputElement).placeholder).toBe("Default: default@x.com");
    const password = screen.getByLabelText("Flow argument password");
    expect((password as HTMLInputElement).value).toBe("");
    expect((password as HTMLInputElement).placeholder).toBe("Uses the flow's default");
  });

  it("saves only filled fields and prunes parameters the flow dropped", async () => {
    flowList = [
      { id: "f1", name: "Login", flowParams: ["email"], paramDefaults: { email: "" } },
    ];
    // The step still carries an argument for `ghost`, a parameter the flow no
    // longer declares. Saving must not keep it.
    const { onSave } = renderDialog(makeStep({ flowArgs: { email: "old@x.com", ghost: "y" } }));
    const email = await screen.findByLabelText("Flow argument email");
    fireEvent.change(email, { target: { value: "new@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith({ email: "new@x.com" });
  });

  it("clearing a field back to blank omits its key on save", async () => {
    flowList = [
      { id: "f1", name: "Login", flowParams: ["email"], paramDefaults: { email: "d@x.com" } },
    ];
    const { onSave } = renderDialog(makeStep({ flowArgs: { email: "caller@x.com" } }));
    const email = await screen.findByLabelText("Flow argument email");
    fireEvent.change(email, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    // {} rather than { email: "" }: the empty string would OVERRIDE the
    // default at generation time instead of falling back to it.
    expect(onSave).toHaveBeenCalledWith({});
  });

  it("says so and disables saving when the flow no longer exists", async () => {
    flowList = [];
    const { onSave } = renderDialog(makeStep());
    await waitFor(() =>
      expect(screen.getByText(/no longer available/i)).toBeTruthy(),
    );
    const save = screen.getByRole("button", { name: /save/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });
});
