// Standalone regression check for the dialog footer's overflow contract.
//
// The bug: `DialogFooter` was a nowrap `flex items-center justify-end` row of
// `whitespace-nowrap` buttons. Nothing in it can shrink, and `justify-end`
// anchors the row's END to the container — so when the buttons did not fit, the
// surplus hung off the LEFT. In the trainer panel the exit dialog's
// "Discard Edits" was laid out outside the dialog entirely, painted over the
// step list behind it, on both the Discard and the Save Test paths.
//
// Three properties hold the fix, and they fail independently:
//
//  1. The ROW WRAPS. This is the half that survives someone adding a button
//     back — explicitly allowed, and the reason removing Cancel is not on its
//     own a fix: it buys headroom until the next label is longer.
//  2. NO CANCEL. Every composed dialog renders the close "X" (Radix also closes
//     on Escape and on the overlay), so Cancel was a third way to do one thing
//     costing ~75px of a 264px row.
//  3. The ARITHMETIC the real-layout test reconstructs. `e2e/dialog-footer.spec.ts`
//     measures the footer at 296px because the trainer panel is `PANEL_WIDTH`
//     360 DIP and the dialog is `w-[calc(100vw-4rem)]`. Change either and that
//     test keeps passing against a box the app never renders — a green suite
//     measuring the wrong thing, which is worse than a red one.
//
// Source-level for the same reason as check:scroll-layout and
// check:narrow-layout: jsdom has no layout engine and the dom project runs with
// `css: false`, so no unit test here can observe a row overflowing. This is the
// fast local guard; `e2e/dialog-footer.spec.ts` is the one that could actually
// have caught it.
//
// Run with: npm run check:dialog-footer

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

const overlays = read("../../../renderer/ui/overlays.tsx");

/** The body of a top-level exported function, by name. Crude on purpose: the
 *  alternative is parsing TSX, and the shapes here are stable. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  if (start === -1) return "";
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

// ── 1. The row wraps ──────────────────────────────────────────────────────
{
  const footer = bodyOf(overlays, "DialogFooter");
  assert(footer !== "", "overlays.tsx: exports DialogFooter");

  assert(
    /\bflex-wrap\b/.test(footer),
    "overlays.tsx: DialogFooter is a WRAPPING row — without `flex-wrap` its nowrap buttons overflow, and `justify-end` puts the surplus outside the dialog's left edge",
  );

  // The overflow direction is what made this invisible in review: with
  // `justify-end` the row grows leftwards, away from where anyone looks. If the
  // justification ever changes, this line should be revisited rather than
  // silently kept.
  assert(
    /\bjustify-end\b/.test(footer),
    "overlays.tsx: DialogFooter still right-aligns its actions (if this changed, re-derive the overflow direction the wrap guard is protecting)",
  );

  // The marker the tests find the row by. Asserting on a data attribute rather
  // than a class is deliberate — see the note in toolbar-inset.test.tsx.
  assert(
    /data-dialog-footer/.test(footer),
    "overlays.tsx: DialogFooter carries data-dialog-footer, which both dialog-actions.test.tsx and e2e/dialog-footer.spec.ts locate it by",
  );
}

// ── 2. No Cancel in the composed footer ───────────────────────────────────
{
  const actions = bodyOf(overlays, "DialogActions");
  assert(actions !== "", "overlays.tsx: exports DialogActions (the composed dialog's action row)");

  assert(
    !/>\s*Cancel\s*</.test(actions) && !/["'`]Cancel["'`]/.test(actions),
    "overlays.tsx: DialogActions renders no hardcoded Cancel button — the close X, Escape and the overlay all already dismiss, and the button is what pushed Discard Edits out of the panel",
  );

  // The composed Dialog must go through DialogActions rather than rebuilding a
  // footer inline: a second copy is where the button would come back.
  const dialog = bodyOf(overlays, "Dialog");
  assert(
    /<DialogActions\b/.test(dialog),
    "overlays.tsx: the composed Dialog renders <DialogActions>, so there is exactly one action row for the tests to hold",
  );
  assert(
    !/<DialogFooter\b/.test(dialog),
    "overlays.tsx: the composed Dialog does not build a second footer inline beside DialogActions",
  );
}

// ── 3. The arithmetic e2e/dialog-footer.spec.ts reconstructs ──────────────
{
  const panelWidth = Number(
    read("../../../main/services/panel-dock.ts").match(/export const PANEL_WIDTH\s*=\s*(\d+)/)?.[1],
  );
  assert(
    Number.isFinite(panelWidth),
    "panel-dock.ts: declares PANEL_WIDTH (the trainer panel's width in DIP)",
  );

  // `w-[calc(100vw-4rem)]` is what makes the dialog narrower than the window,
  // and `p-4` is the padding the buttons must stay inside of.
  const panelClass = overlays.match(/export const dialogPanelClass\s*=\s*\n?\s*"([^"]*)"/)?.[1] ?? "";
  assert(panelClass !== "", "overlays.tsx: exports dialogPanelClass");
  assert(
    /w-\[calc\(100vw-4rem\)\]/.test(panelClass),
    "overlays.tsx: the dialog panel is still `w-[calc(100vw-4rem)]` — the expression e2e/dialog-footer.spec.ts evaluates by hand",
  );
  assert(/\bp-4\b/.test(panelClass), "overlays.tsx: the dialog panel still pads its content with p-4");

  // 4rem at the app's 16px root = 64px.
  const expected = panelWidth - 64;
  const measured = Number(
    read("../../../e2e/dialog-footer.spec.ts").match(/const PANEL_DIALOG_WIDTH\s*=\s*(\d+)/)?.[1],
  );
  assert(
    measured === expected,
    `e2e/dialog-footer.spec.ts: PANEL_DIALOG_WIDTH (${measured}) must be PANEL_WIDTH - 4rem (${panelWidth} - 64 = ${expected}), or the real-layout test measures a box the trainer panel never shows`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll dialog-footer checks passed");
