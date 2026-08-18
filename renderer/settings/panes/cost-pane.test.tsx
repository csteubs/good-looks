// Tests for the Cost pane.
//
// The pane's whole reason to exist is that the Stats → Cost panel used to
// multiply by two numbers nobody had ever corrected. So the behaviour worth
// pinning is not "a control renders" — it is the three ways this pane can lie:
//
//   • the runner dropdown showing hardware the price does not correspond to,
//     which is possible the moment the runner is stored rather than derived;
//   • a price of 0.008 or 0 being silently replaced, because every other
//     clamp in this window rounds to an integer and treats 0 as absent;
//   • the currency symbol on the price field disagreeing with the one the
//     panel stamps on the figures.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { CostPane } from "./cost-pane";

/**
 * Pick an option from a native-menu-backed `Select`.
 *
 * Copied from `appearance-pane.test.tsx` rather than shared, which is what that
 * file does too: the SDK's `Select` renders its options to nothing and hands a
 * plain-data template to `Menu.popup`, so no Testing Library query can reach
 * them. Stubbing `popup` to resolve with the `commandId` of a label runs the
 * same handler a real click would.
 */
function chooseFromNativeMenu(triggerId: string, label: string): void {
  interface Item {
    label?: string;
    commandId?: number;
    submenu?: Item[];
  }
  const popup = vi.fn(async ({ items }: { items: Item[] }) => {
    const flat: Item[] = [];
    const walk = (list: Item[]): void => {
      for (const i of list) {
        flat.push(i);
        if (i.submenu) walk(i.submenu);
      }
    };
    walk(items);
    const hit = flat.find((i) => i.label === label && i.commandId !== undefined);
    if (!hit) {
      throw new Error(
        `no menu item labelled "${label}" (saw: ${flat.map((i) => i.label).join(", ")})`,
      );
    }
    return { commandId: hit.commandId };
  });
  (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
  fireEvent.click(document.getElementById(triggerId) as HTMLElement);
}

/** The price field, which every test here reads or writes. */
const priceField = () => screen.getByLabelText(/price per ci minute/i) as HTMLInputElement;

describe("the runner preset", () => {
  it("writes the published rate for the runner you pick", async () => {
    const { controller } = renderPane(<CostPane />);
    chooseFromNativeMenu("cost-ci-runner", "macOS 3-core or 4-core (M1 / Intel) — $0.062");
    await waitFor(() => expect(savedPatch(controller)).toEqual({ costPerCiMinute: 0.062 }));
  });

  it("reports the shipped guess as Custom, because it matches no runner", () => {
    // 0.008 is deliberately none of GitHub's published rates — the app is not
    // claiming to know which hardware you use until you say so.
    renderPane(<CostPane />);
    expect(screen.getByLabelText(/ci runner/i).textContent).toContain("Custom");
  });

  it("names the runner the stored price belongs to", () => {
    // DERIVED, not stored. The failure this prevents is a pane reading "Linux
    // 2-core" over a price that is nothing of the sort, because one of the two
    // was written and the other was not.
    const controller = makeController();
    controller.settings.costPerCiMinute = 0.006;
    renderPane(<CostPane />, { controller });
    expect(screen.getByLabelText(/ci runner/i).textContent).toContain("Linux 2-core (x64)");
  });

  it("goes back to Custom when the price is typed by hand", () => {
    const controller = makeController();
    controller.settings.costPerCiMinute = 0.0071;
    renderPane(<CostPane />, { controller });
    expect(screen.getByLabelText(/ci runner/i).textContent).toContain("Custom");
  });

  it("writes nothing when Custom itself is chosen", async () => {
    // Custom is a derived READING, not a choice. Treating it as one would
    // discard the price the user typed the moment they reopened the menu.
    const { controller } = renderPane(<CostPane />);
    chooseFromNativeMenu("cost-ci-runner", "Custom");
    await waitFor(() => expect(screen.getByLabelText(/ci runner/i)).toBeTruthy());
    expect(controller.save).not.toHaveBeenCalled();
  });

  it("puts the price in the menu, so the dropdown IS the price list", () => {
    // A menu of bare hardware names makes the user look up the rates
    // elsewhere, which is the job this control was added to remove.
    const popup = vi.fn(async (_template: unknown) => ({ commandId: undefined }));
    (window as unknown as { glazeAPI: { Menu: unknown } }).glazeAPI = { Menu: { popup } };
    renderPane(<CostPane />);
    fireEvent.click(document.getElementById("cost-ci-runner") as HTMLElement);
    const labels = JSON.stringify(popup.mock.calls[0]?.[0] ?? {});
    expect(labels).toContain("0.062");
    expect(labels).toContain("0.002");
  });
});

describe("the price", () => {
  it("keeps a fractional price instead of rounding it to zero", async () => {
    // Every other clamp in this window rounds to an integer, because those
    // values reach the Playwright CLI. This one is money: 0.008 rounded is free.
    // Not 0.008 — the field already holds it, and React fires no change event
    // for a value that did not change, so the test would pass on nothing.
    const { controller } = renderPane(<CostPane />);
    fireEvent.change(priceField(), { target: { value: "0.0125" } });
    await waitFor(() => expect(savedPatch(controller)).toEqual({ costPerCiMinute: 0.0125 }));
  });

  it("keeps a price of zero, because a self-hosted runner is free", async () => {
    // The `Number(raw) || fallback` idiom the other clamps use treats 0 as a
    // half-typed number and would replace it with the app's own guess.
    const { controller } = renderPane(<CostPane />);
    fireEvent.change(priceField(), { target: { value: "0" } });
    await waitFor(() => expect(savedPatch(controller)).toEqual({ costPerCiMinute: 0 }));
  });

  it("clamps a price that would dwarf every figure on the panel", async () => {
    const { controller } = renderPane(<CostPane />);
    fireEvent.change(priceField(), { target: { value: "999999" } });
    await waitFor(() => expect(savedPatch(controller)).toEqual({ costPerCiMinute: 100 }));
  });

  it("falls back rather than persisting a NaN when the field is cleared", async () => {
    // A NaN reaching the panel renders as a confident "$NaN".
    const { controller } = renderPane(<CostPane />);
    fireEvent.change(priceField(), { target: { value: "" } });
    await waitFor(() => expect(savedPatch(controller)).toEqual({ costPerCiMinute: 0.008 }));
  });
});

describe("minutes per manual run", () => {
  it("saves what you type", async () => {
    const { controller } = renderPane(<CostPane />);
    fireEvent.change(screen.getByLabelText(/minutes to run one test by hand/i), {
      target: { value: "25" },
    });
    await waitFor(() => expect(savedPatch(controller)).toEqual({ costMinutesPerManualRun: 25 }));
  });

  it("refuses zero, which would claim the suite bought nothing", async () => {
    const { controller } = renderPane(<CostPane />);
    fireEvent.change(screen.getByLabelText(/minutes to run one test by hand/i), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(savedPatch(controller)).toEqual({ costMinutesPerManualRun: 0.5 }),
    );
  });
});

describe("currency", () => {
  it("saves the picked currency", async () => {
    const { controller } = renderPane(<CostPane />);
    chooseFromNativeMenu("cost-currency", "Pound sterling (£)");
    await waitFor(() => expect(savedPatch(controller)).toEqual({ costCurrency: "gbp" }));
  });

  it("shows the chosen symbol on both money fields", () => {
    // The pane and the panel must agree about what the number is denominated
    // in — a price field reading "$" beside figures reading "£" is worse than
    // neither carrying a symbol at all.
    //
    // BOTH fields, and that is the assertion rather than an accident of the
    // query: the CI price and the hourly rate are the two money inputs on this
    // pane, and one of them silently keeping a stale symbol is exactly the
    // half-applied change this test exists to catch.
    const controller = makeController();
    controller.settings.costCurrency = "eur";
    renderPane(<CostPane />, { controller });
    expect(screen.getAllByText("€")).toHaveLength(2);
  });

  it("shows no symbol under `No symbol`", () => {
    const controller = makeController();
    controller.settings.costCurrency = "none";
    const { container } = renderPane(<CostPane />, { controller });
    expect(container.querySelector('[data-slot="number-input-unit"]')?.textContent).not.toBe("$");
  });

  it("keeps the three dollar currencies apart", () => {
    const controller = makeController();
    controller.settings.costCurrency = "cad";
    renderPane(<CostPane />, { controller });
    expect(screen.getAllByText("CA$")).toHaveLength(2);
  });
});

describe("search filtering", () => {
  it("hides an unmatched row", () => {
    renderPane(<CostPane />, { matchedIds: ["cost-per-ci-minute"] });
    expect(priceField()).toBeTruthy();
    expect(screen.queryByLabelText(/minutes to run one test by hand/i)).toBeNull();
  });
});
