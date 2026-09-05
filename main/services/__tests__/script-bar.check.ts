// Standalone regression check for the script tab's action bar.
//
// The original bug: `.gl-detail-script-bar` carried 12px of horizontal padding
// while `Toolbar` (the bar above it, holding "Run test") carries Tailwind's
// `px-4` (16px). Both bars right-align their primary button, so the 4px gap put
// Edit script's right edge inside of Run test's rather than under it. The bar
// also padded 6px above and below a button that is a fixed 30px tall regardless
// — padding not tied to its content, which is what "extra canvas" meant.
//
// Three more contracts landed with the 2026-09-05 restyle, each a failure that
// renders perfectly in every jsdom test:
//
//  1. THE TWO BANDS ARE DISTINCT. `.gl-detail-tabs` padded 8px above the
//     tablist and NOTHING below it, so the script bar's own 4px was the entire
//     gutter between a 26px hairline box and a row of 30px hairline boxes on
//     the same ground — two bands of controls reading as one row.
//  2. THE BAR DOES NOT CLIP ITS OWN BUTTON. Tailwind's preflight makes every
//     box border-box, so a `max-height` has to cover the padding and the bottom
//     hairline as well as the 30px button; the 38px this shipped with was one
//     pixel short. Derived here from the numbers rather than hardcoded, so
//     raising the padding fails against the "condensed" cap instead of
//     silently clipping again.
//  3. PROXIMITY SAYS WHAT GROUPS. A readout between two buttons splits a row
//     that reads as one — "Types ready" sat between Outline and Explain
//     failure. The arrangement that fixes it only works while the gap between
//     clusters stays visibly wider than the gap inside one, so the two numbers
//     are compared rather than asserted individually.
//
// Source-level for the same reason as check:narrow-layout: jsdom has no layout
// engine, so nothing rendered here can observe a button's right edge lining up
// with the one above it, a hairline between two bands, or one gap reading as
// wider than another. The DOM half — that no readout is a button's neighbour —
// is "the script bar's clusters" in renderer/main/test-detail-view.test.tsx.
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
const primitives = read("../../../renderer/theme/primitives.css");

/** One rule's body, by full class name. Handles a grouped selector — the two
 *  halves of the bar share one rule — and refuses a prefix match, so asking
 *  for `.gl-script-live` cannot answer with `.gl-script-live-status`. */
function ruleBody(className: string, css: string = screens): string | null {
  const m = css.match(
    new RegExp(`(?:^|[\\n,])\\s*\\.${className}(?![\\w-])\\s*(?:,[^{]*)?\\{([^}]*)\\}`),
  );
  return m ? m[1] : null;
}

/** A `padding` shorthand's four sides, CSS's own 1/2/3/4-value rule. */
function sides(shorthand: string): number[] | null {
  const parts = shorthand.trim().split(/\s+/);
  const px = parts.map((p) => (/^-?\d+(\.\d+)?px$/.test(p) ? Number.parseFloat(p) : /^0$/.test(p) ? 0 : NaN));
  if (px.some(Number.isNaN)) return null;
  if (px.length === 1) return [px[0], px[0], px[0], px[0]];
  if (px.length === 2) return [px[0], px[1], px[0], px[1]];
  if (px.length === 3) return [px[0], px[1], px[2], px[1]];
  if (px.length === 4) return px;
  return null;
}

function gapOf(className: string): number | null {
  const body = ruleBody(className);
  const m = body?.match(/(?:^|[\s;])gap:\s*(\d+(?:\.\d+)?)px/);
  return m ? Number.parseFloat(m[1]) : null;
}

// ── the markup still carries the classes the CSS below describes ──────────
assert(
  /className="gl-detail-script-bar"/.test(detail),
  "test-detail-view.tsx: the script tab's action row still carries `gl-detail-script-bar`",
);
for (const name of ["gl-script-bar-left", "gl-script-bar-right", "gl-script-bar-status", "gl-script-group"]) {
  assert(
    detail.includes(`className="${name}"`),
    `test-detail-view.tsx: the script bar still builds its clusters from \`${name}\``,
  );
}

// ── 1. the tab strip is its own band ─────────────────────────────────────
const tabs = ruleBody("gl-detail-tabs");
assert(tabs !== null, "screens.css: found the .gl-detail-tabs rule");
if (tabs) {
  // The hairline is the whole point: it is what makes the tab strip and the
  // script bar read as two bands rather than one undifferentiated row of
  // controls. `.gl-run-head` closes itself the same way.
  assert(
    /border-bottom:\s*1px\s+solid\s+var\(--gl-line\)/.test(tabs),
    ".gl-detail-tabs: closed by a hairline, so the strip and the bar below are two bands",
  );
  const tabsPad = tabs.match(/(?:^|[\s;])padding:\s*([^;]+);/);
  assert(tabsPad !== null, ".gl-detail-tabs: declares padding");
  const tabsSides = tabsPad ? sides(tabsPad[1]) : null;
  assert(tabsSides !== null, ".gl-detail-tabs: its padding is a shorthand in px");
  if (tabsSides) {
    assert(
      tabsSides[2] > 0,
      `.gl-detail-tabs: pads BELOW the tablist too (got ${tabsSides[2]}px) — with 0 there, the bar's own 4px was the whole gutter`,
    );
  }
}

// ── 2. the bar is condensed, and does not clip what it wraps ─────────────
const bar = ruleBody("gl-detail-script-bar");
assert(bar !== null, "screens.css: found the .gl-detail-script-bar rule");

if (bar) {
  // Toolbar (renderer/ui/layout.tsx) pads with Tailwind's `px-4`, which is
  // 16px. This bar sits directly below it and right-aligns its own button, so
  // matching that number is what puts Edit script's right edge under Run
  // test's rather than 4px inside of it.
  const padding = bar.match(/(?:^|[\s;])padding:\s*([^;]+);/);
  assert(padding !== null, ".gl-detail-script-bar: declares padding");
  const barSides = padding ? sides(padding[1]) : null;
  if (padding) {
    assert(
      /(^|\s)16px($|\s)/.test(padding[1].trim()) || /\b16px\s+16px\b/.test(padding[1]),
      `.gl-detail-script-bar: horizontal padding is 16px, matching Toolbar's \`px-4\` (got "${padding[1].trim()}")`,
    );
  }

  // The bar's children are `.gl-btn`, fixed at 30px tall (primitives.css). A
  // max-height keeps the bar from ever growing past that button again, which
  // is the "condensed" contract: this row's height is its content's height.
  assert(
    /max-height:\s*\d+px/.test(bar),
    ".gl-detail-script-bar: declares an explicit max-height",
  );
  const maxHeight = bar.match(/max-height:\s*(\d+)px/);
  if (maxHeight) {
    assert(
      Number(maxHeight[1]) <= 40,
      `.gl-detail-script-bar: max-height (${maxHeight[1]}px) stays close to the 30px button it wraps, not loose "extra canvas"`,
    );

    // …and no closer. Tailwind's preflight is border-box, so the max-height
    // bounds the padding and the bottom hairline as well as the button —
    // 38px around 4 + 30 + 4 + 1 clipped the button by a pixel for its whole
    // life. Derived, so raising the padding trips the cap above rather than
    // reintroducing the clip.
    const btn = ruleBody("gl-btn", primitives);
    const btnHeight = btn?.match(/height:\s*(\d+)px/);
    assert(btnHeight !== null && btnHeight !== undefined, "primitives.css: .gl-btn declares a fixed height");
    const hairline = /border-bottom:\s*1px/.test(bar) ? 1 : 0;
    if (btnHeight && barSides) {
      const floor = barSides[0] + Number(btnHeight[1]) + barSides[2] + hairline;
      assert(
        Number(maxHeight[1]) >= floor,
        `.gl-detail-script-bar: max-height (${maxHeight[1]}px) covers ${barSides[0]} + ${btnHeight[1]} + ${barSides[2]} + ${hairline} = ${floor}px of border-box content, so it does not clip its own button`,
      );
    }
  }
}

// ── 3. proximity says what groups ────────────────────────────────────────
const clusterGap = gapOf("gl-detail-script-bar");
const groupGap = gapOf("gl-script-group");
assert(clusterGap !== null, ".gl-detail-script-bar: declares the gap BETWEEN clusters");
assert(groupGap !== null, ".gl-script-group: declares the gap INSIDE a cluster");
if (clusterGap !== null && groupGap !== null) {
  // Two buttons 6px apart inside a cluster 20px from the next one read as a
  // pair; at the same number they read as one undifferentiated run, which is
  // the row this restyle broke up. The margin has to be visible, not nominal.
  assert(
    clusterGap >= groupGap * 2,
    `the gap between clusters (${clusterGap}px) is at least twice the gap inside one (${groupGap}px), so proximity alone says which controls belong together`,
  );
}
assert(ruleBody("gl-script-bar-status") !== null, "screens.css: the readouts have their own zone (.gl-script-bar-status)");

// ── 4. one thing places the clusters, not four fighting margins ──────────
// `.gl-script-live` and `.gl-script-check-msg` each claimed `margin-right:
// auto` while the bar right-aligned everything, so the whole left-hand cluster
// slid sideways the moment the caret readout appeared. `space-between` over
// two halves places them now; an auto margin anywhere inside is that bug
// coming back.
assert(
  /justify-content:\s*space-between/.test(bar ?? ""),
  ".gl-detail-script-bar: places its two halves with `space-between`",
);
for (const name of [
  "gl-detail-script-bar",
  "gl-script-bar-left",
  "gl-script-bar-right",
  "gl-script-bar-status",
  "gl-script-group",
  "gl-script-live",
  "gl-script-live-status",
  "gl-script-check-msg",
]) {
  const body = ruleBody(name);
  assert(
    body !== null && !/margin(-(left|right|inline(-(start|end))?))?:[^;]*\bauto\b/.test(body),
    `.${name}: claims no auto side margin — two of them is what made the left cluster jump`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll script-bar checks passed.");
}
