// Standalone regression check for the Stats lists' pagination.
//
// The two failure modes worth pinning, because both render as "my data
// disappeared" rather than as an error:
//   • an empty list reporting "page 1 of 0";
//   • a page number surviving a list that SHRANK under it (filter narrowed,
//     search re-ran), leaving an empty table while rows still exist.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:paginate

import {
  DENSE_PAGE_SIZE,
  PAGE_SIZE,
  clampPage,
  pageCount,
  pageRange,
  pageSlice,
} from "../../../renderer/lib/paginate.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const items = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// ── pageCount ────────────────────────────────────────────────────────
assert(PAGE_SIZE === 50, "the page size is 50");
assert(pageCount(0) === 1, "an empty list is page 1 of 1, never 'of 0'");
assert(pageCount(1) === 1, "one item → one page");
assert(pageCount(50) === 1, "exactly one full page → one page");
assert(pageCount(51) === 2, "one over a full page → two pages");
assert(pageCount(100) === 2, "exactly two full pages → two pages");
assert(pageCount(412) === 9, `412 items → 9 pages (got ${pageCount(412)})`);
assert(pageCount(-5) === 1, "a negative total is treated as empty");
assert(pageCount(10, 0) === 1, "a zero page size doesn't divide by zero");

// ── clampPage ────────────────────────────────────────────────────────
assert(clampPage(1, 100) === 1, "page 1 stays 1");
assert(clampPage(2, 100) === 2, "an in-range page is untouched");
assert(clampPage(0, 100) === 1, "page 0 clamps up to 1");
assert(clampPage(-3, 100) === 1, "a negative page clamps up to 1");
assert(clampPage(99, 100) === 2, "a page past the end clamps to the last page");
assert(clampPage(5, 0) === 1, "any page on an empty list is 1");
assert(clampPage(1.7, 100) === 1, "a fractional page floors");
assert(clampPage(Number.NaN, 100) === 1, "NaN clamps to 1");

// The case that actually bites: you're on page 5, then a filter narrows the
// list to 20 rows. Clamping must land on real rows, not an empty page.
{
  const narrowed = items(20);
  const safe = clampPage(5, narrowed.length);
  assert(safe === 1, `a page that outlived its list clamps into range (got ${safe})`);
  assert(pageSlice(narrowed, 5).length === 20, "and the slice shows the surviving rows");
}

// ── pageSlice ────────────────────────────────────────────────────────
{
  const all = items(412);
  const p1 = pageSlice(all, 1);
  assert(p1.length === 50, "a full page holds 50");
  assert(p1[0] === 1 && p1[49] === 50, "page 1 is items 1–50");
  const p2 = pageSlice(all, 2);
  assert(p2[0] === 51 && p2[49] === 100, "page 2 is items 51–100");
  const last = pageSlice(all, 9);
  assert(last.length === 12, `the last page holds the remainder (got ${last.length})`);
  assert(last[0] === 401 && last[11] === 412, "the last page ends at the final item");
  // No item is lost or shown twice across pages.
  const stitched = Array.from({ length: 9 }, (_, i) => pageSlice(all, i + 1)).flat();
  assert(stitched.length === 412, "pages cover every item exactly once");
  assert(stitched.join(",") === all.join(","), "pages preserve order with no gaps or repeats");
}
assert(pageSlice([], 1).length === 0, "an empty list slices to nothing");
assert(pageSlice(items(10), 99).length === 10, "an out-of-range page shows the last real page");

// ── pageRange ────────────────────────────────────────────────────────
assert(pageRange(1, 0) === null, "an empty list has no range label");
{
  const r1 = pageRange(1, 412)!;
  assert(r1.from === 1 && r1.to === 50, "page 1 of 412 reads 1–50");
  const r2 = pageRange(2, 412)!;
  assert(r2.from === 51 && r2.to === 100, "page 2 reads 51–100");
  const r9 = pageRange(9, 412)!;
  assert(r9.from === 401 && r9.to === 412, "the last page's range stops at the total");
  const rSmall = pageRange(1, 7)!;
  assert(rSmall.from === 1 && rSmall.to === 7, "a partial first page stops at the total");
  const rOver = pageRange(99, 7)!;
  assert(rOver.from === 1 && rOver.to === 7, "an out-of-range page reports the clamped range");
}

// ── the dense page size ──────────────────────────────────────────────
// Step health and the run history page at 25, not 50. Every helper takes the
// size as an argument, so the failure mode is a call site that forgets it and
// silently falls back to 50 — which reports too few pages and strands rows
// behind a Next button that never enables. Pinned here as well as in the
// component tests, because the helpers are where the default lives.
assert(DENSE_PAGE_SIZE === 25, "the dense page size is 25");
assert(DENSE_PAGE_SIZE * 2 === PAGE_SIZE, "and is half the list page size");
assert(pageCount(200, DENSE_PAGE_SIZE) === 8, "200 dense rows → 8 pages");
assert(pageCount(25, DENSE_PAGE_SIZE) === 1, "exactly one dense page → one page");
assert(pageCount(26, DENSE_PAGE_SIZE) === 2, "one over → two pages");
{
  const all = items(200);
  const p1 = pageSlice(all, 1, DENSE_PAGE_SIZE);
  assert(p1.length === 25 && p1[24] === 25, "dense page 1 is items 1–25");
  const p2 = pageSlice(all, 2, DENSE_PAGE_SIZE);
  assert(p2[0] === 26 && p2[24] === 50, "dense page 2 is items 26–50");
  const stitched = Array.from({ length: 8 }, (_, i) => pageSlice(all, i + 1, DENSE_PAGE_SIZE)).flat();
  assert(stitched.join(",") === all.join(","), "dense pages cover every item exactly once");
  const r = pageRange(8, 200, DENSE_PAGE_SIZE)!;
  assert(r.from === 176 && r.to === 200, "the last dense page reads 176–200");
  assert(clampPage(8, 30, DENSE_PAGE_SIZE) === 2, "a dense page past a shrunken list clamps");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll paginate checks passed");
