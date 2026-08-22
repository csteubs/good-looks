// The generate-steps dialog's VERIFY half: what it hands the backend, what it
// renders of the outcome, and when it stays open.
//
// The model is mocked at the hook (`useLlmChat` reports a finished answer) and
// the backend at the prop (`onVerify` resolves with a stated outcome) — the
// `api` module is mocked only for the config poll the dialog makes on open.
// The real backend half, a step actually tried against a live page, is
// e2e/verified-steps.spec.ts; nothing in jsdom can host it.
//
// VERIFIED TO FAIL: render the log only when every step ran, and "stays open
// and names the failure" fails; close the dialog on any outcome, and the same
// test reports `onOpenChange(false)`.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import type { RawStep, VerifiedStepsResult } from "../lib/recorder-types";
import { ACTIVITY_LABEL, GenerateStepsDialog } from "./generate-steps-dialog";

vi.mock("../lib/api", () => ({
  api: { llm: { getConfig: async () => ({ model: "llama" }) } },
}));

// The dialog reads the recorder only for the optional selector pick, which no
// test here exercises.
vi.mock("./recorder-store", () => ({
  useRecorder: () => ({
    picked: null,
    clearPicked: () => {},
    startRefine: () => {},
    endRefine: () => {},
  }),
}));

// A finished generation: three steps, the first a goto the dialog drops.
const ANSWER = JSON.stringify([
  { type: "goto", url: "https://example.test/" },
  { type: "click", locator: { k: "role", role: "button", name: "Sign in" } },
  { type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.test" },
  { type: "assert", assert: "visible", locator: { k: "text", v: "Welcome" } },
]);

vi.mock("../lib/use-llm-chat", () => ({
  useLlmChat: () => ({
    content: ANSWER,
    status: "done",
    error: null,
    errorKind: null,
    start: () => {},
    stop: () => {},
  }),
}));

function renderDialog(outcome: VerifiedStepsResult) {
  const onVerify = vi.fn(async (_steps: RawStep[], _label: string) => outcome);
  const onOpenChange = vi.fn();
  render(
    <GenerateStepsDialog
      open
      url="https://example.test/"
      onOpenChange={onOpenChange}
      onVerify={onVerify}
    />,
  );
  return { onVerify, onOpenChange };
}

async function typePromptAndTry(prompt: string) {
  fireEvent.change(screen.getByPlaceholderText(/fill the email field/i), { target: { value: prompt } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /try 3 steps/i }));
  });
}

function activity(): HTMLElement {
  return screen.getByTestId("ai-activity");
}

describe("what the dialog hands the backend", () => {
  it("sends the steps after the goto, with the prompt as the group label", async () => {
    const { onVerify } = renderDialog({ inserted: 3, results: [] });
    await typePromptAndTry("  sign in and land on the welcome page  ");

    expect(onVerify).toHaveBeenCalledTimes(1);
    const [steps, label] = onVerify.mock.calls[0];
    expect(steps.map((s) => s.type)).toEqual(["click", "fill", "assert"]);
    expect(label).toBe("sign in and land on the welcome page");
  });
});

describe("when everything works", () => {
  it("closes, having added them", async () => {
    const { onOpenChange } = renderDialog({
      inserted: 3,
      results: [
        { label: "click Sign in", status: "ran" },
        { label: "fill Email", status: "ran" },
        { label: "assert Welcome visible", status: "ran" },
      ],
    });
    await typePromptAndTry("sign in");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("when a step fails", () => {
  const OUTCOME: VerifiedStepsResult = {
    inserted: 1,
    results: [
      { label: "click Sign in", status: "ran" },
      { label: "fill Email", status: "failed", detail: "no element matches getByLabel(\"Email\")" },
    ],
  };

  it("stays open and names the failure, in order, with why", async () => {
    const { onOpenChange } = renderDialog(OUTCOME);
    await typePromptAndTry("sign in");

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    const log = activity();
    const rows = log.querySelectorAll("[data-status]");
    expect([...rows].map((r) => r.getAttribute("data-status"))).toEqual(["ran", "failed"]);
    expect(within(log).getByText("click Sign in")).toBeTruthy();
    expect(within(log).getByText("fill Email")).toBeTruthy();
    expect(within(log).getByText(/no element matches/)).toBeTruthy();
  });

  it("says the steps that worked were kept, and how many were never attempted", async () => {
    renderDialog(OUTCOME);
    await typePromptAndTry("sign in");
    const text = activity().textContent ?? "";
    expect(text).toMatch(/1 step that worked was kept/);
    // Three proposed, two attempted: the assertion was never tried.
    expect(text).toMatch(/1 step was not attempted/);
  });

  it("does not offer to try the same list again", async () => {
    renderDialog(OUTCOME);
    await typePromptAndTry("sign in");
    const tried = screen.getByRole("button", { name: /^tried$/i }) as HTMLButtonElement;
    expect(tried.disabled).toBe(true);
  });

  it("says nothing was added when the first step is the one that failed", async () => {
    renderDialog({
      inserted: 0,
      results: [{ label: "click Sign in", status: "failed", detail: "timed out" }],
    });
    await typePromptAndTry("sign in");
    expect(activity().textContent).toMatch(/Nothing was added/);
    expect(activity().textContent).toMatch(/2 steps were not attempted/);
  });
});

describe("an unchecked step is not called verified", () => {
  it("labels it as unchecked, distinct from ran", async () => {
    renderDialog({
      inserted: 3,
      results: [
        { label: "click Sign in", status: "ran" },
        { label: "wait 1s", status: "unchecked", detail: "the replayer does not run waits" },
        { label: "assert Welcome visible", status: "ran" },
      ],
    });
    await typePromptAndTry("sign in");
    // Closed on success — but the labels are the contract, so pin the copy.
    expect(ACTIVITY_LABEL.unchecked).toBe("unchecked");
    expect(ACTIVITY_LABEL.ran).not.toBe(ACTIVITY_LABEL.unchecked);
  });
});
