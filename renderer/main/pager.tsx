// Shared pager for the list views.
//
// Lifted out of stats-view so the Heals view uses literally the same control
// rather than a copy of it — two pagers drift, and the edge cases here are ones
// that were got wrong once already and are pinned by check:paginate: an empty
// list reads "page 1 of 1" not "of 0", and a page number that outlives its list
// clamps to real rows instead of rendering an empty table.

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Btn } from "../theme";
import { clampPage, pageCount, pageRange } from "../lib/paginate";

export function Pager({
  page,
  total,
  onPage,
  label,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
  label: string;
}) {
  const pages = pageCount(total);
  if (pages <= 1) return null;
  const safe = clampPage(page, total);
  const range = pageRange(safe, total);
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
