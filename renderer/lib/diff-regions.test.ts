// "What moved" — reading the region breakdown out loud. REDESIGN §6.6.
//
// The words are the feature, so these assert the sentence rather than walking
// spans — the same rule §6.6's provenance and drift lines follow.
//
// Two things here would be quietly wrong. A place measured from a box's CORNER
// sends the reader to the wrong part of the page for any change that spans the
// middle, and it throws no error and looks fine. And a share rounding to "0%"
// for a region that is in the list reads as broken arithmetic rather than as a
// small region.

import { describe, expect, it } from "vitest";

import type { DiffRegion } from "./recorder-types";
import {
  DOMINANT_SHARE,
  dominantRegion,
  formatShare,
  regionPlace,
  regionsLine,
} from "./diff-regions";

function region(over: Partial<DiffRegion> = {}): DiffRegion {
  return { x: 0, y: 0, w: 0.1, h: 0.1, pixels: 100, share: 1, ...over };
}

describe("where a box is", () => {
  it("names the third each way", () => {
    expect(regionPlace(region({ x: 0.02, y: 0.02 }))).toBe("top left");
    expect(regionPlace(region({ x: 0.45, y: 0.02 }))).toBe("top");
    expect(regionPlace(region({ x: 0.85, y: 0.02 }))).toBe("top right");
    expect(regionPlace(region({ x: 0.02, y: 0.45 }))).toBe("left");
    expect(regionPlace(region({ x: 0.45, y: 0.45 }))).toBe("centre");
    expect(regionPlace(region({ x: 0.85, y: 0.9 }))).toBe("bottom right");
  });

  it("measures from the box's CENTRE, not its corner", () => {
    // A change through the middle of the page starts in the top third. Called
    // "top", it sends the reader to look in the wrong place — and nothing about
    // that failure is visible: the box on screen is still right.
    const throughMiddle = region({ x: 0.4, y: 0.25, w: 0.2, h: 0.5 });
    expect(throughMiddle.y).toBeLessThan(1 / 3);
    expect(regionPlace(throughMiddle)).toBe("centre");
  });

  it("loses the axis a box spans, without needing a rule for it", () => {
    // A full-width banner is "top", not "top left" — and that falls out of
    // centring rather than out of a span test, which is why there isn't one.
    expect(regionPlace(region({ x: 0, y: 0.02, w: 1, h: 0.08 }))).toBe("top");
    expect(regionPlace(region({ x: 0.02, y: 0, w: 0.08, h: 1 }))).toBe("left");
    // Spanning both is just "centre" — there is nowhere else for it to be.
    expect(regionPlace(region({ x: 0, y: 0, w: 1, h: 1 }))).toBe("centre");
  });
});

describe("shares", () => {
  it("never rounds a listed region down to nothing", () => {
    // It is IN the list, so it held some of the change; "0%" reads as broken
    // arithmetic rather than as a small region.
    expect(formatShare(0.0004)).toBe("<1%");
    expect(formatShare(0.004)).toBe("<1%");
  });

  it("rounds the rest", () => {
    expect(formatShare(0.62)).toBe("62%");
    expect(formatShare(1)).toBe("100%");
  });
});

describe("the sentence", () => {
  it("says nothing when there is nothing to say", () => {
    // A matched frame carries no regions, and an empty "0 areas changed." under
    // it would be a finding about a frame that had none.
    expect(regionsLine([])).toBe("");
  });

  it("does not quote a share when one region holds everything", () => {
    // "100% of the change" tells the reader nothing they did not know from the
    // sentence already having one subject.
    expect(regionsLine([region({ x: 0.02, y: 0.02, share: 1 })])).toBe(
      "One area changed, top left.",
    );
  });

  it("leads with the largest, and says where it is", () => {
    expect(
      regionsLine([
        region({ x: 0.02, y: 0.02, share: 0.7 }),
        region({ x: 0.85, y: 0.9, share: 0.3 }),
      ]),
    ).toBe("2 areas changed. Largest is top left, 70% of it.");
  });

  it("owns up to the regions it did not list", () => {
    // The cap exists so the list stays readable; a cap that says nothing reads
    // as "this is everything".
    expect(regionsLine([region({ share: 1 })], 12)).toContain("(+12 smaller)");
    expect(
      regionsLine([region({ share: 0.7 }), region({ share: 0.3 })], 4),
    ).toContain("(+4 smaller)");
  });
});

describe("one region or many", () => {
  it("calls out a region that holds most of the change", () => {
    // A change is either somewhere or everywhere, and the two want different
    // reactions.
    const lead = region({ share: DOMINANT_SHARE });
    expect(dominantRegion([lead, region({ share: 1 - DOMINANT_SHARE })])).toBe(lead);
  });

  it("calls out nothing when the change is spread", () => {
    // "Largest is top left, 22%" invites the reader to go and look at the wrong
    // thing.
    expect(
      dominantRegion([region({ share: 0.3 }), region({ share: 0.25 }), region({ share: 0.25 })]),
    ).toBeNull();
  });

  it("calls out nothing when there is only one region to begin with", () => {
    // Nothing to be dominant OVER — the sentence already has one subject.
    expect(dominantRegion([region({ share: 1 })])).toBeNull();
    expect(dominantRegion([])).toBeNull();
  });
});
