// Shared pager for the list views.
//
// Lifted out of stats-view so the Heals view uses literally the same control
// rather than a copy of it — two pagers drift, and the edge cases here are ones
// that were got wrong once already and are pinned by check:paginate: an empty
// list reads "page 1 of 1" not "of 0", and a page number that outlives its list
// clamps to real rows instead of rendering an empty table.

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Btn } from "../theme";
import { PAGE_SIZE, clampPage, pageCount, pageRange } from "../lib/paginate";

export function Pager({
  page,
  total,
  onPage,
  label,
  // The page size the list is actually sliced with. Defaults to PAGE_SIZE, but a
  // caller paging at a different size MUST pass it too: the counts here are
  // computed, not received, so a mismatch silently reports the wrong page count
  // and hides real rows behind a Next button that never enables.
  size = PAGE_SIZE,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
  label: string;
  size?: number;
}) {
  const pages = pageCount(total, size);
  if (pages <= 1) return null;
  const safe = clampPage(page, total, size);
  const range = pageRange(safe, total, size);
  return (
    <div className="gl-pager">
      <span className="gl-pager-count">
        {range ? `${range.from}–${range.to} of ${total} ${label}` : `0 ${label}`}
      </span>
      <div className="gl-pager-controls">
        <Btn
          tone="ghost"
          disabled={safe <= 1}
          onClick={() => onPage(safe - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft aria-hidden="true" />
          Prev
        </Btn>
        <span className="gl-pager-page">
          Page {safe} of {pages}
        </span>
        <Btn
          tone="ghost"
          disabled={safe >= pages}
          onClick={() => onPage(safe + 1)}
          aria-label="Next page"
        >
          Next
          <ChevronRight aria-hidden="true" />
        </Btn>
      </div>
    </div>
  );
}
