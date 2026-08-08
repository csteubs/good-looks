// What each pseudo-state pick expands into, and — the part that matters — in
// what order.
//
// The Add-step dialog cannot cover this: its state picker is the SDK's
// native-menu-backed `Select`, whose options never enter the DOM, so jsdom
// cannot select `:active` or `:focus-visible` at all. Those two are precisely
// the picks that expand to more than one row, so without this file the only
// untested part of the feature would be the only part with a choice in it.
//
// Every case here is about ORDER, because order is the one property that is
// wrong-but-plausible: a step list showing hover/press/release reads identically
// however it is sequenced, and only the run behaves differently.

import { describe, expect, it } from "vitest";

import { buildStateSteps, STATE_PICKS } from "./element-states";
import type { Locator } from "./recorder-types";

const LOC: Locator = { k: "role", role: "button", name: "Buy" };

describe("buildStateSteps", () => {
  it("hover is a single step on the target", () => {
    expect(buildStateSteps("hover", LOC)).toEqual([
      { type: "state", elementState: "hover", locator: LOC },
    ]);
  });

  it("focus is a single step on the target", () => {
    expect(buildStateSteps("focus", LOC)).toEqual([
      { type: "state", elementState: "focus", locator: LOC },
    ]);
  });

  it("focus-visible presses Tab BEFORE focusing, not after", () => {
    // Tab establishes keyboard modality, which the script focus() then
    // inherits. Reversed, the Tab moves focus off the element that was just
    // focused — the test then measures whatever came next in the tab order.
    expect(buildStateSteps("focusVisible", LOC)).toEqual([
      { type: "press", value: "Tab" },
      { type: "state", elementState: "focus", locator: LOC },
    ]);
  });

  it("active hovers BEFORE pressing, and always emits the release", () => {
    // page.mouse.down() presses wherever the pointer already is, so the hover
    // is what aims it. And the release must be inserted with the pair — a
    // press with no release leaves the button held for every later step.
    expect(buildStateSteps("active", LOC)).toEqual([
      { type: "state", elementState: "hover", locator: LOC },
      { type: "state", elementState: "press" },
      { type: "state", elementState: "release" },
    ]);
  });

  it("press and release carry no locator", () => {
    // Giving them one would be a second, redundant way to say where the
    // pointer is, and it would disagree with the preceding hover the moment
    // either was edited.
    const steps = buildStateSteps("active", LOC);
    expect(steps[1].locator).toBeUndefined();
    expect(steps[2].locator).toBeUndefined();
  });

  it("every pick refuses to emit anything without a target", () => {
    for (const pick of STATE_PICKS) {
      expect(buildStateSteps(pick, null)).toEqual([]);
    }
  });

  it("every pick is handled — none falls through to a silent default", () => {
    // A new StatePick added without a case would land on the `hover` default
    // and quietly insert the wrong step. Each pick must produce something
    // distinguishable from every other.
    const shapes = STATE_PICKS.map((p) => JSON.stringify(buildStateSteps(p, LOC)));
    expect(new Set(shapes).size).toBe(STATE_PICKS.length);
  });
});
