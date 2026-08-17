// The reskinned surfaces do not take the SDK's components back.
//
// WHAT A5 IS FOR, and why it needs a guard at all. `renderer/theme/` exists
// because the redesign's primitives are not the design system's with different
// colours: zero radius, hairline boxes, inset status rails and fixed status
// widths are not variants `cva` has (REDESIGN §1, §11). The five components
// every screen embeds were moved onto the theme layer BEFORE the screens
// themselves, so that each Phase B PR is about layout instead of about swapping
// buttons.
//
// That premise erodes silently. A Phase B PR touching `heals-panel.tsx` needs a
// button, `Button` is one import away and is what the other 80 files still use,
// and the result compiles, renders, passes every test and looks *almost* right —
// a rounded control among square ones. Nobody reviewing a 400-line reskin diff
// spots one import line. By the time it is noticed the file is mixed again and
// the reason it was done early is gone.
//
// WHAT IS ALLOWED, and why each one is:
//
//   Dialog / AlertDialog   focus trap and escape handling; the visible surface
//                          is ours (REDESIGN §1, "What the SDK keeps")
//   ScrollArea             structural — it owns follow-the-bottom scrolling
//   DropdownMenu family    NATIVE-menu-backed. Its items never enter the DOM;
//                          replacing it would mean giving up real macOS menus
//   toast / Toaster        same reasoning as Tooltip: positioning and dismissal
//                          are not worth rewriting
//
// Everything else — Button, Text, Badge, Input, Switch, RadioGroup, FieldSet,
// SidebarListItem, Card — is replaced on these surfaces.
//
// SOURCE-LEVEL because that is where the question lives: an import is not a
// rendered thing, and by the time a `<Button>` is on screen the only difference
// is a border radius that jsdom cannot see (the dom suite runs with
// `css: false`) and that no screenshot diff is watching for.
//
// Run with: npm run check:sdk-retired

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** The surfaces A5 moved onto the theme layer, plus each Phase B screen as it
 *  lands. Adding a screen here is how its reskin gets the same protection. */
const RETIRED = [
  "renderer/main/pager.tsx",
  "renderer/main/log-inspector.tsx",
  "renderer/main/tag-cluster.tsx",
  "renderer/main/heals-panel.tsx",
  "renderer/main/step-row.tsx",
  "renderer/theme/shell/rail.tsx",
  "renderer/theme/shell/top-strip.tsx",
  // The Phase B screens (REDESIGN §5). B1 and B2 landed without listing
  // themselves here, which left them reskinned but unguarded — the erosion this
  // check exists for starts on exactly those files, since they are the ones
  // being edited next. Both already pass; adding them costs nothing and is what
  // the note above asks for.
  "renderer/main/home-view.tsx",
  "renderer/main/heals-view.tsx",
  "renderer/main/stats-view.tsx",
  "renderer/main/flake-panel.tsx",
  "renderer/main/suite-cost-panel.tsx",
  "renderer/main/step-health-panel.tsx",
  "renderer/main/divergence-panel.tsx",
  // B8 shipped as a "first slice" — the bezel, the compare switch, the frame
  // rail, the threshold readout and the masks manager — and left the rest of
  // the screen on the SDK, which is how the largest file in the renderer ended
  // up half redesigned and reading as the old app. It is fully on the theme
  // layer now, and this is what stops the same thing happening twice.
  "renderer/main/visual-view.tsx",
  // Not a screen, but the two components the Visual step detail embeds — and
  // the test detail's Accessibility tab embeds the same two. A file rendered by
  // a retired surface is one whose SDK imports are invisible from that
  // surface's own line in this list.
  "renderer/main/a11y-violations.tsx",
];

/**
 * What may still be imported from `@ui`, BY FAMILY.
 *
 * THE UNIT HERE IS A DECISION, NOT A SYMBOL, and that distinction is the whole
 * reason this is a list of groups rather than a flat set. `Select`,
 * `SelectTrigger`, `SelectContent`, `SelectValue` and `SelectItem` are five
 * names for ONE choice — the picker stays native-menu-backed — and a flat set
 * counts that choice five times. The cap below then fires on a screen that made
 * no new decision at all, and the fix for a red run becomes "raise the cap",
 * which is indistinguishable from the bug the cap exists to catch.
 *
 * Members are enumerated rather than prefix-matched. `/^Select/` would also
 * wave through a future `SelectableCard`, which is a component and not this
 * decision.
 */
const KEEP_FAMILIES: { reason: string; members: string[] }[] = [
  {
    reason: "focus trap and escape handling; the visible surface is ours (REDESIGN §1)",
    members: ["Dialog", "AlertDialog"],
  },
  {
    reason: "structural — it owns follow-the-bottom scrolling",
    members: ["ScrollArea"],
  },
  {
    reason: "NATIVE-menu-backed: items never enter the DOM, and real macOS menus stay",
    members: [
      "DropdownMenu",
      "DropdownMenuCheckboxItem",
      "DropdownMenuContent",
      "DropdownMenuItem",
      "DropdownMenuSeparator",
      "DropdownMenuTrigger",
      "CustomContextMenu",
      "CustomContextMenuContent",
      "CustomContextMenuItem",
      "CustomContextMenuSeparator",
      "CustomContextMenuSub",
      "CustomContextMenuSubContent",
      "CustomContextMenuSubTrigger",
      "CustomContextMenuTrigger",
    ],
  },
  {
    reason: "positioning and dismissal are not worth rewriting; we restyle the surface",
    members: ["Tooltip", "TooltipProvider", "TooltipContent", "TooltipTrigger"],
  },
  {
    reason: "same — positioning and dismissal",
    members: ["Toaster", "toast"],
  },
  {
    reason: "owns collapse persistence and the pinned toggle anchor (REDESIGN §1)",
    members: ["SplitView", "useSplitView"],
  },
  {
    reason: "native-menu-backed picker; the redesign draws the box, the OS draws the menu",
    members: ["Select", "SelectItem", "SelectContent", "SelectTrigger", "SelectValue"],
  },
  {
    reason: "native date picker — there is no web control to replace it with",
    members: ["NativeDatePickerRoot", "NativeDatePickerTrigger", "NativeDatePickerValue"],
  },
  {
    reason: "a className joiner, not a component",
    members: ["cn"],
  },
];

const KEEP = new Set(KEEP_FAMILIES.flatMap((f) => f.members));

/** Named imports from `@ui` in one file. Type-only imports count too — a file
 *  typing against `ButtonProps` is a file about to render a `Button`. */
function uiImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"@ui"/gs)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) out.push(name);
    }
  }
  return out;
}

// ── The scanner can see something ─────────────────────────────────────
//
// A regex that stops matching harvests nothing, and a file that imports nothing
// trivially passes. So the parser is proved against a file that DOES import
// from `@ui`, by name, before any of the assertions below mean anything.
{
  const control = readFileSync(join(root, "renderer/main/heals-panel.tsx"), "utf-8");
  const names = uiImports(control);
  assert(
    names.length > 0,
    `the @ui import parser still works (heals-panel.tsx imports ${names.length}: ${names.join(", ")})`,
  );
}

// ── No retired surface takes a replaced component back ────────────────

{
  const offenders: string[] = [];
  for (const rel of RETIRED) {
    let src: string;
    try {
      src = readFileSync(join(root, rel), "utf-8");
    } catch {
      offenders.push(`${rel} — listed here but missing; remove it or fix the path`);
      continue;
    }
    for (const name of uiImports(src)) {
      if (!KEEP.has(name)) offenders.push(`${rel} → ${name}`);
    }
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? `all ${RETIRED.length} retired surfaces import only structural/native pieces from @ui`
      : `an SDK component came back to a surface the redesign already owns — it is rounded by\n     cva default and there is no "no radius" variant to ask for:\n     ${offenders.join("\n     ")}`,
  );
}

// ── They read the theme layer instead ─────────────────────────────────
//
// The mirror assertion, and it is what stops this check being satisfied by a
// file that simply renders nothing. `pager.tsx` is the sharpest case: it now
// imports NOTHING from `@ui`, so the pass above says nothing about it at all.
{
  const missing = RETIRED.filter((rel) => {
    const src = readFileSync(join(root, rel), "utf-8");
    // The shell primitives are inside the theme and import each other by
    // relative path; everything in renderer/main reaches it as `../theme`.
    return !/from\s*"(\.\.\/)+theme"/.test(src) && !/className="gl-/.test(src);
  });
  assert(
    missing.length === 0,
    missing.length === 0
      ? "every retired surface draws from the theme layer"
      : `retired from the SDK but not moved onto the theme — these render unstyled:\n     ${missing.join("\n     ")}`,
  );
}

// ── The keep-list is a list of reasons, not an escape hatch ───────────
//
// The failure mode of a check like this is that the fix for a red run becomes
// "add the symbol to KEEP" — indistinguishable from the bug. There is no way to
// enforce a reason, so the next best thing is to notice when the list grows.
//
// COUNTED IN FAMILIES, because a family is one decision and a symbol is not:
// admitting `SelectTrigger` beside `Select` is not a new choice about the
// picker, and a per-symbol cap would fire on a screen that made no choice at
// all — teaching exactly the "raise the cap" reflex this is here to prevent.
// A NEW FAMILY is a real decision and wants an entry in DECISIONS.
{
  assert(
    KEEP_FAMILIES.length <= 12,
    `the keep-list is still a short list of decisions (${KEEP_FAMILIES.length} families) — growing it is how this check gets turned off one family at a time`,
  );
  // Every family states why it is exempt. A member list with no reason beside
  // it is the shape this check is supposed to make impossible.
  for (const f of KEEP_FAMILIES) {
    assert(
      f.reason.trim().length > 0 && f.members.length > 0,
      `keep-family "${f.members[0]}" states a reason`,
    );
  }
  for (const banned of ["Button", "Text", "Badge", "Input", "Switch", "SidebarListItem"]) {
    assert(!KEEP.has(banned), `${banned} is not on the keep-list`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll sdk-retired checks passed.");
