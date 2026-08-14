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

// ── Panels nested inside a page-level ScrollArea ───────────────────────────
//
// The bug: the Stability panel wrapped its list in `<ScrollArea className=
// "max-h-72">`. The SDK's ScrollArea needs a DEFINITE height — its viewport
// sizes against the root — so a max-height alone left it with nothing to size
// against. Nothing clipped: the list overflowed its box and PAINTED OVER the
// "Show all" button and the Failure causes section below it, while the parent
// still laid those out as if the panel were 288px tall.
//
// Two rules, both source-level for the same reason as everything above: jsdom
// has no layout engine, so a rendered test sees overlapping elements as
// perfectly fine.
{
  const PANELS = [
    "../../../renderer/main/flake-panel.tsx",
    "../../../renderer/main/heals-view.tsx",
    "../../../renderer/main/heals-panel.tsx",
    "../../../renderer/main/variables-panel.tsx",
  ];

  for (const rel of PANELS) {
    const file = resolve(here, rel);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue; // a panel that no longer exists isn't a failure
    }
    const name = rel.split("/").pop();
    const tags = [...src.matchAll(/<ScrollArea[^>]*>/g)].map((m) => m[0]);

    for (const tag of tags) {
      // A max-height with no height is the exact shape that overflows.
      const maxOnly = /\bmax-h-/.test(tag) && !/className="[^"]*\bh-(?:full|\[|\d)/.test(tag);
      assert(
        !maxOnly,
        `${name}: ScrollArea uses max-h-* with no definite height — its content will overflow and paint over what follows`,
      );
    }
  }

  // The Stability panel specifically must not nest a scroller at all: it sits
  // inside the page ScrollArea, and expanding a row has to grow the panel
  // rather than scroll inside a fixed box.
  const flake = readFileSync(resolve(here, "../../../renderer/main/flake-panel.tsx"), "utf8");
  assert(
    !/<ScrollArea/.test(flake),
    "flake-panel.tsx: no nested ScrollArea — expanding a row must grow the panel, not scroll within it",
  );

  // Home's hero pane: centred content that must scroll rather than clip.
  //
  // It shipped as `absolute inset-0 … overflow-hidden`, which at a 720px window
  // cut off the last line of the intro copy with no way to reach it — the pane
  // could not scroll and the document behind it was already exactly viewport
  // height, so neither surface had anywhere to go.
  //
  // Two properties, and the second is the one that looks optional and is not.
  // `min-height: 100%` on the inner column is a FLOOR: short content still
  // centres, and tall content grows past it so `justify-content: center` has no
  // free space left to distribute — which is what stops a too-tall hero being
  // centred half off-screen with its top unreachable. Drop it and the overflow
  // silently becomes uncentred-and-clipped again, which no rendered test in
  // this repo can observe (jsdom has no layout engine).
  //
  // THE PROPERTIES MOVED, THE CONTRACT DID NOT. B1 reskinned this screen, so
  // the two rules are named classes in `renderer/theme/screens.css` rather than
  // Tailwind utilities in the markup. This reads them there — and still checks
  // the view USES both names, because a rule nothing carries is a guard that
  // passes over a screen it no longer describes.
  const home = readFileSync(resolve(here, "../../../renderer/main/home-view.tsx"), "utf8");
  const screens = readFileSync(resolve(here, "../../../renderer/theme/screens.css"), "utf8");

  /** One rule's body, comments already stripped. */
  function ruleBody(css: string, selector: string): string {
    const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(
      css.replace(/\/\*[\s\S]*?\*\//g, ""),
    );
    return m ? m[1] : "";
  }

  const pane = ruleBody(screens, ".gl-home");
  const col = ruleBody(screens, ".gl-home-col");

  assert(pane !== "", "screens.css: found the .gl-home hero pane rule");
  assert(col !== "", "screens.css: found the .gl-home-col centred column rule");
  assert(
    home.includes('className="gl-home"') && home.includes('className="gl-home-col"'),
    "home-view.tsx: still carries both class names — a rule the view does not use guards nothing",
  );
  assert(
    !/overflow\s*:\s*hidden/.test(pane),
    ".gl-home: not overflow-hidden — it clips its own copy at short window heights",
  );
  assert(
    /overflow-y\s*:\s*auto/.test(pane),
    ".gl-home: scrolls (overflow-y: auto), so content taller than the window stays reachable",
  );
  assert(
    /min-height\s*:\s*100%/.test(col) && /justify-content\s*:\s*center/.test(col),
    ".gl-home-col: `min-height: 100%` with `justify-content: center` — without the floor, overflowing content centres off-screen instead of scrolling",
  );
}

// ── The step list ──────────────────────────────────────────────────────────
//
// The bug: the detail view's Edit Steps editor drew its steps in a bare flex
// column with no scroll container anywhere in the screen. A test long enough
// to overflow the pane — which the two warning callouts above it make happen
// sooner, since they eat the same height — put its later steps below the
// bottom of the window with nothing able to reach them. Not clipped-with-a-
// scrollbar: the whole screen had ZERO scrollable elements, so the steps were
// simply gone. Dragging and deleting still worked on the rows you could see.
//
// Three properties, all source-level, and for the usual reason: jsdom has no
// layout engine, so a rendered test cannot tell a list that scrolls from one
// that runs off the end of the window.
{
  const stepRowSrc = readFileSync(resolve(here, "../../../renderer/main/step-row.tsx"), "utf8");

  /** Every view that draws the app's step rows. */
  const STEP_LISTS = [
    "../../../renderer/main/test-detail-view.tsx",
    "../../../renderer/main/edit-steps-view.tsx",
    "../../../renderer/main/recording-view.tsx",
    "../../../renderer/trainer/trainer-panel-view.tsx",
  ];

  for (const rel of STEP_LISTS) {
    const src = readFileSync(resolve(here, rel), "utf8");
    const name = rel.split("/").pop();

    assert(/<StepRow\b/.test(src), `${name}: still renders StepRow`);

    // One class for all four, so a list cannot be given the column's padding
    // and overflow behaviour in one view and not another.
    const at = src.indexOf('className="gl-step-list');
    assert(at > 0, `${name}: draws its steps in a .gl-step-list column`);
    if (at < 0) continue;

    // The container the list sits in has to be a real scroller. Matching the
    // nearest PRECEDING ScrollArea rather than any of them: these files hold
    // several (console output, the debug panel), and only this one is about
    // the steps.
    const before = src.slice(0, at);
    const open = before.lastIndexOf("<ScrollArea");
    assert(open >= 0, `${name}: the step list is inside a ScrollArea`);
    if (open < 0) continue;

    const tag = before.slice(open);
    assert(
      /scrollbars="both"/.test(tag),
      `${name}: the step list's ScrollArea allows BOTH axes — a step longer than the pane is reachable nowhere else`,
    );
  }

  // What the classes have to do, and the split between them is the load-bearing
  // part. `max-content` sizing belongs to the ROW: on the column it looks
  // equivalent and is not, because percentage widths inside then resolve
  // against the stretched column — which handed the trainer's step composer,
  // a form belonging to a 360px panel, the width of the longest step and put
  // half its controls off the edge (`e2e/panel-overflow.spec.ts`). The
  // padding-bottom is deliberate empty space below the last row: steps are
  // dragged to reorder and appended, and a list ending flush against the
  // bottom edge gives the final position no target.
  const shared = readFileSync(resolve(here, "../../../renderer/theme/shared.css"), "utf8");
  const noComments = shared.replace(/\/\*[\s\S]*?\*\//g, "");
  const listRule = /\.gl-step-list\s*\{([^}]*)\}/.exec(noComments)?.[1] ?? "";
  const rowRule = /\.gl-step-list-row\s*\{([^}]*)\}/.exec(noComments)?.[1] ?? "";

  assert(listRule !== "", "shared.css: found the .gl-step-list rule");
  assert(
    !/min-width\s*:\s*max-content/.test(listRule),
    ".gl-step-list: the column is NOT max-content — it stretches every non-row child with it, the composer included",
  );
  assert(
    /padding-bottom\s*:/.test(listRule),
    ".gl-step-list: carries an explicit tail, so the last row is never flush against the bottom edge",
  );
  assert(rowRule !== "", "shared.css: found the .gl-step-list-row rule");
  assert(
    /width\s*:\s*max-content/.test(rowRule),
    ".gl-step-list-row: `width: max-content` — without it a long step is ellipsed and there is nothing to scroll to",
  );
  assert(
    /min-width\s*:\s*100%/.test(rowRule),
    ".gl-step-list-row: short rows still fill the column — otherwise hover, selection and the status rail stop at the end of each row's own text",
  );
  assert(
    stepRowSrc.includes("gl-step-list-row"),
    "step-row.tsx: still carries gl-step-list-row — a rule nothing uses guards nothing",
  );

  // The rows all stretch to the widest step, so a row's own controls end up
  // past the right edge of the viewport. Sticky is what keeps the ✕ on a
  // short row reachable without a horizontal scroll it has no reason to need.
  const actionsRule =
    /\.gl-step-list\s+\.gl-step-row-actions\s*\{([^}]*)\}/.exec(noComments)?.[1] ?? "";
  assert(
    /position\s*:\s*sticky/.test(actionsRule) && /right\s*:\s*0/.test(actionsRule),
    ".gl-step-list .gl-step-row-actions: sticky to the right edge, or every row's controls sit off-screen once one step is long",
  );
  assert(
    stepRowSrc.includes("gl-step-row-actions"),
    "step-row.tsx: still carries gl-step-row-actions — a rule nothing uses guards nothing",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll scroll-layout checks passed");
