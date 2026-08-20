// Multi-selection over the trainer's step list, and the rule for when a
// selection can become a flow.
//
// Pure and separate from the views for the reason library-groups.ts is: every
// property worth pinning here fails silently — a shift-click that selects the
// wrong range still highlights SOMETHING, and an extraction that splits an
// `if`/`endif` pair produces a flow that generates an unbalanced block and a
// caller that generates the other half. Both trainers share this module, so
// the two lists cannot disagree about what a click means.

/** The minimum a selection needs from a step. Not `Step`, so this stays
 *  testable from a literal in the node project. */
export interface SelectableStep {
  id: string;
  type: string;
}

export interface StepSelection {
  /** Selected step ids, in LIST order (not click order) — extraction preserves
   *  the recording's order, whatever order the clicks came in. */
  ids: string[];
  /** The last plainly-clicked row: what the details panel shows, and the fixed
   *  end of a shift-click range. */
  anchorId: string | null;
}

export function emptySelection(): StepSelection {
  return { ids: [], anchorId: null };
}

/** In-list-order ids for a set membership, so `ids` keeps its invariant. */
function ordered(steps: readonly SelectableStep[], members: ReadonlySet<string>): string[] {
  return steps.filter((s) => members.has(s.id)).map((s) => s.id);
}

/**
 * The next selection after a click on `clickedId`.
 *
 * Plain click: that row alone, and it becomes the anchor. Toggle (⌘/ctrl):
 * add or remove the row, anchoring on an add; removing the anchor hands the
 * anchor to the last row still selected rather than leaving a range operation
 * with no fixed end. Shift: the whole run between the anchor and the click,
 * anchor unchanged — with no anchor yet it degrades to a plain click, which is
 * what every list on this platform does.
 */
export function selectionAfterClick(
  current: StepSelection,
  steps: readonly SelectableStep[],
  clickedId: string,
  mods: { shift?: boolean; toggle?: boolean } = {},
): StepSelection {
  const clickedIndex = steps.findIndex((s) => s.id === clickedId);
  if (clickedIndex < 0) return current;

  if (mods.toggle) {
    const members = new Set(current.ids);
    if (members.has(clickedId)) {
      members.delete(clickedId);
      const ids = ordered(steps, members);
      const anchorId =
        current.anchorId === clickedId ? (ids.length > 0 ? ids[ids.length - 1] : null) : current.anchorId;
      return { ids, anchorId };
    }
    members.add(clickedId);
    return { ids: ordered(steps, members), anchorId: clickedId };
  }

  if (mods.shift && current.anchorId) {
    const anchorIndex = steps.findIndex((s) => s.id === current.anchorId);
    if (anchorIndex >= 0) {
      const start = Math.min(anchorIndex, clickedIndex);
      const end = Math.max(anchorIndex, clickedIndex);
      return { ids: steps.slice(start, end + 1).map((s) => s.id), anchorId: current.anchorId };
    }
  }

  return { ids: [clickedId], anchorId: clickedId };
}

/** Drop ids the list no longer holds — the backend rebroadcasts the whole
 *  list, so a deletion elsewhere must not leave ghost members selected. */
export function pruneSelection(
  current: StepSelection,
  steps: readonly SelectableStep[],
): StepSelection {
  const live = new Set(steps.map((s) => s.id));
  const ids = current.ids.filter((id) => live.has(id));
  if (ids.length === current.ids.length && (current.anchorId === null || live.has(current.anchorId))) {
    return current;
  }
  return {
    ids,
    anchorId: current.anchorId && live.has(current.anchorId) ? current.anchorId : (ids[ids.length - 1] ?? null),
  };
}

// Whether a selection can become a flow lives in shared/flow-extraction.mjs —
// the recorder service re-validates the same selection over IPC, and the rule
// must be one spelling on both sides. Re-exported so the views have one import.
export { extractableRange } from "../../shared/flow-extraction.mjs";
export type { ExtractableVerdict } from "../../shared/flow-extraction.mjs";
