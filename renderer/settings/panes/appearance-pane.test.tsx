// Tests for the Appearance pane.
//
// The flourishes are stored as an array of DISABLED ids, so the switches are
// inverted: checked means "not in the array". That inversion is the whole risk
// here — get it backwards and every flourish reads as off while being on, which
// looks like the toggle is broken rather than the mapping.

import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { AppearancePane } from "./appearance-pane";

function switchState(name: RegExp): string {
  const sw = screen.getByRole("switch", { name });
  return sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state") ?? "";
}

describe("theme", () => {
  it("offers all three sources", () => {
    renderPane(<AppearancePane />);
    for (const name of ["Auto", "Light", "Dark"]) {
      expect(screen.getByRole("radio", { name }), name).toBeTruthy();
    }
  });

  it("shows the current source", () => {
    const controller = makeController({ themeSource: "dark" });
    renderPane(<AppearancePane />, { controller });
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(dark.getAttribute("aria-checked") ?? dark.getAttribute("data-state")).toMatch(
      /true|checked/i,
    );
  });

  it("sets a new source", async () => {
    const { controller } = renderPane(<AppearancePane />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    await waitFor(() => expect(controller.setTheme).toHaveBeenCalledWith("light"));
  });

  it("does not write the theme through the settings store", () => {
    // Theme lives in nativeTheme, not RecorderSettings. Routing it through
    // `save` would persist a key the backend does not know.
    const { controller } = renderPane(<AppearancePane />);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(controller.save).not.toHaveBeenCalled();
  });
});

describe("flourishes are stored as disabled ids", () => {
  it("shows a flourish as ON when its id is absent", () => {
    const controller = makeController({ settings: { disabledAestheticEnhancements: [] } });
    renderPane(<AppearancePane />, { controller });
    expect(switchState(/ai thinking gif/i)).toMatch(/true|checked/i);
    expect(switchState(/home screen animation/i)).toMatch(/true|checked/i);
  });

  it("shows a flourish as OFF when its id is present", () => {
    const controller = makeController({
      settings: { disabledAestheticEnhancements: ["aiThinkingGif"] },
    });
    renderPane(<AppearancePane />, { controller });
    expect(switchState(/ai thinking gif/i)).toMatch(/false|unchecked/i);
    // And only that one.
    expect(switchState(/home screen animation/i)).toMatch(/true|checked/i);
  });

  it("adds an id when a flourish is switched off", () => {
    const { controller } = renderPane(<AppearancePane />);
    fireEvent.click(screen.getByRole("switch", { name: /ai thinking gif/i }));
    expect(savedPatch(controller)).toEqual({ disabledAestheticEnhancements: ["aiThinkingGif"] });
  });

  it("removes an id when a flourish is switched back on", () => {
    const controller = makeController({
      settings: { disabledAestheticEnhancements: ["aiThinkingGif"] },
    });
    renderPane(<AppearancePane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /ai thinking gif/i }));
    expect(savedPatch(controller)).toEqual({ disabledAestheticEnhancements: [] });
  });

  it("leaves the other flourish's id alone", () => {
    // Both switches write the SAME key, so a handler that replaced the array
    // instead of editing it would silently re-enable the other one.
    const controller = makeController({
      settings: { disabledAestheticEnhancements: ["homeBlackHole"] },
    });
    renderPane(<AppearancePane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /ai thinking gif/i }));
    const saved = savedPatch(controller).disabledAestheticEnhancements as string[];
    expect(saved.slice().sort()).toEqual(["aiThinkingGif", "homeBlackHole"]);
  });

  it("preserves an unknown id it does not have a switch for", () => {
    // A flourish added in a later version and disabled there must survive
    // being edited by an older pane.
    const controller = makeController({
      settings: { disabledAestheticEnhancements: ["someFutureFlourish"] },
    });
    renderPane(<AppearancePane />, { controller });
    fireEvent.click(screen.getByRole("switch", { name: /home screen animation/i }));
    const saved = savedPatch(controller).disabledAestheticEnhancements as string[];
    expect(saved).toContain("someFutureFlourish");
  });

  it("treats a missing array as everything enabled", () => {
    const controller = makeController({ settings: {} });
    renderPane(<AppearancePane />, { controller });
    expect(switchState(/ai thinking gif/i)).toMatch(/true|checked/i);
  });
});

describe("presentation", () => {
  it("gives the flourishes a real heading, not a label-only row", () => {
    // The old window faked this heading as a Field with a label and no
    // control — the only heading anywhere in it.
    renderPane(<AppearancePane />);
    expect(screen.getByText("Flourishes")).toBeTruthy();
    expect(screen.queryByText("Aesthetic Enhancements")).toBeNull();
  });

  it("keeps the invitation to turn them off", () => {
    renderPane(<AppearancePane />);
    expect(screen.getByText(/if you prefer a plainer interface/i)).toBeTruthy();
  });
});

describe("search filtering", () => {
  it("hides the theme row when only a flourish matched", () => {
    renderPane(<AppearancePane />, { matchedIds: ["home-black-hole"] });
    expect(screen.queryByRole("radio", { name: "Auto" })).toBeNull();
    expect(screen.getByRole("switch", { name: /home screen animation/i })).toBeTruthy();
  });

  it("drops the flourishes section when only the theme matched", () => {
    renderPane(<AppearancePane />, { matchedIds: ["theme"] });
    expect(screen.queryByText("Flourishes")).toBeNull();
    expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy();
  });
});
