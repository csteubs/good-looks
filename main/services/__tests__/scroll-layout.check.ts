// Standalone regression check for full-height scroll regions.
//
// The bug: a view laid out as `flex h-full flex-col` — a Toolbar above a
// ScrollArea — gave the ScrollArea `h-full`. In a flex column that resolves to
// 100% of the PARENT, but the toolbar has already consumed part of that height,
// so the scroll region extends past the bottom of the window by exactly the
// toolbar's height and its LAST child is cut off. In the Stats view that was
// the pagination control: present in the DOM, impossible to click.
//
// The fix is `min-h-0 flex-1` — claim only the remaining space, and allow
// shrinking below content height (without min-h-0 a flex item refuses to shrink
// and overflows again).
//
// Checked at source level for the same reason as check:ai-debug-scroll: the
// SDK's ScrollArea exposes no stable DOM marker, so a rendered assertion would
// have to reach into Radix internals. jsdom also has no layout engine, so it
// could never observe the clipping this prevents.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:scroll-layout

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** Views laid out as a Toolbar above a full-height ScrollArea. */
const VIEWS = [
  "../../../renderer/main/stats-view.tsx",
  "../../../renderer/main/batch-view.tsx",
];

for (const rel of VIEWS) {
  const file = resolve(here, rel);
  const src = readFileSync(file, "utf8");
  const name = rel.split("/").pop();

  // The page-level ScrollArea is the one whose class list carries flex sizing.
  const tags = [...src.matchAll(/<ScrollArea[^>]*>/g)].map((m) => m[0]);
  assert(tags.length > 0, `${name}: has a ScrollArea`);

  const pageLevel = tags.filter((t) => /className="[^"]*\b(flex-1|h-full)\b[^"]*"/.test(t));
  assert(pageLevel.length > 0, `${name}: has a page-level ScrollArea`);

  for (const tag of pageLevel) {
    assert(
      /\bflex-1\b/.test(tag),
      `${name}: page ScrollArea uses flex-1 (not h-full, which overflows past the toolbar)`,
    );
    assert(
      /\bmin-h-0\b/.test(tag),
      `${name}: page ScrollArea pairs flex-1 with min-h-0 (or it won't shrink)`,
    );
    assert(
      !/className="[^"]*\bh-full\b/.test(tag),
      `${name}: page ScrollArea does NOT use h-full`,
    );
  }

  // Bottom padding on the scrolled content, so the last control never sits
  // flush against the window edge.
  const contentDiv = src.match(/<div className="mx-auto flex max-w-\dxl flex-col[^"]*"/);
  assert(contentDiv !== null, `${name}: found the scroll content container`);
  if (contentDiv) {
    assert(
      /\bpb-\d+\b/.test(contentDiv[0]),
      `${name}: scroll content carries explicit bottom padding`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll scroll-layout checks passed");
