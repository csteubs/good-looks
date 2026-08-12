// Standalone regression check for the drift strip's "no reading" marker.
// REDESIGN §6.6.
//
// THE ONE THING THE DRIFT STRIP MUST NEVER DO IS SAY A FRAME WAS IDENTICAL IN A
// RUN THAT NEVER MEASURED IT. Both readings are drawn in the same 20px strip,
// both are small, and both sit in the same row of slots — so the difference
// between them is entirely a matter of a few pixels of geometry, and every way
// of erasing it is silent. The bars still render, the sentence beside them is
// still right, and the strip quietly claims eight clean comparisons that were
// never made.
//
// It shipped that way once already, in the preview: `MIN_BAR` at 0.06 of a 20px
// strip floors a measured bar at ONE PIXEL, which was indistinguishable from the
// one-pixel dash meaning "no reading". Nothing caught it — `baseline-drift.ts`'s
// own tests assert `barHeight` returns null rather than a number, which is
// correct and says nothing about whether the two look alike.
//
// This is at source level because nothing else can reach it. jsdom has no layout
// engine, and the `dom` Vitest project runs with `css: false`, so the whole
// stylesheet could be deleted and every rendered test would still pass. Two
// properties are pinned, and BOTH are needed — either alone still leaves two
// dashes sitting on the same baseline:
//
//   1. A floored bar is thick enough to read as a bar.
//   2. The gap marker does NOT sit on the floor, so it cannot be mistaken for a
//      zero-height bar.
//
// No test runner exists for these (see package.json) — plain assertions + a
// non-zero exit code stand in for one. Run with:
//   npm run check:drift-gap

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// ── 1. A floored bar is a bar ────────────────────────────────────────

const lib = read("renderer/lib/baseline-drift.ts");
const css = read("renderer/theme/screens.css");

const stripHeight = Number(
  /\.gl-drift-strip\s*\{[^}]*?\bheight:\s*(\d+)px/s.exec(css)?.[1] ?? NaN,
);
assert(Number.isFinite(stripHeight), "screens.css: .gl-drift-strip declares a pixel height");

const minBar = Number(/export const MIN_BAR\s*=\s*([\d.]+)/.exec(lib)?.[1] ?? NaN);
assert(Number.isFinite(minBar), "baseline-drift.ts: exports a numeric MIN_BAR");

// Two device pixels at 1x. Below this the floor is a hairline, which is what a
// gap marker is — and the point of the floor is to not be one.
const flooredPx = minBar * stripHeight;
assert(
  flooredPx >= 2,
  `MIN_BAR floors a measured bar at ${flooredPx.toFixed(1)}px of a ${stripHeight}px strip — ` +
    "at that size it is indistinguishable from the 'no reading' dash",
);

// ── 2. The gap marker is off the floor ───────────────────────────────

const gapRule = /\.gl-drift-gap\s*\{([^}]*)\}/s.exec(css)?.[1] ?? "";
assert(gapRule.length > 0, "screens.css: defines .gl-drift-gap");

// The slots are `align-items: flex-end`, so a marker with no bottom offset sits
// exactly where a bar's base sits.
const gapLift = Number(/margin-bottom:\s*(\d+)px/.exec(gapRule)?.[1] ?? 0);
assert(
  gapLift >= 3,
  `.gl-drift-gap sits ${gapLift}px off the floor — on the baseline it reads as a ` +
    "zero-height bar, i.e. 'this frame was identical', which is a claim nobody made",
);

// ── 3. The component still tells the two apart at all ────────────────
//
// The geometry above is worthless if the view stops branching on `null`. This is
// the one part a rendered test could observe, and it is cheap to pin here beside
// the two parts that cannot be.

const view = read("renderer/main/visual-view.tsx");
assert(
  /gl-drift-gap/.test(view) && /gl-drift-bar/.test(view),
  "visual-view.tsx: renders both a bar and a gap element",
);
assert(
  /h === null \?/.test(view),
  "visual-view.tsx: branches on a null bar height rather than drawing every point as a bar",
);

// ── Result ───────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall drift-gap checks passed");
