// Standalone regression check for the narrow-window contract.
//
// The bug: `minWindowWidth` was 390 while the widest toolbar needed 688px
// beside a 240px sidebar. Below ~928px the run controls left the viewport —
// `Run test` on test detail, `Run 0` on batch — and NOTHING could bring them
// back: `document.scrollWidth` equalled the viewport and no ancestor had
// `overflow-x: auto`. The app was allowing a window size its own primary
// actions fell out of.
//
// Two independent properties hold the fix, and they fail in opposite
// directions, so both are pinned:
//
//  1. The FLOOR. `minWindowWidth` must stay at or above the measured
//     requirement. Lower it and the overflow returns.
//  2. The GRIDS. Rows and option blocks must not use track/basis values that
//     can shrink below their own content. Fix the floor alone and a future
//     `grid-cols-2` reintroduces the collapse *above* the floor, where the
//     window size is no longer protecting anything.
//
// Source-level for the same reason as check:scroll-layout — jsdom has no layout
// engine, so nothing rendered here can observe a column collapsing or a control
// leaving the viewport. The widths below were measured in `npm run dev:web`
// against the real stylesheet; see docs/DECISIONS.md.
//
// Run with: npm run check:narrow-layout

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

const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

/** Measured in the browser preview against the real stylesheet:
 *  test detail's toolbar needs 688px of content pane, beside a 240px sidebar.
 *  Batch's widest row needs 678px. 928 is the binding requirement; the shipped
 *  floor carries a little slack over it. */
const MEASURED_REQUIREMENT = 928;

// ── 1. The floor ──────────────────────────────────────────────────────────
{
  const main = read("../../../main/index.ts");
  const m = main.match(/const\s+minWindowWidth\s*=\s*(\d+)/);
  assert(m !== null, "main/index.ts: declares minWindowWidth");
  if (m) {
    const width = Number(m[1]);
    assert(
      width >= MEASURED_REQUIREMENT,
      `main/index.ts: minWindowWidth (${width}) must be >= ${MEASURED_REQUIREMENT}, the widest toolbar's measured requirement — below it, "Run test" and "Run 0" leave the viewport with no horizontal scroll to reach them`,
    );
  }

  // The default must not sit below the floor, or the app opens at a size it
  // immediately clamps.
  const dm = main.match(/const\s+windowWidth\s*=\s*(\d+)/);
  if (m && dm) {
    assert(
      Number(dm[1]) >= Number(m[1]),
      `main/index.ts: default windowWidth (${dm[1]}) must be >= minWindowWidth (${m[1]})`,
    );
  }
}

// ── 2. The grids ──────────────────────────────────────────────────────────
{
  const detail = read("../../../renderer/main/test-detail-view.tsx");
  // Tailwind's `grid-cols-<n>` is `repeat(n, minmax(0, 1fr))`. The 0 floor is
  // the whole bug: it lets a column shrink under its own text, and these labels
  // are overflow:visible, so the text spills across its neighbour rather than
  // clipping. `auto` == minmax(min-content, max-content) — it still wraps, it
  // just cannot go under a word.
  const runOptions = detail.match(/<div className="grid grid-cols-\[[^\]]*\][^"]*gap-x-3[^"]*"/);
  assert(
    runOptions !== null,
    "test-detail-view.tsx: the run-options block uses explicit grid tracks, not `grid-cols-<n>` (whose minmax(0,1fr) lets a column shrink below its own text)",
  );
  assert(
    !/grid grid-cols-2 gap-x-3/.test(detail),
    "test-detail-view.tsx: the run-options block has not reverted to `grid-cols-2`",
  );

  const batch = read("../../../renderer/main/batch-view.tsx");
  // Every other cell in a batch row is shrink-0, so the flexible cell absorbs
  // the entire squeeze. With `min-w-0` that bottoms out at width:0 and the test
  // name disappears entirely rather than truncating.
  assert(
    !/className="min-w-0 flex-1 truncate text-left text-small font-medium/.test(batch),
    "batch-view.tsx: the row's test-name cell no longer uses a bare `min-w-0` basis — it collapsed to width:0 and the row lost its name",
  );
  const namedFloor = batch.match(/className="min-w-\d+ basis-\d+ grow truncate text-left/);
  assert(
    namedFloor !== null,
    "batch-view.tsx: the row's test-name cell carries a min-width floor so it truncates instead of vanishing",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll narrow-layout checks passed");
