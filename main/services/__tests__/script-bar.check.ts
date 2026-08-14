// Standalone regression check for the script tab's action bar.
//
// The bug: `.gl-detail-script-bar` carried 12px of horizontal padding while
// `Toolbar` (the bar above it, holding "Run test") carries Tailwind's `px-4`
// (16px). Both bars right-align their primary button, so the 4px gap put Edit
// script's right edge inside of Run test's rather than under it. The bar also
// padded 6px above and below a button that is a fixed 30px tall regardless —
// padding not load-bearing for its content, which is what "extra canvas" meant.
//
// Source-level for the same reason as check:narrow-layout: jsdom has no layout
// engine, so nothing rendered here can observe a button's right edge lining up
// with the one above it.
//
// Run with: npm run check:script-bar

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

const detail = read("../../../renderer/main/test-detail-view.tsx");
const screens = read("../../../renderer/theme/screens.css");

assert(
  /className="gl-detail-script-bar"/.test(detail),
  "test-detail-view.tsx: the script tab's action row still carries `gl-detail-script-bar`",
);

const bar = screens.match(/\.gl-detail-script-bar\s*\{([^}]*)\}/);
assert(bar !== null, "screens.css: found the .gl-detail-script-bar rule");

if (bar) {
  const body = bar[1];

  // Toolbar (renderer/ui/layout.tsx) pads with Tailwind's `px-4`, which is
  // 16px. This bar sits directly below it and right-aligns its own button, so
  // matching that number is what puts Edit script's right edge under Run
  // test's rather than 4px inside of it.
  const padding = body.match(/padding:\s*([^;]+);/);
  assert(padding !== null, ".gl-detail-script-bar: declares padding");
  if (padding) {
    assert(
      /(^|\s)16px($|\s)/.test(padding[1].trim()) || /\b16px\s+16px\b/.test(padding[1]),
      `.gl-detail-script-bar: horizontal padding is 16px, matching Toolbar's \`px-4\` (got "${padding[1].trim()}")`,
    );
  }

  // The bar's one child is `.gl-btn`, fixed at 30px tall (primitives.css). A
  // max-height keeps the bar from ever growing past that button again, which
  // is the "condensed" contract: this row's height is its content's height.
  assert(
    /max-height:\s*\d+px/.test(body),
    ".gl-detail-script-bar: declares an explicit max-height",
  );
  const maxHeight = body.match(/max-height:\s*(\d+)px/);
  if (maxHeight) {
    assert(
      Number(maxHeight[1]) <= 40,
      `.gl-detail-script-bar: max-height (${maxHeight[1]}px) stays close to the 30px button it wraps, not loose "extra canvas"`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll script-bar checks passed.");
}
