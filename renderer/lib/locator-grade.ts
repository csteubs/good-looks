// Locator fragility, derived from the stored locator alone.
//
// The recorder ALWAYS records something — that is a design strength — but its
// fallback chain ends in shapes that are unique today and wrong after the
// next deploy: an `nth` index into DOM order, a `cssPath` of
// `:nth-of-type` hops, an `xpathFor` positional walk. Nothing in the step
// list said which rows stand on those. `docs/QA-KNOWN-GAPS.md` has named
// locator-uniqueness feedback the least-exercised surface since it was
// written; this closes it with a pure function of what is already on disk —
// no new data, no runtime cost, trivially testable.
//
// Deliberately QUIET: only the two risky tiers get an indicator. A healthy
// locator earns silence, because a badge on every row stops meaning anything
// (the same rule the rail's flow glyph followed).

import type { Locator } from "./recorder-types";

export interface LocatorGrade {
  tier: "positional" | "indexed";
  /** Two or three words for the badge/label. */
  label: string;
  /** One sentence for the accessible name and any hover-free surface. */
  detail: string;
}

/** The generated-path shapes `pickLocator` falls back to when nothing names
 *  the element: `xpathFor`'s positional walk and `cssPath`'s nth-of-type
 *  chain. A hand-written selector can match these shapes too — and earns the
 *  same warning, because it breaks the same way. */
function isGeneratedPath(loc: Locator): boolean {
  const v = loc.v ?? "";
  if (loc.k === "xpath") {
    if (/^\/html\[/.test(v)) return true;
    return (v.match(/\[\d+\]/g) ?? []).length >= 2;
  }
  if (loc.k === "css") {
    return v.includes(":nth-of-type(") || (v.match(/:nth-child\(/g) ?? []).length >= 2;
  }
  return false;
}

/**
 * Grade a step's locator, or null for the healthy majority.
 *
 * Order matters: a positional path with an index on top is graded by the
 * path — the index is the smaller of its problems.
 */
export function gradeLocator(loc: Locator | undefined): LocatorGrade | null {
  if (!loc) return null;
  if (isGeneratedPath(loc)) {
    return {
      tier: "positional",
      label: "positional locator",
      detail:
        "Positional locator — a generated path that breaks when the page's structure shifts. Refine it to something the element owns (a test id, role, or label).",
    };
  }
  if (typeof loc.nth === "number") {
    return {
      tier: "indexed",
      label: "indexed locator",
      detail:
        loc.nth === -1
          ? "Indexed locator — acts on the LAST match in page order. Stable while the newest item is the one you mean."
          : `Indexed locator — acts on match ${loc.nth + 1} in page order; a reorder changes which element that is.`,
    };
  }
  return null;
}

/** How many steps in a list carry each risky tier — the detail view's rollup. */
export function gradeCounts(steps: { locator?: Locator }[]): {
  positional: number;
  indexed: number;
} {
  let positional = 0;
  let indexed = 0;
  for (const s of steps) {
    const g = gradeLocator(s.locator);
    if (g?.tier === "positional") positional++;
    else if (g?.tier === "indexed") indexed++;
  }
  return { positional, indexed };
}
