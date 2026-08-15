// The two rows every category dashboard is built from.
//
// Extracted from `stats-category-view.tsx` when the fourth dashboard landed:
// seven categories in one file is a file nobody reads, and a copied `DrillRow`
// is how two dashboards come to disagree about what a drillable row looks like.
//
// They encode the two rules in docs/plans/stats-categories.md §6. `DrillRow`
// goes one level DOWN — the whole row is the button, because a chevron you have
// to hit is a target the width of a character. `ExitRow` goes OUT to the object
// the number is about, and every leaf owes the user one: the failure mode of a
// drill-down hierarchy is a beautifully broken-down number you cannot act on.

import { ChevronRight } from "lucide-react";

import { TONE } from "../../theme";

export function DrillRow({
  label,
  count,
  detail,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  detail: string;
  tone?: keyof typeof TONE | null;
  onClick: () => void;
}) {
  return (
    <button type="button" className="gl-drill" onClick={onClick}>
      <span className="gl-drill-label">{label}</span>
      <span className="gl-drill-count" style={tone ? { color: TONE[tone] } : undefined}>
        {count}
      </span>
      <span className="gl-drill-detail">{detail}</span>
      <ChevronRight aria-hidden="true" className="gl-drill-arrow" />
    </button>
  );
}

/**
 * A row that leaves Stats for the thing it names.
 *
 * `action` names the destination rather than saying "Open" — a dashboard that
 * hands off to the Visual view and one that opens a test both used to say the
 * same word, and the word was the only thing on screen telling you where the
 * click went.
 */
export function ExitRow({
  name,
  detail,
  action = "Open test",
  onOpen,
}: {
  name: string;
  detail: string;
  action?: string;
  onOpen: () => void;
}) {
  return (
    <div className="gl-exit">
      <div className="gl-rowline">
        <div className="gl-rowline-main">{name}</div>
        <div className="gl-rowline-sub">{detail}</div>
      </div>
      {/* Cyan, which the palette declares "running / live / focus" and which
          `check:selection-neutral` allows on a focus affordance. It is not
          reporting an outcome — it is the way out. */}
      <button type="button" className="gl-exit-go" onClick={onOpen}>
        {action} ›
      </button>
    </div>
  );
}
