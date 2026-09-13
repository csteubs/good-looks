// The composer's CAPTURE kind, and the target it reads from.
//
// A capture is "store this page value in a variable", and four of its six
// sources — element text, input value, an attribute, a match count — are about
// an ELEMENT. The panel never asked which one. It rendered the variable name,
// the source dropdown and, for `attribute`, the attribute name; there was no
// target picker for any source, so `locator` stayed null, `build()` refused the
// step (correctly — an element capture with no target reads nothing), and the
// Add button sat disabled with nothing on screen left to fill in. Four of the
// six sources were unreachable, and the panel gave no hint why.
//
// So the picker is the subject here, on both sides: offered for the element
// sources, absent for the two that read the page itself, and the emitted step
// carrying the locator in the first case and none in the second.
//
// The Select is native-menu-backed, so its options never enter the DOM (see
// CLAUDE.md). `chooseSource` drives it the one way that works — answer
// `glazeAPI.Menu.popup` with the commandId of the wanted label, which runs the
// same handler a real click would.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { PickedElement, RawStep } from "../lib/recorder-types";
import { api } from "../lib/api";
import { CAPTURE_OPTIONS, isPageLevelCapture, StepComposer } from "./step-composer";

vi.mock("../lib/api", () => ({
  api: {
    recorder: { countMatches: vi.fn(async () => 1) },
    tests: { listFlows: async () => [] },
  },
}));

const countMatches = () => vi.mocked(api.recorder.countMatches);

const PICKED: PickedElement = {
  tag: "span",
  description: "span#order-id",
  candidates: [
    { k: "css", v: "#order-id" },
    { k: "text", v: "A-1002" },
  ],
  css: {},
  attributes: {},
  ambiguous: false,
  contextBaseCount: 1,
  contextSignals: [],
};

function renderCapture(opts: { picked?: PickedElement | null } = {}) {
  const onAdd = vi.fn((_steps: RawStep[]) => {});
  const onStartPick = vi.fn();
  render(
    <StepComposer
      kind="capture"
      onCancel={() => {}}
      onAdd={onAdd}
      picked={opts.picked === undefined ? PICKED : opts.picked}
      onStartPick={onStartPick}
      onClearPick={() => {}}
    />,
  );
  return { onAdd, onStartPick };
}

/** Pick a capture source from the native-menu-backed Select. */
function chooseSource(label: string): void {
  interface Item {
    label?: string;
    commandId?: number;
  }
  const popup = vi.fn(async ({ items }: { items: Item[] }) => {
    const hit = items.find((i) => i.label === label && i.commandId !== undefined);
    if (!hit) throw new Error(`no menu item labelled "${label}" (saw: ${items.map((i) => i.label).join(", ")})`);
    return { commandId: hit.commandId };
  });
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
  fireEvent.click(screen.getByRole("combobox", { name: "Capture from" }));
}

function nameIt(v: string): void {
  fireEvent.change(screen.getByLabelText("Store as variable"), { target: { value: v } });
}

function addButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /add step/i }) as HTMLButtonElement;
}

beforeEach(() => {
  countMatches().mockReset();
  countMatches().mockResolvedValue(1);
});

describe("an element-scoped capture", () => {
  it("offers the target picker and carries the chosen locator", async () => {
    const { onAdd } = renderCapture();
    expect(screen.getByText("Target element")).toBeTruthy();
    nameIt("orderId");
    await waitFor(() => expect(addButton().disabled).toBe(false));
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      {
        type: "capture",
        captureVar: "orderId",
        captureFrom: "text",
        locator: { k: "css", v: "#order-id" },
      },
    ]);
  });

  it("offers the crosshair when nothing is picked yet, instead of a dead button", () => {
    const { onStartPick } = renderCapture({ picked: null });
    nameIt("orderId");
    // The step cannot build with no target — that part was always right. What
    // was missing is the way to supply one.
    expect(addButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /pick element in browser/i }));
    expect(onStartPick).toHaveBeenCalled();
  });

  it("keeps the attribute name beside the target for an attribute capture", async () => {
    const { onAdd } = renderCapture();
    chooseSource("Element attribute");
    await screen.findByLabelText("Attribute");
    expect(screen.getByText("Target element")).toBeTruthy();
    nameIt("href");
    fireEvent.change(screen.getByLabelText("Attribute"), { target: { value: "data-id" } });
    await waitFor(() => expect(addButton().disabled).toBe(false));
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      {
        type: "capture",
        captureVar: "href",
        captureFrom: "attribute",
        captureAttr: "data-id",
        locator: { k: "css", v: "#order-id" },
      },
    ]);
  });
});

describe("a page-level capture", () => {
  it("hides the target picker and emits no locator", async () => {
    const { onAdd } = renderCapture();
    chooseSource("Page URL");
    await waitFor(() => expect(screen.queryByText("Target element")).toBeNull());
    nameIt("landing");
    await waitFor(() => expect(addButton().disabled).toBe(false));
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      { type: "capture", captureVar: "landing", captureFrom: "url" },
    ]);
  });

  it("agrees with the option list about which sources read the page", () => {
    for (const o of CAPTURE_OPTIONS) {
      expect(isPageLevelCapture(o.value)).toBe(o.page === true);
    }
  });
});

// Counting is the one element source where several matches is the ANSWER:
// `locator.count()` does not strict-resolve, and capturing the size of a list
// is what the source exists for (main/services/count-capture.test.ts). The
// composer's match-count gate refuses an ambiguous locator for every other
// step, and refusing it here would disable Add on exactly the locator the step
// was written for.
describe("a count capture", () => {
  it("is not refused by the match-count gate", async () => {
    countMatches().mockResolvedValue(9);
    const { onAdd } = renderCapture();
    chooseSource("Match count");
    nameIt("results");
    await waitFor(() => expect(addButton().disabled).toBe(false));
    fireEvent.click(addButton());
    expect(onAdd.mock.calls[0][0]).toEqual([
      {
        type: "capture",
        captureVar: "results",
        captureFrom: "count",
        locator: { k: "css", v: "#order-id" },
      },
    ]);
  });

  it("still refuses an ambiguous locator for a capture that reads one element", async () => {
    countMatches().mockResolvedValue(9);
    renderCapture();
    nameIt("orderId");
    await waitFor(() => expect(addButton().disabled).toBe(true));
  });
});
