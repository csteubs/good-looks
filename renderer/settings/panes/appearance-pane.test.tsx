// Tests for the Appearance pane.
//
// The flourishes are stored as an array of DISABLED ids, so the switches are
// inverted: checked means "not in the array". That inversion is the whole risk
// here — get it backwards and every flourish reads as off while being on, which
// looks like the toggle is broken rather than the mapping.

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";

import { makeController, renderPane, savedPatch } from "../__tests__/harness";
import { AppearancePane } from "./appearance-pane";

function switchState(name: RegExp): string {
  const sw = screen.getByRole("switch", { name });
  return sw.getAttribute("aria-checked") ?? sw.getAttribute("data-state") ?? "";
}

describe("theme — retired, and the row says so", () => {
  // WHAT THIS USED TO ASSERT was an Auto / Light / Dark radio group. The light
  // theme is gone (REDESIGN §0): the palette is near-black with phosphor
  // accents and the screenshot bezel has no light reading, so a light variant
  // is a second design rather than a swap of values.
  //
  // These tests are not deleted with the control, because the row is not
  // deleted with the control. Someone who had pinned Light will come here
  // looking, and a row that answers is worth more than the space it costs —
  // that is a behaviour, and it is what is pinned below.

  it("still has a Theme row", () => {
    renderPane(<AppearancePane />);
    expect(screen.getByText("Theme")).toBeTruthy();
  });

  it("states dark only, in the present tense", () => {
    renderPane(<AppearancePane />);
    expect(screen.getByText(/dark only for now/i)).toBeTruthy();
  });

  it("offers no way to choose one", () => {
    // The failure this catches is a half-revert: the radios back, wired to a
    // `setTheme` that no longer exists on the controller.
    renderPane(<AppearancePane />);
    expect(screen.queryByRole("radio")).toBeNull();
    for (const name of ["Auto", "Light"]) {
      expect(screen.queryByText(name), name).toBeNull();
    }
  });

  it("does not write a theme through the settings store", () => {
    // It never did — the theme lived in nativeTheme, not RecorderSettings —
    // and the way this row could regress is by being "fixed" into a stored
    // preference the backend would drop on the floor.
    const { controller } = renderPane(<AppearancePane />);
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
    expect(screen.queryByText("Theme")).toBeNull();
    expect(screen.getByRole("switch", { name: /home screen animation/i })).toBeTruthy();
  });

  it("drops the flourishes section when only the theme matched", () => {
    // The row is still indexed under "light" and "auto" (settings-schema.ts):
    // the words someone searches for are the ones for the thing that is gone.
    renderPane(<AppearancePane />, { matchedIds: ["theme"] });
    expect(screen.queryByText("Flourishes")).toBeNull();
    expect(screen.getByText("Theme")).toBeTruthy();
  });
});
