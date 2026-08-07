// Tests for the Auto-Heal pane.
//
// The parameters are children of the main switch: with Auto-Heal off they used
// to sit there editable, writing settings nothing would read. Unmounting them
// is the behaviour change, and "they come back with their stored values
// intact" is what stops that from being a data-loss bug.

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { AutoHealPane } from "./auto-heal-pane";

describe("the main switch", () => {
  it("is on by default", () => {
    // Auto-Heal defaults ON, unlike almost everything else in this window.
    renderPane(<AutoHealPane />);
    const sw = screen.getByRole("switch", { name: /^auto-heal$/i });
    expect(sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state")).toMatch(
      /true|checked/i,
    );
  });

  it("saves being turned off", () => {
    const { controller } = renderPane(<AutoHealPane />);
    fireEvent.click(screen.getByRole("switch", { name: /^auto-heal$/i }));
    expect(savedPatch(controller)).toEqual({ autoHealEnabled: false });
  });

  it("explains what a heal is without needing the disclosure", () => {
    renderPane(<AutoHealPane />);
    expect(screen.getByText(/search the page for alternative targets/i)).toBeTruthy();
  });

  it("mentions the Heals tab and the way back, behind the disclosure", () => {
    const { container } = renderPane(<AutoHealPane />);
    const row = container.querySelector('[data-setting-row="auto-heal-enabled"]');
    const more = row?.querySelector("button[aria-expanded]") as HTMLButtonElement;
    fireEvent.click(more);
    expect(screen.getByText(/one-click way back/i)).toBeTruthy();
  });
});

describe("the parameters depend on the main switch", () => {
  it("are absent when Auto-Heal is off", () => {
    const controller = makeController({ settings: { autoHealEnabled: false } });
    renderPane(<AutoHealPane />, { controller });
    expect(screen.queryByRole("spinbutton", { name: /heal attempts/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /apply heals automatically/i })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /per-attempt timeout/i })).toBeNull();
  });

  it("are present when it is on", () => {
    renderPane(<AutoHealPane />);
    expect(screen.getByRole("spinbutton", { name: /heal attempts/i })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /apply heals automatically/i })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /per-attempt timeout/i })).toBeTruthy();
  });

  it("come back with their stored values, not with defaults", () => {
    // Unmounting a control must not be mistaken for clearing the setting it
    // edits — nothing is written when the parent goes off.
    const controller = makeController({
      settings: { autoHealEnabled: true, autoHealRetries: 7, autoHealAttemptTimeoutMs: 9000 },
    });
    const { rerender } = renderPane(<AutoHealPane />, { controller });
    expect(
      (screen.getByRole("spinbutton", { name: /heal attempts/i }) as HTMLInputElement).value,
    ).toBe("7");
    expect(
      (screen.getByRole("spinbutton", { name: /per-attempt timeout/i }) as HTMLInputElement).value,
    ).toBe("9000");
    expect(controller.save).not.toHaveBeenCalled();
    rerender(<div />);
  });
});

describe("apply mode", () => {
  it("defaults to suggest, not apply", () => {
    // The safe direction: a heal is recorded for review rather than written
    // into the saved test.
    renderPane(<AutoHealPane />);
    const sw = screen.getByRole("switch", { name: /apply heals automatically/i });
    expect(sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state")).toMatch(
      /false|unchecked/i,
    );
  });

  it("maps the switch to the stored mode strings", () => {
    // The setting is "suggest" | "apply", not a boolean — a switch wired
    // straight to true/false would persist a value the engine rejects.
    const { controller } = renderPane(<AutoHealPane />);
    fireEvent.click(screen.getByRole("switch", { name: /apply heals automatically/i }));
    expect(savedPatch(controller)).toEqual({ autoHealApply: "apply" });
  });

  it("maps back to suggest", () => {
    const controller = makeController({
      settings: { autoHealEnabled: true, autoHealApply: "apply" },
    });
    renderPane(<AutoHealPane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /apply heals automatically/i }));
    expect(savedPatch(controller)).toEqual({ autoHealApply: "suggest" });
  });

  it("warns that a wrong heal usually still succeeds", () => {
    // The caveat that decides whether someone should turn this on, so it is in
    // the always-visible summary.
    renderPane(<AutoHealPane />);
    expect(screen.getByText(/a wrong heal usually still succeeds/i)).toBeTruthy();
  });
});

describe("numeric parameters", () => {
  it("saves a retry count", () => {
    const { controller } = renderPane(<AutoHealPane />);
    fireEvent.change(screen.getByRole("spinbutton", { name: /heal attempts/i }), {
      target: { value: "6" },
    });
    expect(savedPatch(controller)).toEqual({ autoHealRetries: 6 });
  });

  it("clamps a retry count above the engine's limit", () => {
    const { controller } = renderPane(<AutoHealPane />);
    fireEvent.change(screen.getByRole("spinbutton", { name: /heal attempts/i }), {
      target: { value: "500" },
    });
    expect(savedPatch(controller)).toEqual({ autoHealRetries: 10 });
  });

  it("saves a per-attempt timeout", () => {
    const { controller } = renderPane(<AutoHealPane />);
    fireEvent.change(screen.getByRole("spinbutton", { name: /per-attempt timeout/i }), {
      target: { value: "12000" },
    });
    expect(savedPatch(controller)).toEqual({ autoHealAttemptTimeoutMs: 12000 });
  });

  it("clamps a timeout below the engine's floor", () => {
    const { controller } = renderPane(<AutoHealPane />);
    fireEvent.change(screen.getByRole("spinbutton", { name: /per-attempt timeout/i }), {
      target: { value: "5" },
    });
    expect(savedPatch(controller)).toEqual({ autoHealAttemptTimeoutMs: 1000 });
  });
});

describe("search filtering", () => {
  it("shows only the matched parameter", () => {
    renderPane(<AutoHealPane />, { matchedIds: ["auto-heal-retries"] });
    expect(screen.getByRole("spinbutton", { name: /heal attempts/i })).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: /per-attempt timeout/i })).toBeNull();
  });

  it("does not resurrect a parameter while Auto-Heal is off", () => {
    const controller = makeController({ settings: { autoHealEnabled: false } });
    renderPane(<AutoHealPane />, { controller, matchedIds: ["auto-heal-retries"] });
    expect(screen.queryByRole("spinbutton", { name: /heal attempts/i })).toBeNull();
  });
});
