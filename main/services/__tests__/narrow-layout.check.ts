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
//
// `MEASURED_REQUIREMENT` IS IN CSS PIXELS, which is the unit the toolbar was
// measured in and NOT the unit a window is sized in. Those were the same number
// until the interface-scale setting shipped; they are not any more, and the
// difference runs the wrong way — a floor of 960 POINTS is 768 CSS pixels at
// 125%, comfortably under the requirement below, so the guarantee would lapse
// at exactly the setting someone turns up because they cannot read the app.
//
// So `main/index.ts` now wraps each of these in `scaled(...)`, and this check
// reads the CSS-pixel argument out of the wrapper. Both spellings are accepted:
// the point is the number, and a bare literal is still correct at 100%. What is
// NOT acceptable is the regex quietly matching neither — a floor it cannot find
// is a floor it cannot judge — which is what the `m !== null` assert is for.
{
  const main = read("../../../main/index.ts");
  /** `= 960` or `= scaled(960)` — the CSS-pixel measurement either way. */
  const cssPixels = (name: string): number | null => {
    const m = main.match(new RegExp(`const\\s+${name}\\s*=\\s*(?:scaled\\()?(\\d+)`));
    return m ? Number(m[1]) : null;
  };

  const width = cssPixels("minWindowWidth");
  assert(width !== null, "main/index.ts: declares minWindowWidth");
  if (width !== null) {
    assert(
      width >= MEASURED_REQUIREMENT,
      `main/index.ts: minWindowWidth (${width}) must be >= ${MEASURED_REQUIREMENT}, the widest toolbar's measured requirement — below it, "Run test" and "Run 0" leave the viewport with no horizontal scroll to reach them`,
    );
  }

  // The default must not sit below the floor, or the app opens at a size it
  // immediately clamps.
  const dflt = cssPixels("windowWidth");
  if (width !== null && dflt !== null) {
    assert(
      dflt >= width,
      `main/index.ts: default windowWidth (${dflt}) must be >= minWindowWidth (${width})`,
    );
  }

  // And the floor has to REACH the window as a scaled value. Declaring it in
  // CSS pixels and then handing the raw number to `new BrowserWindow` would
  // pass every assertion above while shipping the bug they describe.
  assert(
    /minWidth:\s*minWindowWidth/.test(main) && /const\s+minWindowWidth\s*=\s*scaled\(/.test(main),
    "main/index.ts: the window's minWidth is the CSS-pixel floor put through scaled()",
  );
  assert(
    /attachUiScale\(mainWindow,\s*\{/.test(main),
    "main/index.ts: the main window hands its floor to attachUiScale, so a scale change re-applies it",
  );
}

// ── 2. The grids ──────────────────────────────────────────────────────────
{
  const detail = read("../../../renderer/main/test-detail-view.tsx");
  const screens = read("../../../renderer/theme/screens.css");

  // MOVED INTO screens.css IN B5a, and this check moved with it — same shape as
  // `.gl-home` (B1) and `.gl-batch-name` (B3). Two assertions rather than one,
  // because a rule that resolves and a view that uses it are separate facts:
  // renaming the class in the .tsx leaves this rule perfect and unreferenced,
  // and it would still pass a check that only read the stylesheet.
  const runOptions = screens.match(/\.gl-run-options\s*\{([^}]*)\}/);
  assert(runOptions !== null, "screens.css: found the .gl-run-options rule");
  assert(
    /className="gl-run-options"/.test(detail),
    "test-detail-view.tsx: the run-options block still carries `gl-run-options`",
  );
  if (runOptions) {
    const body = runOptions[1];
    // The 0 floor in `minmax(0, 1fr)` is the whole bug: it lets a column shrink
    // under its own text, and these labels are overflow:visible, so the text
    // spills across its neighbour rather than clipping. `auto` ==
    // minmax(min-content, max-content) — it still wraps, it just cannot go
    // under a word.
    const tracks = body.match(/grid-template-columns:\s*([^;]+);/);
    assert(tracks !== null, ".gl-run-options: declares its column tracks explicitly");
    if (tracks) {
      assert(
        /\bauto\b/.test(tracks[1]) && !/1fr/.test(tracks[1]),
        `.gl-run-options: tracks are content-sized, not \`1fr\` (got "${tracks[1].trim()}") — a fractional track floors at zero and lets a label paint across its neighbour`,
      );
      // `max-content` forbids wrapping outright, which pushed the toolbar's own
      // minimum past this window's DEFAULT width — a rare overlap traded for a
      // guaranteed one.
      assert(
        !/max-content/.test(tracks[1]),
        ".gl-run-options: tracks are not `max-content`, which forbids wrapping and pushes the toolbar wider than the default window",
      );
    }
  }
  assert(
    !/grid-cols-2|grid-cols-\[/.test(detail),
    "test-detail-view.tsx: the run-options block has not gone back to a Tailwind grid utility",
  );

  const batch = read("../../../renderer/main/batch-view.tsx");

  // Every other cell in a batch row is fixed-width, so the flexible cell absorbs
  // the entire squeeze. Without a floor that bottoms out at width:0 and the test
  // name disappears entirely rather than truncating — a row with no name at all,
  // which makes the checkbox beside it meaningless.
  //
  // THE PROPERTY MOVED, THE CONTRACT DID NOT. B3 reskinned this screen, so the
  // floor is a named rule in `renderer/theme/screens.css` rather than a Tailwind
  // class in the markup. This reads it there, and still checks the view carries
  // the class — a rule nothing uses is a guard that passes over a row it no
  // longer describes.
  const nameRule = screens.replace(/\/\*[\s\S]*?\*\//g, "").match(/\.gl-batch-name\s*\{([^}]*)\}/);
  assert(nameRule !== null, "screens.css: found the .gl-batch-name rule");
  assert(
    /className="gl-batch-name"/.test(batch),
    "batch-view.tsx: the row's test-name cell still carries `gl-batch-name`",
  );
  assert(
    nameRule !== null && /min-width:\s*(\d+)px/.test(nameRule[1]),
    ".gl-batch-name: carries a min-width floor so the name truncates instead of vanishing",
  );
  assert(
    nameRule !== null && !/min-width:\s*0\b/.test(nameRule[1]),
    ".gl-batch-name: the floor is not zero — `min-width: 0` is the bug, not the fix",
  );
}

// ── 3. Visual's run header ────────────────────────────────────────────────
{
  const visual = read("../../../renderer/main/visual-view.tsx");
  const screens = read("../../../renderer/theme/screens.css").replace(/\/\*[\s\S]*?\*\//g, "");

  // TWO BUGS OF ONE KIND, both measured in `npm run dev:web` at ordinary window
  // sizes — NOT narrow ones, which is why the floor in §1 protected neither.
  //
  // The first, 2026-08-11: the header was one flex row with a `min-w-0 flex-1`
  // title column followed by Re-run, Masks & baselines, the threshold and the
  // pager, all `shrink-0`. Those four took ~1000px of a 1140px pane, the title
  // column was squeezed to 141px against 168px of content, and the two badges —
  // "passed" and "1 visual change" — spilled past its right edge.
  // `elementFromPoint` at the end of the word returned the Re-run BUTTON: the
  // outcome was being painted underneath a control, unreadable.
  //
  // The second, in this screen's full reskin: with the name moved into the
  // panel header, the tool group was a single rigid item wider than the panel
  // on any window under about 1500px, and the LAST control — "Masks &
  // baselines" — was simply clipped off the edge. Present in the DOM, nothing
  // to scroll, impossible to click.
  //
  // WRAPPING IS THE FIX BOTH TIMES, not a floor and not `overflow: hidden`.
  //  • A floor big enough for the controls overflows the header at this app's
  //    own minimum window size, which is the §1 bug reintroduced above the
  //    floor — exactly what that section warns about.
  //  • `overflow: hidden` stops the overlap and still eats the content, and a
  //    status chip that silently drops its last word is the failure DECISIONS
  //    records for `.gl-status-chip` on 2026-08-09. The test NAME is the cell
  //    that may give — it lives in the panel header's `id` slot, which is
  //    documented to truncate. The result and the controls never are.
  //
  // Source-level for this file's usual reason: jsdom has no layout engine, so
  // nothing rendered in a test can observe a chip painted under a button or a
  // control clipped off a panel.
  assert(
    /className="gl-visual-head"/.test(visual),
    "visual-view.tsx: found the run's tool band (.gl-visual-head)",
  );
  // The name is in the slot that is allowed to truncate, and nowhere else.
  assert(
    /<Panel\b[^>]*\bid=\{replay\.testName\}/s.test(visual),
    "visual-view.tsx: the test name sits in the panel header's `id` slot, which is the one cell in this design that may give",
  );
  // And the outcome is a StatusChip, which `check:status-width` already pins as
  // unshrinkable — so the row cannot take the verdict's width back.
  assert(
    /<StatusChip tone=\{replay\.status === "passed"/.test(visual),
    "visual-view.tsx: the run's verdict is a StatusChip, whose width a flex row may not reclaim",
  );

  const headRule = screens.match(/\.gl-visual-head\s*\{([^}]*)\}/);
  assert(headRule !== null, "screens.css: found the .gl-visual-head rule");
  if (headRule) {
    assert(
      /flex-wrap:\s*wrap/.test(headRule[1]),
      "`.gl-visual-head` wraps — without it the verdict chips are pushed out of the band and painted under the controls",
    );
    assert(
      !/overflow:\s*hidden/.test(headRule[1]),
      "`.gl-visual-head` does not clip — hiding the overlap would still swallow the chip's last word",
    );
  }

  const toolsRule = screens.match(/\.gl-visual-head-tools\s*\{([^}]*)\}/);
  assert(toolsRule !== null, "screens.css: found the .gl-visual-head-tools rule");
  if (toolsRule) {
    assert(
      /flex-wrap:\s*wrap/.test(toolsRule[1]),
      "`.gl-visual-head-tools` wraps — as one rigid item it is wider than the panel under ~1500px and its last control is clipped off the edge",
    );
    assert(
      !/flex:\s*0\s+0/.test(toolsRule[1]),
      "`.gl-visual-head-tools` is not a rigid item — `flex: 0 0 auto` is the shape that clipped `Masks & baselines` off the panel",
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll narrow-layout checks passed");
