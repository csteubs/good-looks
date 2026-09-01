// The ONE copy of what the trainer's action bar offers — the assert and
// add-step vocabularies, the native menus that present them, and the
// create-flow gate — shared by the main trainer (recording-view.tsx) and the
// docked panel (trainer-panel-view.tsx).
//
// These lived as hand-synced copies in the two views, each carrying a comment
// asking the next person to keep them agreeing, including the one encoding
// that could fail silently: a commandId meaning an ELEMENT assert in one menu
// and a URL assert in the other. The 2026-09-01 bar reorganisation retired
// the copies; the `commandId + 100` rule for the URL group now exists only
// here.
//
// Markup stays per-surface, deliberately (DECISIONS 2026-08-12): what is
// shared is what the bar MEANS, never how wide it is.

import type * as React from "react";

import type { AssertKind, Step } from "../lib/recorder-types";
import { extractableRange } from "../lib/step-selection";
import type { AddStepKind } from "./step-composer";
import { ADD_STEP_LABEL } from "./step-composer";

// Assertions that can be captured by clicking an element in the page. Operand
// assertions (value/attribute/count/url/title) need typed input, so they live
// in the "+ Add step" → Assertion form instead.
export const ASSERT_PICKABLE: { kind: AssertKind; label: string }[] = [
  { kind: "visible", label: "Is visible" },
  { kind: "hidden", label: "Is hidden" },
  { kind: "text", label: "Contains text" },
  { kind: "exactText", label: "Has exact text" },
  { kind: "enabled", label: "Is enabled" },
  { kind: "disabled", label: "Is disabled" },
  { kind: "checked", label: "Is checked" },
  { kind: "unchecked", label: "Is unchecked" },
];

// Page-level assertions need a typed string (not an element click), so
// selecting one opens the Add-step → Assertion dialog prefilled. The two
// title kinds prefill EMPTY on purpose: the trainer tracks the page's live
// URL but not its live title, and `urlAssertPrefill` already answers "" for
// any kind it cannot stand behind. An empty field the user knows to fill
// beats a plausible value they do not check.
export const ASSERT_PAGE: { kind: AssertKind; label: string }[] = [
  // "URL path is" first: the robust default. The other URL kinds compare the
  // full URL, which query-string noise fails between runs.
  { kind: "urlPathIs", label: "URL path is" },
  { kind: "url", label: "URL contains" },
  { kind: "urlEndsWith", label: "URL ends with" },
  { kind: "urlIs", label: "URL is" },
  { kind: "title", label: "Page title is" },
  { kind: "titleContains", label: "Page title contains" },
];

export const ASSERT_LABEL: Record<AssertKind, string> = {
  visible: "Is visible",
  hidden: "Is hidden",
  text: "Contains text",
  exactText: "Has exact text",
  enabled: "Is enabled",
  disabled: "Is disabled",
  checked: "Is checked",
  unchecked: "Is unchecked",
  value: "Has value",
  attribute: "Has attribute",
  count: "Has count",
  url: "URL contains",
  urlEndsWith: "URL ends with",
  urlIs: "URL is",
  urlPathIs: "URL path is",
  title: "Page title is",
  titleContains: "Page title contains",
  css: "Has CSS property",
  variable: "Variable value",
};

// Order matters: index === commandId in the native "+ Add step" menu.
export const ADD_STEP_KINDS: AddStepKind[] = [
  "assertion",
  "elementState",
  "condition",
  "loop",
  "wait",
  "goto",
  "reload",
  "echo",
  "dblclick",
  "rightclick",
  "press",
  "find",
  "viewport",
  "scroll",
  "capture",
  "download",
  "runFlow",
  "a11y",
  "upload",
  "api",
  "aiCheck",
  "emailCode",
  "group",
  "teardown",
  "dialog",
  // Last, and deliberately: the discoverable route to it is the training
  // browser's right-click menu on the field being filled, which arrives as a
  // `fill` context action with the element already resolved. This entry is
  // the keyboard-free fallback for someone already in the list.
  "fill",
];

interface MenuPopupItem {
  label?: string;
  type?: "normal" | "separator";
  commandId?: number;
}
interface NativeMenu {
  popup: (options: {
    items: MenuPopupItem[];
    x?: number;
    y?: number;
    coordinateSpace?: "screen" | "view";
  }) => Promise<{ commandId?: number }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}

/** What the assert menu resolved to: an element kind arms the picker, a page
 *  kind opens the composer prefilled. Null when dismissed. */
export type AssertMenuChoice =
  | { group: "element"; kind: AssertKind }
  | { group: "page"; kind: AssertKind }
  | null;

/** The assert menu, anchored under the button that opened it.
 *
 *  View-relative coordinates, not screen: absolute coordinates put the menu
 *  on the primary display regardless of which one the window is on. The URL
 *  group's commandIds are offset by 100 — with one builder that encoding can
 *  no longer mean an element assert in one trainer and a URL assert in the
 *  other. */
export async function pickAssertFromMenu(
  e: React.MouseEvent<HTMLButtonElement>,
): Promise<AssertMenuChoice> {
  const rect = e.currentTarget.getBoundingClientRect();
  const res = await nativeMenu().popup({
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
    coordinateSpace: "view",
    items: [
      ...ASSERT_PICKABLE.map((a, i) => ({ label: a.label, commandId: i })),
      { type: "separator" as const },
      ...ASSERT_PAGE.map((a, i) => ({ label: a.label, commandId: 100 + i })),
    ],
  });
  if (typeof res.commandId !== "number") return null;
  if (res.commandId < 100) {
    const chosen = ASSERT_PICKABLE[res.commandId];
    return chosen ? { group: "element", kind: chosen.kind } : null;
  }
  const page = ASSERT_PAGE[res.commandId - 100];
  return page ? { group: "page", kind: page.kind } : null;
}

/** The "+ Add step" menu, anchored the same way. Null when dismissed. */
export async function pickAddStepFromMenu(
  e: React.MouseEvent<HTMLButtonElement>,
): Promise<AddStepKind | null> {
  const rect = e.currentTarget.getBoundingClientRect();
  const res = await nativeMenu().popup({
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
    coordinateSpace: "view",
    items: ADD_STEP_KINDS.map((k, i) => ({ label: ADD_STEP_LABEL[k], commandId: i })),
  });
  if (typeof res.commandId === "number" && ADD_STEP_KINDS[res.commandId]) {
    return ADD_STEP_KINDS[res.commandId];
  }
  return null;
}

/** Copy for the create-flow gate below — exported because two of these are
 *  only reachable as a disabled button's hover title, and a string only
 *  reachable by hover is one no jsdom test can assert on. */
export const CREATE_FLOW_HINT = "Select two or more adjacent steps to move them into a flow";
export const CREATE_FLOW_READY = "Move the selected steps into a new reusable flow, called from here";

/** The create-flow gate: DISABLED-GATED, never render-gated.
 *
 *  The old bars mounted the button only while a selection existed, which is
 *  the "control appears when state changes" shape check:narrow-layout bans on
 *  the Visual screen — the row reflowed at the moment of selection. Always
 *  mounted, the button's disabled state and title carry what used to be a
 *  transient refusal note: `extractableRange`'s verdict is computed live, so
 *  an invalid selection reads WHY it is invalid before the click rather than
 *  in a six-second toastlike note after it. */
export function createFlowGate(
  liveSteps: Step[],
  selectionIds: string[],
): { count: number; disabled: boolean; title: string } {
  const count = selectionIds.length;
  if (count === 0) return { count, disabled: true, title: CREATE_FLOW_HINT };
  const verdict = extractableRange(liveSteps, selectionIds);
  if (!verdict.ok) return { count, disabled: true, title: verdict.reason };
  return { count, disabled: false, title: CREATE_FLOW_READY };
}
