// "What moved" — reading the region breakdown out loud. REDESIGN §6.6.
//
// The backend measures WHERE a frame changed (`visual-diff.ts` clusters the
// changed pixels into boxes); this turns those boxes into something a person
// can triage from. That is a real second half rather than formatting: a list of
// normalized rectangles is a diff map with fewer entries, and the whole reason
// the breakdown exists is that a diff map does not answer "what moved?".
//
// So each region gets a PLACE and a SHARE, in words. "62% of the change, across
// the top" is a sentence somebody can check against the page without looking at
// a picture. Four numbers between 0 and 1 are not.
//
// PURE. The boxes come off the replay the view already has; nothing here
// fetches, and `share` is computed by the backend against the whole change so
// this module never has to know the total.

import type { DiffRegion } from "./recorder-types";

/**
 * Where a box sits, in the terms a person would use.
 *
 * A THREE-BY-THREE GRID AND NOTHING FINER. "Upper-left-of-centre" is not how
 * anybody describes where something is on a page, and a finer grid buys
 * precision the box on screen already carries — the words are for the case
 * where the reader is not looking at the box.
 */
export type RegionPlace =
  | "top left"
  | "top"
  | "top right"
  | "left"
  | "centre"
  | "right"
  | "bottom left"
  | "bottom"
  | "bottom right";

const ROWS = ["top", "", "bottom"] as const;
const COLS = ["left", "", "right"] as const;

/** Which third a value falls in, from a box's own centre. */
function third(centre: number): 0 | 1 | 2 {
  if (centre < 1 / 3) return 0;
  if (centre < 2 / 3) return 1;
  return 2;
}

/**
 * Where the box is.
 *
 * MEASURED FROM THE BOX'S CENTRE, NOT ITS CORNER, and that one choice does all
 * the work here. A change spanning the middle of the page starts in the top
 * third, so a corner reading calls it "top" and sends the reader to look in the
 * wrong place — with nothing visibly wrong, since the box on screen is still
 * right.
 *
 * It also makes a separate "this box spans the axis, drop the word" rule
 * unnecessary, which is why there isn't one: a full-width banner's centre lands
 * in the middle third and loses its left/right by itself. A rule for it would
 * only ever fire on a wide box jammed against an edge — where the word it
 * deletes ("top", for something covering the top two thirds) was the useful one.
 */
export function regionPlace(r: DiffRegion): RegionPlace {
  const row = ROWS[third(r.y + r.h / 2)];
  const col = COLS[third(r.x + r.w / 2)];
  const both = [row, col].filter(Boolean).join(" ");
  return (both || "centre") as RegionPlace;
}

/** A share as a percentage, rounded but never to zero — a region that is IN the
 *  list held some of the change, and "0%" reads as a bug in the maths. */
export function formatShare(share: number): string {
  const pct = share * 100;
  if (pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/**
 * The whole breakdown in one sentence.
 *
 * Built here rather than in JSX so the exact wording is assertable — this is a
 * claim about the page, and a test that walked spans would pass on a line that
 * parsed correctly and read wrongly.
 */
export function regionsLine(regions: readonly DiffRegion[], omitted = 0): string {
  if (regions.length === 0) return "";
  const tail = omitted > 0 ? ` (+${omitted} smaller)` : "";
  if (regions.length === 1) {
    // One region carrying everything needs no share — "100% of the change" is
    // a number that tells the reader nothing they did not already know.
    return `One area changed, ${regionPlace(regions[0])}${tail}.`;
  }
  const lead = regions[0];
  return (
    `${regions.length} areas changed${tail}. ` +
    `Largest is ${regionPlace(lead)}, ${formatShare(lead.share)} of it.`
  );
}

/**
 * Whether one region is worth calling out over the rest.
 *
 * A CHANGE IS EITHER SOMEWHERE OR EVERYWHERE, and the two want different
 * reactions. When a single box holds most of the change, that box IS the
 * finding and the others are trim; when the change is spread evenly, saying
 * "largest is top left, 22%" invites the reader to go and look at the wrong
 * thing. Above this share, the lead region is the answer.
 */
export const DOMINANT_SHARE = 0.6;

export function dominantRegion(regions: readonly DiffRegion[]): DiffRegion | null {
  const lead = regions[0];
  if (!lead || regions.length < 2) return null;
  return lead.share >= DOMINANT_SHARE ? lead : null;
}
