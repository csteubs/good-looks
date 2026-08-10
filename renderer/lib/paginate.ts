// Client-side pagination for the Stats lists.
//
// Both the run-history table and the raw-log search results can run to
// hundreds of rows, and rendering all of them makes the view sluggish and
// impossible to scan. These helpers are pure so check:paginate can pin the
// edge cases, which is where paging normally breaks:
//
//   • an empty list must still be "page 1 of 1", not "page 1 of 0";
//   • when the underlying list SHRINKS (a filter narrows it, a search
//     re-runs), a page number that's now out of range must clamp to the last
//     page rather than rendering an empty table with rows that exist.
//
// Pages are 1-based, because they're user-facing.

/** Rows per page for the Stats lists. */
export const PAGE_SIZE = 50;

/** Rows per page for the two DENSE tables — Step health and the run history.
 *  Half of PAGE_SIZE on purpose: both carry two lines per row and several
 *  numeric columns, so fifty of them is a wall rather than a list, and both
 *  arrive already ordered by what matters (severity, then recency) — the rows
 *  worth reading are at the top of page 1. */
export const DENSE_PAGE_SIZE = 25;

/** Total pages for `total` items. Always at least 1, so an empty list reads
 *  "Page 1 of 1" rather than "Page 1 of 0". */
export function pageCount(total: number, size: number = PAGE_SIZE): number {
  if (size <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

/** Bring a page number into range. Guards the case that actually bites: the
 *  list shrank under a page you were already on. */
export function clampPage(page: number, total: number, size: number = PAGE_SIZE): number {
  const last = pageCount(total, size);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), last);
}

/** The items on `page`. Clamps first, so an out-of-range page shows the last
 *  page of real rows instead of nothing. */
export function pageSlice<T>(items: T[], page: number, size: number = PAGE_SIZE): T[] {
  const safe = clampPage(page, items.length, size);
  const start = (safe - 1) * size;
  return items.slice(start, start + size);
}

/** 1-based inclusive range shown on this page, for a "51–100 of 412" label.
 *  Returns null for an empty list, where a range reads as nonsense. */
export function pageRange(
  page: number,
  total: number,
  size: number = PAGE_SIZE,
): { from: number; to: number } | null {
  if (total <= 0) return null;
  const safe = clampPage(page, total, size);
  const from = (safe - 1) * size + 1;
  return { from, to: Math.min(total, safe * size) };
}
