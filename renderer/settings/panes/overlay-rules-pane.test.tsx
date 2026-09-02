// Tests for the Overlay rules pane.
//
// The properties pinned here are the store's rules as the pane exposes them,
// plus the one that is easy to lose in a refactor: the pane must SHOW WHAT A
// RULE CLICKS. A rule acts on a live page with no step in any test to point at,
// so a row that shows only a label leaves the user unable to judge which rule
// is responsible when a run behaves oddly — and "delete them and re-teach" is
// the only debugging move left.
//
// The target is deliberately not editable. A locator comes from the trainer's
// picker, where it was priced against a real page; a text field here is how a
// rule acquires a selector nobody ever saw match.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { OverlayRulesPane, describeTarget } from "./overlay-rules-pane";
import type { OverlayRule } from "../../lib/recorder-types";
import { POPUP_PRESETS } from "../../../shared/popup-presets.mjs";

const { rulesApi, onApi } = vi.hoisted(() => ({
  rulesApi: {
    list: vi.fn(async () => [] as OverlayRule[]),
    create: vi.fn(async () => ({}) as OverlayRule),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    remove: vi.fn(async () => true),
  },
  onApi: vi.fn(() => () => {}),
}));
vi.mock("../../lib/api", () => ({ api: { overlayRules: rulesApi, on: onApi } }));

const rule = (over: Partial<OverlayRule> = {}): OverlayRule => ({
  id: "r1",
  host: "ritual.com",
  label: "Close",
  target: { k: "testid", v: "dg-header-close" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function withRules(rules: OverlayRule[]) {
  rulesApi.list.mockResolvedValue(rules);
}

describe("describeTarget", () => {
  // Its own unit, because the pane renders it twice and the trainer's step list
  // says the same words about the same locator. Two spellings of "what this
  // points at" is how a user comparing the two concludes they are different.
  it("names a role locator the way the step list does", () => {
    expect(describeTarget({ k: "role", role: "button", name: "Close" })).toBe("button “Close”");
  });
  it("spells a testid locator as the attribute it really resolves", () => {
    expect(describeTarget({ k: "testid", v: "x" })).toBe('data-testid="x"');
    expect(describeTarget({ k: "testid", v: "x", attr: "data-test" })).toBe('data-test="x"');
  });
  it("falls back to the raw value for css", () => {
    expect(describeTarget({ k: "css", v: "button.close" })).toBe("button.close");
  });
});

describe("OverlayRulesPane", () => {
  it("says so plainly when there are no rules", async () => {
    withRules([]);
    renderPane(<OverlayRulesPane />);
    expect(await screen.findByText("No rules yet")).toBeTruthy();
  });

  it("groups rules under their host", async () => {
    withRules([rule(), rule({ id: "r2", host: "example.com", label: "Dismiss" })]);
    renderPane(<OverlayRulesPane />);
    expect(await screen.findByText("ritual.com")).toBeTruthy();
    expect(await screen.findByText("example.com")).toBeTruthy();
  });

  it("shows what each rule actually clicks, not just its name", async () => {
    withRules([rule()]);
    renderPane(<OverlayRulesPane />);
    // Both, and they are different strings: the label is the user's word for
    // it, the target is what the watcher resolves.
    expect(await screen.findByText("Close")).toBeTruthy();
    expect(await screen.findByText('data-testid="dg-header-close"')).toBeTruthy();
  });

  it("falls back to the target when a rule has no label", async () => {
    withRules([rule({ label: "" })]);
    renderPane(<OverlayRulesPane />);
    // Rendered twice — as the name and as the target — so a rule taught with no
    // text on its control is still identifiable.
    await waitFor(() =>
      expect(screen.getAllByText('data-testid="dg-header-close"').length).toBe(2),
    );
  });

  it("disables through update rather than deleting", async () => {
    withRules([rule()]);
    renderPane(<OverlayRulesPane />);
    const toggle = await screen.findByLabelText("Enable Close");
    fireEvent.click(toggle);
    await waitFor(() => expect(rulesApi.update).toHaveBeenCalledWith("r1", { disabled: true }));
    expect(rulesApi.remove).not.toHaveBeenCalled();
  });

  it("renames on the SAME id", async () => {
    withRules([rule()]);
    renderPane(<OverlayRulesPane />);
    fireEvent.click(await screen.findByText("Rename"));
    const field = await screen.findByLabelText("New name for Close");
    fireEvent.change(field, { target: { value: "Consent banner" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(rulesApi.update).toHaveBeenCalledWith("r1", { label: "Consent banner" }),
    );
  });

  it("offers no way to edit the target", async () => {
    withRules([rule()]);
    renderPane(<OverlayRulesPane />);
    fireEvent.click(await screen.findByText("Rename"));
    // Exactly one field in edit mode, and it is the label.
    const fields = await screen.findAllByRole("textbox");
    expect(fields).toHaveLength(1);
    expect(fields[0].getAttribute("aria-label")).toBe("New name for Close");
  });

  it("deletes a rule when asked outright", async () => {
    withRules([rule()]);
    renderPane(<OverlayRulesPane />);
    fireEvent.click(await screen.findByText("Delete"));
    await waitFor(() => expect(rulesApi.remove).toHaveBeenCalledWith("r1"));
  });

  it("subscribes to overlayRules:changed, so a rule taught in the trainer appears here", async () => {
    // The push exists for exactly this: the trainer is another window, and
    // without the subscription the list sits stale until the pane is reopened.
    withRules([]);
    renderPane(<OverlayRulesPane />);
    await screen.findByText("No rules yet");
    expect(onApi).toHaveBeenCalledWith("overlayRules:changed", expect.any(Function));
  });
});

// ── Handle pop-ups: the switch over everything, and the built-in handlers ──
//
// Two RecorderSettings, read through the controller like Auto-Heal's rather
// than through react-query like the rules, so "reset section" and the modified
// count can see them. What is pinned is the PATCH each control writes — the
// wrong direction on the presets row is silent: a switch that wrote the enabled
// ids into `disabledPopupPresets` would render correctly and disarm exactly
// the handlers the user left on.
describe("Handle pop-ups", () => {
  it("reads the default as on and saves being turned off", () => {
    withRules([]);
    const { controller } = renderPane(<OverlayRulesPane />);
    const sw = screen.getByRole("switch", { name: /^handle pop-ups$/i });
    expect(sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state")).toMatch(
      /true|checked/i,
    );
    fireEvent.click(sw);
    expect(savedPatch(controller)).toEqual({ defaultHandlePopups: false });
  });

  it("lists every built-in handler with its vendor and what it clicks", () => {
    withRules([]);
    renderPane(<OverlayRulesPane />);
    // Driven off the shipped list rather than two literals, so a third vendor
    // is covered the day it lands — and the list is asserted non-empty so the
    // loop cannot pass over nothing.
    expect(POPUP_PRESETS.length).toBeGreaterThan(1);
    for (const preset of POPUP_PRESETS) {
      expect(screen.getByText(preset.label)).toBeTruthy();
      expect(screen.getByText(preset.target.v as string)).toBeTruthy();
    }
    expect(screen.getByText("Klaviyo")).toBeTruthy();
    expect(screen.getByText("DataGrail")).toBeTruthy();
  });

  it("switching a handler off records its id, and only its id", () => {
    withRules([]);
    const { controller } = renderPane(<OverlayRulesPane />);
    fireEvent.click(screen.getByRole("switch", { name: "Enable DataGrail consent banner — Close" }));
    expect(savedPatch(controller)).toEqual({ disabledPopupPresets: ["datagrail-consent-close"] });
  });

  it("switching it back on removes the id", () => {
    withRules([]);
    const controller = makeController({
      settings: { disabledPopupPresets: ["datagrail-consent-close"] },
    });
    renderPane(<OverlayRulesPane />, { controller });
    const sw = screen.getByRole("switch", { name: "Enable DataGrail consent banner — Close" });
    expect(sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state")).toMatch(
      /false|unchecked/i,
    );
    fireEvent.click(sw);
    expect(savedPatch(controller)).toEqual({ disabledPopupPresets: [] });
  });

  it("opens the pop-ups document from the row", () => {
    // The first production use of `SettingRow`'s `doc` prop. The pane is
    // router-free; the routed wrapper in settings-view.tsx turns the slug into
    // an address, and this is the slug it must be handed.
    withRules([]);
    const onOpenDoc = vi.fn();
    renderPane(<OverlayRulesPane onOpenDoc={onOpenDoc} />);
    fireEvent.click(screen.getByRole("button", { name: "How pop-up handling works" }));
    expect(onOpenDoc).toHaveBeenCalledWith("handle-pop-ups");
  });
});
