// The composer refuses a target that matches several elements.
//
// Playwright runs in strict mode: a locator resolving to three elements is
// not the first of them, it is a failed step. The picker already asked the
// page how many elements the chosen context leaves and printed the number —
// and the Add button ignored it, so a locator the panel itself had priced at
// "3 matches" could be added and would fail on the next run, against a page
// the user was no longer looking at. That is how an assertion on a heading
// came to be recorded as getByText("Mountain") beside two links containing
// the word.
//
// The count is asked of the page for the locator the step will actually hold
// (whichever candidate is selected, context applied), not read off the
// picker's readout, which prices the semantic base. Four rules are pinned:
// more than one blocks, with the count; zero and "could not count" never do
// (the custom field exists for elements the page shows later, and a failure
// to ask is not a verdict); an indexed locator is not counted at all, because
// the index is the answer; and a step that COUNTS the matches is never
// blocked, because several matches is what it was written to read.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { PickedElement, RawStep } from "../lib/recorder-types";
import { api } from "../lib/api";
import { ambiguousTargetHint } from "./element-context-picker";
import { StepComposer } from "./step-composer";

vi.mock("../lib/api", () => ({
  api: {
    recorder: { countMatches: vi.fn(async () => 1) },
    tests: { listFlows: async () => [] },
  },
}));

const countMatches = () => vi.mocked(api.recorder.countMatches);

// The Unsplash shape: a heading whose text is a substring of two links' text,
// so the best candidate the recorder has is an ambiguous substring.
const PICKED: PickedElement = {
  tag: "h1",
  description: "h1",
  candidates: [
    { k: "text", v: "Mountain" },
    { k: "css", v: "main > h1" },
  ],
  css: {},
  attributes: {},
  ambiguous: true,
  contextBase: { k: "text", v: "Mountain" },
  contextBaseCount: 3,
  contextSignals: [],
};

function renderComposer() {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  render(
    <StepComposer
      kind="assertion"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={PICKED}
      onStartPick={() => {}}
      onClearPick={() => {}}
    />,
  );
  return { onAdd };
}

function addButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /add step/i }) as HTMLButtonElement;
}

/** Choose an assertion kind from the native-menu-backed Select — its options
 *  never enter the DOM, but the menu is opened through `glazeAPI.Menu.popup`,
 *  which is an ordinary promise a test can answer (see appearance-pane). */
function chooseAssertion(label: string): void {
  interface Item {
    label?: string;
    commandId?: number;
  }
  const popup = vi.fn(async ({ items }: { items: Item[] }) => {
    const hit = items.find((i) => i.label === label && i.commandId !== undefined);
    if (!hit) throw new Error(`no menu item labelled "${label}"`);
    return { commandId: hit.commandId };
  });
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
  fireEvent.click(screen.getByRole("combobox", { name: "Assertion" }));
}

beforeEach(() => {
  countMatches().mockReset();
  countMatches().mockResolvedValue(1);
});

describe("the composer's match-count gate", () => {
  it("refuses a locator that matches several elements, and says how many", async () => {
    countMatches().mockResolvedValue(3);
    const { onAdd } = renderComposer();
    await screen.findByText(ambiguousTargetHint(3));
    expect(addButton().disabled).toBe(true);
    // The locator the step would hold, not the picker's base.
    expect(countMatches()).toHaveBeenCalledWith({ k: "text", v: "Mountain" });
    fireEvent.click(addButton());
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("adds a locator that matches exactly one", async () => {
    const { onAdd } = renderComposer();
    await waitFor(() => expect(countMatches()).toHaveBeenCalled());
    await waitFor(() => expect(addButton().disabled).toBe(false));
    expect(screen.queryByText(/the run would refuse it/)).toBeNull();
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("does not block on zero — the custom field exists for elements the page shows later", async () => {
    countMatches().mockResolvedValue(0);
    renderComposer();
    await waitFor(() => expect(countMatches()).toHaveBeenCalled());
    await waitFor(() => expect(addButton().disabled).toBe(false));
    expect(screen.queryByText(/the run would refuse it/)).toBeNull();
  });

  it("does not block when the page could not be counted", async () => {
    countMatches().mockResolvedValue(-1);
    renderComposer();
    await waitFor(() => expect(countMatches()).toHaveBeenCalled());
    await waitFor(() => expect(addButton().disabled).toBe(false));
  });

  it("does not block when asking the page threw", async () => {
    countMatches().mockRejectedValue(new Error("recorder window is gone"));
    renderComposer();
    await waitFor(() => expect(countMatches()).toHaveBeenCalled());
    await waitFor(() => expect(addButton().disabled).toBe(false));
  });

  it("lifts the refusal once a position is chosen, without counting the indexed locator", async () => {
    countMatches().mockResolvedValue(3);
    renderComposer();
    await screen.findByText(ambiguousTargetHint(3));
    expect(addButton().disabled).toBe(true);
    countMatches().mockClear();
    fireEvent.click(screen.getByText("First"));
    await waitFor(() => expect(addButton().disabled).toBe(false));
    expect(screen.queryByText(/the run would refuse it/)).toBeNull();
    // `.nth(0)` is the fix for a three-way match; asking how many it matches
    // would answer 3 again and block the very step that resolves it.
    expect(countMatches()).not.toHaveBeenCalled();
  });

  it("re-counts when a different candidate is chosen", async () => {
    countMatches().mockImplementation(async (loc) => (loc.k === "css" ? 1 : 3));
    renderComposer();
    await screen.findByText(ambiguousTargetHint(3));
    fireEvent.click(screen.getByText(/main > h1/));
    await waitFor(() => expect(addButton().disabled).toBe(false));
    expect(countMatches()).toHaveBeenCalledWith({ k: "css", v: "main > h1" });
  });
});

// ── The steps the gate must NOT refuse ────────────────────────────────────
//
// `toHaveCount` and `locator.count()` do not strict-resolve, and a locator
// matching nine elements is the ANSWER for a step that counts them, not the
// strict-mode failure above. Gating those disables Add on exactly the locator
// the step was written for — which is what a `Match count` capture would have
// hit the day the composer started offering it a target picker.

describe("a step whose subject is the match count", () => {
  it("is added against a locator matching several elements", async () => {
    countMatches().mockResolvedValue(3);
    const { onAdd } = renderComposer();
    await screen.findByText(ambiguousTargetHint(3));
    expect(addButton().disabled).toBe(true);
    chooseAssertion("Has count");
    await waitFor(() => expect(addButton().disabled).toBe(false));
    expect(screen.queryByText(ambiguousTargetHint(3))).toBeNull();
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      { type: "assert", assert: "count", locator: { k: "text", v: "Mountain" }, count: 1 },
    ]);
  });
});

describe("a host without the count", () => {
  it("degrades to open when the bridge has no countMatches at all", async () => {
    // The trainer panel's tests mock `api.recorder` without it, and a real
    // host could too. A synchronous throw from the call must land in the
    // same place a rejection does — not in the render.
    (api.recorder as unknown as Record<string, unknown>).countMatches = undefined;
    try {
      const { onAdd } = renderComposer();
      await waitFor(() => expect(addButton().disabled).toBe(false));
      fireEvent.click(addButton());
      expect(onAdd).toHaveBeenCalledTimes(1);
    } finally {
      (api.recorder as unknown as Record<string, unknown>).countMatches = countMatches();
    }
  });
});
