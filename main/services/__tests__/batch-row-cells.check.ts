// A checklist row is the same size whether or not it is in the job.
//
// WHY THIS IS A CHECK. Three of the row's cells exist only on a ticked row —
// the structure mark, the after mark and the failure policy — and each one
// leaves a SPACER behind when it goes, so the columns after it do not move.
// That was already the design; the spacers were already there; two of them were
// simply the wrong size, and the third had no height at all. The result was a
// checklist that changed shape when you ticked a box: every cell after the
// marks slid 8px left, and each row collapsed from 33px to 27px, so selecting
// all visibly resized the whole list. Reported from the running app, because
// nothing here could see it.
//
// Nothing else in the toolchain can. jsdom has no layout engine, so a width or
// height assertion in a component test passes against zeros (CLAUDE.md), and
// the dom project runs with `css: false`, so there is no cascade to ask. The
// component test beside this one pins that the spacer EXISTS; only source can
// say it is the right size.
//
// The coupling this really guards is cross-file: the marks take their width
// from a `width={N}` prop in batch-view.tsx, and `.gl-menu-root`'s own
// `flex: 0 0 auto` beats any basis the stylesheet states for them — so the
// number in the CSS rule for a mark is INERT and only the spacer obeys it. Two
// numbers in two files, one of which cannot fail loudly, is exactly the shape
// that drifted.
//
// Run with: npm run check:batch-row-cells

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const VIEW = join(root, "renderer/main/batch-view.tsx");
// BOTH sheets, because the two layers genuinely split this: the row's own cells
// are the screen's (screens.css) and the mark's box is the primitive's
// (primitives.css). Reading only the first is what made the mark look sizeless.
const SHEETS = ["renderer/theme/screens.css", "renderer/theme/primitives.css"].map((f) =>
  join(root, f),
);

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const view = readFileSync(VIEW, "utf8");
const css = SHEETS.map((f) => readFileSync(f, "utf8")).join("\n");

/** The declarations of one class's own rule (`.foo { … }`), comments stripped.
 *  Deliberately only the rule whose selector is exactly this class: a rule that
 *  reaches the element some other way is not what a reader of this file would
 *  find, and this check is about what the stylesheet SAYS. */
function ruleFor(cls: string): string | null {
  const re = new RegExp(`(^|\\})\\s*\\.${cls}\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[2].replace(/\/\*[\s\S]*?\*\//g, "") : null;
}

function pxOf(decls: string, prop: "flex" | "height"): number | null {
  const re =
    prop === "flex"
      ? /flex:\s*\d+\s+\d+\s+(\d+(?:\.\d+)?)px/
      : /(?:^|;)\s*height:\s*(\d+(?:\.\d+)?)px/;
  const m = re.exec(decls);
  return m ? Number(m[1]) : null;
}

/** The `width={N}` a Menu carrying this class is given in the view. The prop and
 *  the class sit in the same JSX element, so the window between them is small
 *  and fixed; anchoring on the class keeps this readable when a third mark
 *  appears. */
function menuWidthFor(cls: string): number | null {
  const at = view.indexOf(`className="${cls}"`);
  if (at < 0) return null;
  const window = view.slice(Math.max(0, at - 400), at);
  const all = [...window.matchAll(/width=\{(\d+)\}/g)];
  const last = all[all.length - 1];
  return last ? Number(last[1]) : null;
}

// ── 1. Every optional cell has a spacer, and the view still uses it ──────
//
// The failure this catches is the cheapest one to reintroduce: deleting the
// `: (<span …/>)` arm during an edit leaves a perfectly working row that
// silently slides its own columns.
const PAIRS = [
  { control: "gl-batch-groupmark", gap: "gl-batch-group-gap", kind: "menu" as const },
  { control: "gl-batch-aftermark", gap: "gl-batch-waitmark-gap", kind: "menu" as const },
  { control: "gl-batch-policy", gap: "gl-batch-policy-gap", kind: "button" as const },
];

for (const { control, gap } of PAIRS) {
  assert(
    view.includes(`className="${control}"`) && view.includes(`className="${gap}"`),
    `${control} is still paired with ${gap} in batch-view.tsx`,
  );
}

// ── 2. The spacer matches its control's WIDTH ────────────────────────────
for (const { control, gap, kind } of PAIRS) {
  const gapDecls = ruleFor(gap);
  const gapW = gapDecls ? pxOf(gapDecls, "flex") : null;
  // A menu's real width comes from the prop; a plain button's from its own rule,
  // which for that one is not overridden by anything.
  const controlW =
    kind === "menu" ? menuWidthFor(control) : pxOf(ruleFor(control) ?? "", "flex");
  assert(
    gapW !== null && controlW !== null && gapW === controlW,
    gapW === controlW
      ? `.${gap} is ${gapW}px wide, the same as ${control}`
      : `.${gap} is ${gapW}px but ${control} is ${controlW}px — every cell after it ` +
        `slides by the difference on an unticked row`,
  );
}

// ── 3. …and its HEIGHT ──────────────────────────────────────────────────
//
// The half that was missing entirely. An empty <span> is 0 tall, the row is
// `align-items: center` over its tallest cell, so a row with no marks was
// shorter than a row with them and the list resized as you ticked.
for (const { control, gap, kind } of PAIRS) {
  const gapH = pxOf(ruleFor(gap) ?? "", "height");
  const controlH =
    kind === "menu"
      ? pxOf(ruleFor("gl-menu-trigger") ?? "", "height")
      : pxOf(ruleFor(control) ?? "", "height");
  assert(
    gapH !== null && controlH !== null && gapH === controlH,
    gapH === controlH
      ? `.${gap} is ${gapH}px tall, the same as ${control}`
      : `.${gap} declares height ${gapH === null ? "nothing" : `${gapH}px`} but ` +
        `${control} is ${controlH}px tall — the row shrinks when the control is gone`,
  );
}

// ── 4. The primary action has a floor ───────────────────────────────────
//
// Its label carries the selection count and Stop replaces it outright, so
// without a floor the toolbar's width tracks whatever happens to be ticked —
// the same failure `.gl-detail-run` was given a floor for.
{
  const decls = ruleFor("gl-batch-run") ?? "";
  const min = /min-width:\s*(\d+)px/.exec(decls);
  assert(Boolean(min), "the batch's Run/Stop button has a min-width floor");
  const runs = [...view.matchAll(/className="gl-batch-run"/g)].length;
  assert(
    runs >= 2,
    runs >= 2
      ? "both Run and Stop carry the floor"
      : `only ${runs} of the two buttons in that slot carries gl-batch-run — the ` +
        `other one resizes the toolbar when a run starts`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll batch-row-cell checks passed.");
