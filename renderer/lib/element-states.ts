// What each pseudo-state the user can pick expands into.
//
// Pulled out of the Add-step dialog because it cannot be tested through it: the
// state picker is the SDK's `Select`, which is native-menu-backed, so its
// options never enter the DOM and jsdom cannot drive a selection (see
// CLAUDE.md). Leaving the expansion inline would leave the one part of this
// feature with several possible answers as the one part with no coverage.
//
// WHY EXPANSION AT ALL. A step emits exactly one awaited statement — the run
// highlighting depends on it twice over (`generateSpecDetailed`'s line map, and
// `buildStepLineMap`'s await-counting fallback for hand-edited specs). `:hover`
// and `:focus` fit in one call. `:active` and `:focus-visible` do not, so they
// become SEVERAL ordinary rows instead of one compound step, the same shape the
// wait dialog uses for its independent properties. Each row stays reorderable,
// editable, deletable and individually visible in the generated spec.

import type { Locator, RawStep } from "./recorder-types";

/** The states the USER picks. Deliberately not the same set as `ElementState`:
 *  two of these expand to more than one step. */
export type StatePick = "hover" | "focus" | "focusVisible" | "active";

export const STATE_PICKS: StatePick[] = ["hover", "focus", "focusVisible", "active"];

/**
 * The rows one state pick inserts, in the order they must appear.
 *
 * ORDER IS THE MEANING, and it is invisible in the finished list:
 *  • `hover` must precede `press`, because `page.mouse.down()` presses wherever
 *    the pointer already is. Reversed, it presses at whatever the last action
 *    left under the cursor and the `:active` assertion measures a different
 *    element — while the step list still reads correctly.
 *  • `Tab` must precede `focus`, because it is what puts the browser in
 *    keyboard modality for the script `focus()` to inherit. Reversed, it moves
 *    focus off the element under test after focusing it.
 *
 * Returns an empty array when a state that needs a target has none, so the
 * caller refuses the whole submit rather than inserting a step that generates
 * no line.
 */
export function buildStateSteps(pick: StatePick, locator: Locator | null): RawStep[] {
  if (!locator) return [];
  switch (pick) {
    case "focus":
      return [{ type: "state", elementState: "focus", locator }];
    case "focusVisible":
      // A plain `press` step, not a new kind: it already generates
      // (`page.keyboard.press("Tab")`) and already round-trips through the
      // parser, so this composition costs nothing downstream.
      return [
        { type: "press", value: "Tab" },
        { type: "state", elementState: "focus", locator },
      ];
    case "active":
      // All three at once, with the assertion dragged between press and
      // release — the same shape as the `if`/`end if` pair. Inserting `press`
      // alone would leave the button held for every step after it.
      return [
        { type: "state", elementState: "hover", locator },
        { type: "state", elementState: "press" },
        { type: "state", elementState: "release" },
      ];
    case "hover":
    default:
      return [{ type: "state", elementState: "hover", locator }];
  }
}
