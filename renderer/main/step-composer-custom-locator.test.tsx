// The composer's target picker with a hand-typed locator — the second of the
// two surfaces the custom field lives on (the Refine dialog is the first).
//
// Two things are pinned beyond the field's own tests. The no-picked branch
// offers the field at all — it is the only route to an element the crosshair
// can't reach (hidden until hover, inside a region pick mode disturbs). And
// context now rides across candidate switches: emission goes through one
// `emit(base, ctx)` for every path, where the old inline composition dropped
// a configured context the moment a different candidate was clicked.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { ContextSignal, PickedElement, RawStep } from "../lib/recorder-types";
import { StepComposer } from "./step-composer";

vi.mock("../lib/api", () => ({
  api: {
    recorder: { countMatches: vi.fn(async () => 1) },
    tests: { listFlows: async () => [] },
  },
}));

const WITHIN: ContextSignal = {
  kind: "within",
  name: "within",
  value: "section",
  locator: { k: "testid", v: "billing-card" },
  ctx: { within: { k: "testid", v: "billing-card" } },
  count: 1,
  resolves: true,
};

function picked(over: Partial<PickedElement> = {}): PickedElement {
  return {
    tag: "button",
    description: "button.btn",
    candidates: [
      { k: "role", role: "button", name: "Edit" },
      { k: "css", v: "#edit" },
    ],
    css: {},
    attributes: {},
    ambiguous: false,
    contextBase: { k: "role", role: "button", name: "Edit" },
    contextBaseCount: 1,
    contextSignals: [WITHIN],
    ...over,
  };
}

function renderComposer(pickedEl: PickedElement | null) {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="assertion"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={pickedEl}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /add step/i }));
}

describe("without a picked element", () => {
  it("offers the custom field as the standing alternative to the crosshair", async () => {
    const { onAdd } = renderComposer(null);
    expect(screen.getByText(/or write a locator by hand/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Custom locator"), {
      target: { value: "button.add-to-cart" },
    });
    await waitFor(() => {
      const add = screen.getByRole("button", { name: /add step/i }) as HTMLButtonElement;
      expect(add.disabled).toBe(false);
    });
    submit();
    const step = (onAdd.mock.calls[0][0] as RawStep[])[0];
    expect(step.type).toBe("assert");
    expect(step.locator).toEqual({ k: "css", v: "button.add-to-cart" });
  });
});

describe("with a picked element", () => {
  it("offers Custom as the last row and submits the typed locator", async () => {
    const { onAdd } = renderComposer(picked());
    fireEvent.click(screen.getByText(/write a css selector or xpath by hand/i));
    fireEvent.change(screen.getByLabelText("Custom locator"), {
      target: { value: "xpath=//button[not(starts-with(text(),'Submit'))]" },
    });
    await waitFor(() => {
      const add = screen.getByRole("button", { name: /add step/i }) as HTMLButtonElement;
      expect(add.disabled).toBe(false);
    });
    submit();
    const step = (onAdd.mock.calls[0][0] as RawStep[])[0];
    expect(step.locator).toEqual({
      k: "xpath",
      v: "//button[not(starts-with(text(),'Submit'))]",
    });
  });

  it("keeps a configured context when the candidate changes", async () => {
    // The old inline composition emitted the bare candidate on switch, so a
    // pinned "inside billing-card" silently fell off until the context was
    // next touched — the step then matched everywhere. `ambiguous` so the
    // context picker opens expanded and its rows are reachable.
    const { onAdd } = renderComposer(picked({ ambiguous: true, contextBaseCount: 2 }));
    const withinRow = await screen.findAllByRole("checkbox");
    fireEvent.click(withinRow[0]);
    // Switch to the second candidate AFTER configuring context.
    fireEvent.click(screen.getByText('locator("#edit")'));
    submit();
    const step = (onAdd.mock.calls[0][0] as RawStep[])[0];
    expect(step.locator).toEqual({
      k: "css",
      v: "#edit",
      ctx: { within: { k: "testid", v: "billing-card" } },
    });
  });
});

describe("position among matches", () => {
  it("rides the submitted locator, composed after context", async () => {
    const { onAdd } = renderComposer(picked({ ambiguous: true, contextBaseCount: 2 }));
    const rows = await screen.findAllByRole("checkbox");
    fireEvent.click(rows[0]);
    fireEvent.click(screen.getByRole("radio", { name: "Last" }));
    submit();
    const s = (onAdd.mock.calls[0][0] as RawStep[])[0];
    expect(s.locator).toEqual({
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", v: "billing-card" } },
      nth: -1,
    });
  });

  it("composes with a custom locator too", async () => {
    const { onAdd } = renderComposer(picked());
    fireEvent.click(screen.getByText(/write a css selector or xpath by hand/i));
    fireEvent.change(screen.getByLabelText("Custom locator"), {
      target: { value: "table tr" },
    });
    await waitFor(() => {
      const add = screen.getByRole("button", { name: /add step/i }) as HTMLButtonElement;
      expect(add.disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("radio", { name: "First" }));
    submit();
    const s = (onAdd.mock.calls[0][0] as RawStep[])[0];
    expect(s.locator).toEqual({ k: "css", v: "table tr", nth: 0 });
  });
});
