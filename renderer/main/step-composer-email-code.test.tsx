// The composer's emailCode kind — the step that reads the one-time code a
// store emails, because Shopify's customer accounts have no password.
//
// The property worth pinning is the api kind's: a malformed piece refuses the
// WHOLE submit rather than silently falling back to a default. A step that
// quietly lost its digit count polls for six digits against a four-digit code
// and fails sixty seconds later as "nothing arrived", which points at the
// mailbox rather than at the form that was wrong.

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

function renderEmailCode() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="emailCode"
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

describe("the emailCode kind", () => {
  it("builds the step from the address and the destination variable", () => {
    const { onAdd } = renderEmailCode();
    type(/mailbox address/i, "shopper@mail.example.com");
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      {
        type: "emailCode",
        mailboxAddress: "shopper@mail.example.com",
        captureVar: "loginCode",
      },
    ]);
  });

  it("omits the digit count when it is the default", () => {
    // Absent means six. Emitting `codeDigits: 6` on every step would put a
    // field in the record that means nothing and has to be kept in step with
    // the default forever.
    const { onAdd } = renderEmailCode();
    type(/mailbox address/i, "shopper@mail.example.com");
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0][0]).not.toHaveProperty("codeDigits");
  });

  it("carries a non-default digit count and a label", () => {
    const { onAdd } = renderEmailCode();
    type(/mailbox address/i, "shopper@mail.example.com");
    type(/store the code in/i, "otp");
    type(/code length/i, "4");
    type(/code follows this text/i, "your code is");
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      {
        type: "emailCode",
        mailboxAddress: "shopper@mail.example.com",
        captureVar: "otp",
        codeDigits: 4,
        codeLabel: "your code is",
      },
    ]);
  });

  it("accepts a ${variable} address, which is the ordinary case", () => {
    // The address is normally the same reference the login form was filled
    // with — one spelling of the customer's email.
    const { onAdd } = renderEmailCode();
    type(/mailbox address/i, "${shopperEmail}");
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0][0].mailboxAddress).toBe("${shopperEmail}");
  });

  it("refuses the submit with no address", () => {
    const { onAdd } = renderEmailCode();
    fireEvent.click(addButton());
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("refuses the submit with no destination variable", () => {
    // A code read into nowhere is not a step: the generator emits nothing for
    // it, so accepting it here would add a row that silently does not run.
    const { onAdd } = renderEmailCode();
    type(/mailbox address/i, "shopper@mail.example.com");
    type(/store the code in/i, "");
    fireEvent.click(addButton());
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("refuses a variable name that is not an identifier", () => {
    const { onAdd } = renderEmailCode();
    type(/mailbox address/i, "shopper@mail.example.com");
    type(/store the code in/i, "login code");
    fireEvent.click(addButton());
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range digit count rather than defaulting", () => {
    const { onAdd } = renderEmailCode();
    type(/mailbox address/i, "shopper@mail.example.com");
    type(/code length/i, "0");
    fireEvent.click(addButton());
    expect(onAdd).not.toHaveBeenCalled();
    type(/code length/i, "not a number");
    fireEvent.click(addButton());
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("says the code has to arrive after the run starts", () => {
    // The one rule a user cannot infer from the form, and the one that
    // explains why a code sitting in the inbox is ignored.
    renderEmailCode();
    expect(screen.getByText(/after this run starts/i)).toBeTruthy();
  });
});
