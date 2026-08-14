// The element-context picker: what it offers, in what order, and what it emits.
//
// Three properties, each of which is silent when wrong:
//
//  • WHEN IT OPENS. Expanded only when the recorder could not identify the
//    element on its own. Always-expanded invites pinning where the locator is
//    already unique — and because context is a real constraint at run time,
//    that costs stability and buys nothing. Never-expanded hides it from the
//    users who need it most.
//  • WHAT TICKING PRODUCES. A container is a choice (`within` is one field), an
//    attribute accumulates (`and` is a list). Getting that wrong silently drops
//    half of what the user asked for.
//  • THE NUMBERS. A count is a claim about the page. A confident wrong one is
//    trusted exactly as much as a confident right one, and "could not count"
//    must never render as "0 matches".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import {
  CONTEXT_AMBIGUOUS_HINT,
  CONTEXT_BRITTLE_NOTE,
  CONTEXT_HEADING,
  CONTEXT_NO_SIGNALS,
  CONTEXT_UNIQUE_HINT,
  ElementContextPicker,
} from "./element-context-picker";
import type { ContextSignal, LocatorContext, PickedElement } from "../lib/recorder-types";

// Mocked at the `api` module, not the IPC bridge — the test then states intent
// rather than channel plumbing.
vi.mock("../lib/api", () => ({
  api: { recorder: { countMatches: vi.fn(async () => 1) } },
}));
import { api } from "../lib/api";

const WITHIN: ContextSignal = {
  kind: "within",
  name: "within",
  value: "section",
  locator: { k: "testid", v: "billing-card" },
  ctx: { within: { k: "testid", v: "billing-card" } },
  count: 1,
  resolves: true,
};

const WITHIN_OTHER: ContextSignal = {
  kind: "within",
  name: "within",
  value: "main",
  locator: { k: "role", role: "main" },
  ctx: { within: { k: "role", role: "main" } },
  count: 2,
  resolves: false,
};

const ATTR: ContextSignal = {
  kind: "attr",
  name: "data-qa",
  value: "edit-billing",
  ctx: { and: [{ k: "css", v: '[data-qa="edit-billing"]' }] },
  count: 1,
  resolves: true,
};

const CLASS: ContextSignal = {
  kind: "class",
  name: "class",
  value: "btn",
  ctx: { and: [{ k: "css", v: ".btn" }] },
  count: 6,
  resolves: false,
};

function picked(over: Partial<PickedElement> = {}): PickedElement {
  return {
    tag: "button",
    description: "button.btn",
    candidates: [{ k: "role", role: "button", name: "Edit" }],
    css: {},
    attributes: {},
    ambiguous: true,
    contextBase: { k: "role", role: "button", name: "Edit" },
    contextBaseCount: 2,
    contextSignals: [WITHIN, ATTR, CLASS],
    ...over,
  };
}

/** The rows, in the order they render. */
function rows(): HTMLElement[] {
  return screen.queryAllByRole("checkbox");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("when the picker opens", () => {
  it("is expanded when no locator identifies the element", () => {
    render(<ElementContextPicker picked={picked({ ambiguous: true })} onChange={() => {}} />);
    expect(screen.getByText(CONTEXT_AMBIGUOUS_HINT)).toBeTruthy();
    expect(rows().length).toBeGreaterThan(0);
  });

  it("is collapsed when the element already has a locator of its own", () => {
    render(
      <ElementContextPicker
        picked={picked({ ambiguous: false, contextBaseCount: 1 })}
        onChange={() => {}}
      />,
    );
    // The heading is still there — the feature stays reachable — but nothing is
    // offered until it is asked for.
    expect(screen.getByText(new RegExp(CONTEXT_HEADING))).toBeTruthy();
    expect(rows()).toHaveLength(0);
  });

  it("can be opened by hand on an unambiguous element", () => {
    render(
      <ElementContextPicker
        picked={picked({ ambiguous: false, contextBaseCount: 1 })}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(new RegExp(CONTEXT_HEADING)));
    expect(screen.getByText(CONTEXT_UNIQUE_HINT)).toBeTruthy();
    expect(rows().length).toBeGreaterThan(0);
  });

  it("says so when the element has nothing to distinguish it", () => {
    // Not an empty list with no explanation: "there are no options" and "the
    // options failed to load" look identical in an empty box.
    render(
      <ElementContextPicker picked={picked({ contextSignals: [] })} onChange={() => {}} />,
    );
    expect(screen.getByText(CONTEXT_NO_SIGNALS)).toBeTruthy();
  });
});

describe("ordering", () => {
  it("offers the container first and the brittle class last", () => {
    render(<ElementContextPicker picked={picked()} onChange={() => {}} />);
    const text = rows().map((r) => r.textContent ?? "");
    expect(text[0]).toContain("section");
    expect(text[text.length - 1]).toContain("btn");
  });

  it("marks a class as brittle rather than hiding it", () => {
    // The user may know their app is stable here, and on some pages a semantic
    // class is the only thing that tells two rows apart. Hiding it would mean
    // silently withholding the only signal available.
    render(<ElementContextPicker picked={picked()} onChange={() => {}} />);
    expect(screen.getByText(CONTEXT_BRITTLE_NOTE)).toBeTruthy();
  });

  it("shows each row's price", () => {
    render(<ElementContextPicker picked={picked()} onChange={() => {}} />);
    const classRow = rows().find((r) => r.textContent?.includes("btn"));
    expect(classRow?.textContent).toContain("6");
  });
});

describe("what ticking produces", () => {
  it("a container becomes `within`", () => {
    const onChange = vi.fn();
    render(<ElementContextPicker picked={picked()} onChange={onChange} />);
    fireEvent.click(rows()[0]);
    expect(onChange).toHaveBeenLastCalledWith({ within: { k: "testid", v: "billing-card" } });
  });

  it("an attribute becomes an `and` predicate", () => {
    const onChange = vi.fn();
    render(<ElementContextPicker picked={picked()} onChange={onChange} />);
    const attrRow = rows().find((r) => r.textContent?.includes("edit-billing"));
    fireEvent.click(attrRow as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({ and: [{ k: "css", v: '[data-qa="edit-billing"]' }] });
  });

  it("attributes accumulate", () => {
    const onChange = vi.fn();
    render(<ElementContextPicker picked={picked()} onChange={onChange} />);
    fireEvent.click(rows().find((r) => r.textContent?.includes("edit-billing")) as HTMLElement);
    fireEvent.click(rows().find((r) => r.textContent?.includes("btn")) as HTMLElement);
    const calls = onChange.mock.calls;
    const last = calls[calls.length - 1]?.[0] as LocatorContext;
    expect(last.and).toHaveLength(2);
  });

  it("a second container REPLACES the first", () => {
    // `LocatorContext` holds one `within`. Letting two be ticked would show the
    // user two constraints and silently apply one.
    const onChange = vi.fn();
    render(
      <ElementContextPicker
        picked={picked({ contextSignals: [WITHIN, WITHIN_OTHER, ATTR] })}
        onChange={onChange}
      />,
    );
    fireEvent.click(rows().find((r) => r.textContent?.includes("section")) as HTMLElement);
    fireEvent.click(rows().find((r) => r.textContent?.includes("main")) as HTMLElement);

    const calls = onChange.mock.calls;
    const last = calls[calls.length - 1]?.[0] as LocatorContext;
    expect(last.within).toEqual({ k: "role", role: "main" });
    expect(
      rows().filter((r) => r.getAttribute("aria-checked") === "true"),
      "only one container is ticked",
    ).toHaveLength(1);
  });

  it("unticking everything reports null, not an empty context", () => {
    // Absent and empty must be the same value — an empty context constrains
    // nothing but still changes the heal key and the round trip.
    const onChange = vi.fn();
    render(<ElementContextPicker picked={picked()} onChange={onChange} />);
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[0]);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("a container and an attribute combine", () => {
    const onChange = vi.fn();
    render(<ElementContextPicker picked={picked()} onChange={onChange} />);
    fireEvent.click(rows().find((r) => r.textContent?.includes("section")) as HTMLElement);
    fireEvent.click(rows().find((r) => r.textContent?.includes("edit-billing")) as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({
      within: { k: "testid", v: "billing-card" },
      and: [{ k: "css", v: '[data-qa="edit-billing"]' }],
    });
  });
});

describe("the live readout", () => {
  it("asks the page for the count of the current selection", async () => {
    render(<ElementContextPicker picked={picked()} onChange={() => {}} />);
    fireEvent.click(rows()[0]);
    await waitFor(() =>
      expect(api.recorder.countMatches).toHaveBeenCalledWith({
        k: "role",
        role: "button",
        name: "Edit",
        ctx: { within: { k: "testid", v: "billing-card" } },
      }),
    );
    expect(await screen.findByText(/Matches 1 of 2 elements\./)).toBeTruthy();
  });

  it("reports a failure to count as a failure, never as zero", async () => {
    // The distinction that matters: "nothing on this page matches" would send
    // the user hunting for a mistake that is not there.
    vi.mocked(api.recorder.countMatches).mockResolvedValueOnce(-1);
    render(<ElementContextPicker picked={picked()} onChange={() => {}} />);
    fireEvent.click(rows()[0]);
    expect(await screen.findByText(/Could not count matches/)).toBeTruthy();
    expect(screen.queryByText(/Matches 0 of/)).toBeNull();
  });

  it("does not call the page when nothing is ticked", () => {
    // With no context the answer is already known — it is the base count the
    // pick reported. A round trip would be a spinner where a number belongs.
    render(<ElementContextPicker picked={picked()} onChange={() => {}} />);
    expect(api.recorder.countMatches).not.toHaveBeenCalled();
    expect(screen.getByText(/Matches 2 of 2 elements\./)).toBeTruthy();
  });
});
