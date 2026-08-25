// Which clicks a captured double-click withdraws.
//
// Its own module, and PURE, for the reason recorder-navigation.ts is: this is a
// decision the user sees the consequence of — two phantom click steps, or a
// deliberate single click quietly eaten — and neither should need an Electron
// window to exercise.

import { healKeyFor } from "../../shared/heal-key.mjs";
import type { Locator, Step } from "../recorder/types.js";

/** How long after a click a `dblclick` may still claim it. Generous: a browser
 *  fires the second click well inside this, and a click the user meant on its
 *  own is separated by far more. */
export const DBLCLICK_CLAIM_MS = 800;

/** The app's canonical "same element" spelling, plus the one thing
 *  `healKeyFor` deliberately drops. It omits `nth` so an indexed step shares a
 *  key with the unindexed one it narrows — which is what makes a `.nth()` step
 *  healable — but here the index is exactly what distinguishes row 1 from row
 *  2, and a double-click on one row must not swallow a single click on
 *  another. */
export function locatorIdentity(loc: Locator): string {
  return healKeyFor(loc) + "|nth=" + (loc.nth ?? "");
}

/**
 * Withdraw the clicks a captured double-click supersedes.
 *
 * A browser fires `click` twice BEFORE `dblclick`, and each of those clicks has
 * already left the page — the console channel emits a click the instant it is
 * captured, which is the whole fix for the click that navigates (DECISIONS
 * 2026-08-13) and must not be undone by holding one back to see what follows.
 * So the two clicks are recorded, and withdrawn HERE, at the single ingest,
 * when the double-click that claims them arrives.
 *
 * CAPTURE ONLY. A double-click added from the Add-step dialog claims nothing:
 * the user placed it deliberately, next to whatever else they placed.
 *
 * Removes from the steps IMMEDIATELY BEFORE the insertion point rather than
 * from the end of the list, because the cursor can sit mid-list while a
 * recording extends an existing test.
 *
 * @returns how many were removed, so the caller can pull the cursor back.
 */
export function dropClicksSupersededBy(step: Step, list: Step[], at: number): number {
  if (step.type !== "dblclick" || !step.locator) return 0;
  const key = locatorIdentity(step.locator);
  const now = step.timestamp;
  let removed = 0;
  while (removed < 2) {
    const prev = list[at - removed - 1];
    if (!prev || prev.type !== "click" || !prev.locator) break;
    if (now - prev.timestamp > DBLCLICK_CLAIM_MS) break;
    if (locatorIdentity(prev.locator) !== key) break;
    removed++;
  }
  if (removed > 0) list.splice(at - removed, removed);
  return removed;
}
