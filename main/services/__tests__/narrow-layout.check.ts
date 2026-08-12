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

  // The bug, measured in `npm run dev:web` at 1440x900 — NOT a narrow window,
  // which is why the floor in §1 never protected it. Visual's header is one
  // flex row: a `min-w-0 flex-1` title column, then Re-run, Masks & baselines,
  // the threshold slider and the pager, all `shrink-0`. Those four take ~1000px
  // of a 1140px pane, so the title column is squeezed to 141px while its own
  // content needs 168px.
  //
  // Inside it the test name truncates away to nothing and the two `shrink-0`
  // badges — "passed" and "1 visual change" — spill past the column's right
  // edge. `elementFromPoint` at the end of the word returned the Re-run BUTTON:
  // the outcome was being painted underneath a control, unreadable.
  //
  // WRAPPING IS THE FIX, not a floor and not `overflow: hidden`.
  //  • A floor big enough for both badges (~240px) overflows the header at this
  //    app's own minimum window size, which is the §1 bug reintroduced above
  //    the floor — exactly what that section warns about.
  //  • `overflow: hidden` stops the overlap and still eats the word, and a
  //    status chip that silently drops its last word is the failure DECISIONS
  //    records for `.gl-status-chip` on 2026-08-09. The name is the cell that
  //    may give; the result never is.
  //
  // Source-level for this file's usual reason: jsdom has no layout engine, so
  // nothing rendered in a test can observe a badge painted under a button.
  const headerRow = visual.match(/\{\s*\/\* Header \*\/\s*\}\s*([\s\S]{0,900})/);
  assert(headerRow !== null, "visual-view.tsx: found the run header block");
  if (headerRow) {
    // Anchored on the row's CONTENT — the div wrapping the test name — rather
    // than on a class substring. Keying the match off `flex items-center` made
    // this assertion vanish the moment the fix reordered the class list, which
    // is a guard that reports "ok" by no longer looking at anything.
    const identity = headerRow[1].match(
      /<div className="([^"]*)">\s*<Text className="[^"]*">\{replay\.testName\}/,
    );
    assert(identity !== null, "visual-view.tsx: found the header's identity row (name + badges)");
    if (identity) {
      const cls = identity[1];
      assert(
        /\bflex-wrap\b/.test(cls),
        `visual-view.tsx: the header's identity row wraps (got "${cls}") — without it the status badges are pushed out of the title column and painted under the Re-run button`,
      );
      assert(
        /\bmin-w-0\b/.test(cls),
        `visual-view.tsx: the header's identity row carries \`min-w-0\` (got "${cls}") so the name can truncate inside it rather than forcing the row wider than its column`,
      );
    }
    assert(
      !/\boverflow-hidden\b/.test(headerRow[1]),
      "visual-view.tsx: the header does not clip its identity row — hiding the overlap would still swallow the badge's last word",
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll narrow-layout checks passed");
