// User-defined run order for the Batch view.
//
// The order is stored as a list of test ids (RecorderSettings.batchOrder) so it
// survives navigation and restarts — a suite order like "log in, then check
// out" is worth keeping. Because it's stored by id, it drifts from the library
// constantly: tests get added, deleted, and hidden. The rules below say how,
// and are kept pure so check:batch-order can pin them without React.
//
// Two invariants the UI depends on:
//   • EVERY test appears exactly once, whether or not it's in the stored order.
//     A test that vanished from the list would be unrunnable and invisible.
//   • Reordering inside a TAG-FILTERED view still moves the test correctly in
//     the global order — the visible rows are a subsequence of it.

import type { TestRecord } from "./recorder-types";

/**
 * Sort tests by the stored order: anything the order doesn't mention FIRST, in
 * library order, then the listed ids in their stored order.
 *
 * A test the stored order has never seen is one you just recorded, and it leads
 * the list for the same reason the sidebar is newest-first: it's the one you
 * came here to run. Appending it instead buried it below a curated suite, where
 * on a library of any size it sat off the bottom of the list and read as never
 * having been created.
 *
 * The curated order itself is untouched — reordered tests keep their positions
 * relative to each other — and ids for deleted tests are ignored rather than
 * leaving gaps.
 */
export function applyOrder(tests: TestRecord[], order: string[]): TestRecord[] {
  const byId = new Map(tests.map((t) => [t.id, t]));
  const listed = new Set(order.filter((id) => byId.has(id)));
  // Unlisted first, in library order (newest first, matching the sidebar).
  const ordered: TestRecord[] = tests.filter((t) => !listed.has(t.id));
  const seen = new Set<string>();
  for (const id of order) {
    const t = byId.get(id);
    // Skip unknown ids (deleted tests) and duplicates (a corrupt stored order).
    if (!t || seen.has(id)) continue;
    seen.add(id);
    ordered.push(t);
  }
  return ordered;
}

/**
 * Move `dragId` to sit where `targetId` currently is, within the full ordered
 * id list.
 *
 * Takes ids rather than indices precisely because the drag happens in a
 * possibly-filtered view: the visible row's index means nothing globally, but
 * its id does. Dropping onto a row places the dragged test at that row's
 * position, which reads the same whether or not a filter is active.
 */
export function moveToTarget(orderedIds: string[], dragId: string, targetId: string): string[] {
  if (dragId === targetId) return orderedIds;
  const from = orderedIds.indexOf(dragId);
  const to = orderedIds.indexOf(targetId);
  if (from < 0 || to < 0) return orderedIds;
  const next = [...orderedIds];
  next.splice(from, 1);
  // Recompute the target position AFTER removal, so dragging downward lands on
  // the row you dropped onto rather than one short of it.
  const insertAt = next.indexOf(targetId);
  next.splice(from < to ? insertAt + 1 : insertAt, 0, dragId);
  return next;
}

/** The order to persist: every current test, in their present order. Storing
 *  the full list (rather than a diff) keeps `applyOrder` trivial and makes a
 *  stale entry impossible to reintroduce. */
export function orderIdsOf(tests: TestRecord[]): string[] {
  return tests.map((t) => t.id);
}

/** Is a user order actually in effect, i.e. does it differ from plain library
 *  order? Drives whether a "Reset order" affordance is worth showing —
 *  offering it when nothing has been reordered is noise. */
export function isCustomOrder(tests: TestRecord[], order: string[]): boolean {
  const ordered = applyOrder(tests, order);
  return ordered.some((t, i) => t.id !== tests[i]?.id);
}

/** Has the stored order drifted from the library (tests added or removed)?
 *  Used to rewrite it once, rather than on every render. */
export function orderIsStale(order: string[], tests: TestRecord[]): boolean {
  if (order.length !== tests.length) return true;
  const ids = new Set(tests.map((t) => t.id));
  return order.some((id) => !ids.has(id));
}
