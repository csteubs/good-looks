// Shared pager for the list views.
//
// Lifted out of stats-view so the Heals view uses literally the same control
// rather than a copy of it — two pagers drift, and the edge cases here are ones
// that were got wrong once already and are pinned by check:paginate: an empty
// list reads "page 1 of 1" not "of 0", and a page number that outlives its list
// clamps to real rows instead of rendering an empty table.

import { Button, Text } from "@glaze/core/components";
import { ChevronLeft, ChevronRight } from "lucide-react";

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
    <div className="flex items-center justify-between gap-2 border-t border-token-border px-3 py-2">
      <Text variant="small" color="tertiary">
        {range ? `${range.from}–${range.to} of ${total} ${label}` : `0 ${label}`}
      </Text>
      <div className="flex items-center gap-2">
        <Button
          variant="glass"
          size="small"
          disabled={safe <= 1}
          onClick={() => onPage(safe - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
          Prev
        </Button>
        <Text variant="small" color="secondary" className="tabular-nums">
          Page {safe} of {pages}
        </Text>
        <Button
          variant="glass"
          size="small"
          disabled={safe >= pages}
          onClick={() => onPage(safe + 1)}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

