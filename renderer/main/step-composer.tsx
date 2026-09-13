// Compose a trainer step by hand, IN THE LIST, at the insert cursor.
// REDESIGN §6.2 — this was `add-step-dialog.tsx` until 2026-08-12.
//
// One panel renders the fields for the chosen kind and returns RawSteps the
// trainer inserts at the cursor. What changed in §6.2 is only the frame around
// that: the panel opens between the two steps the new one will sit between,
// rather than over the top of everything.
//
// WHY THAT IS WORTH A PR ON ITS OWN. A modal hides the list you are adding to.
// The insert cursor was added precisely so a step could be placed somewhere
// other than the end — and then the control for placing it covered up the
// answer to "where is it going?". Composing in place makes the position part of
// what you are looking at while you fill the fields in, which is the whole
// reason the cursor exists.
//
// WHAT THE PLAN EXPECTED AND WHAT ACTUALLY HAPPENED. §6.2 says this "removes
// 1,170 lines and a modal". It removes the modal. It does not remove the lines,
// and it should not: the length here is ten step kinds times their fields —
// the three-checkbox wait, the CSS-property assert that refuses a malformed
// name, the element-state expansion that emits several rows — every one of
// which is behaviour with a test behind it. Deleting them to hit a line count
// would be deleting the feature. The modal was the part that was wrong.

import * as React from "react";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "@ui";
import { Crosshair, X } from "lucide-react";

import { Btn } from "../theme";

import {
  A11Y_IMPACTS,
  API_METHODS,
  CSS_ASSERT_PROPS,
  DEFAULT_WAIT_TIMEOUT_MS,
  isCssPropName,
} from "../lib/recorder-types";
import type {
  A11yImpact,
  ApiMethod,
  AssertKind,
  DialogAction,
  CaptureSource,
  TestVariable,
  VariableKind,
  ConditionKind,
  CssMatch,
  Locator,
  LocatorContext,
  PickedElement,
  RawStep,
  WaitDialogMode,
  WaitUntilKind,
} from "../lib/recorder-types";
import { api, type FlowInfo } from "../lib/api";
import { buildStateSteps, type StatePick } from "../lib/element-states";
import { collectFlowArgs, FlowArgsFields } from "./flow-args-fields";
import { clampViewportAxis, RESIZE_PRESETS } from "../lib/viewport-presets";
import { CustomLocatorField } from "./custom-locator-field";
import { ambiguousTargetHint, ElementContextPicker } from "./element-context-picker";
import { PositionField } from "./position-field";
import {
  NewVariableButton,
  NewVariableForm,
  VariableChips,
  varRef,
} from "../components/variable-picker";
import { formatLocator, KIND_LABEL } from "./refine-selector-dialog";
import { COMPARE_OP_LABEL, COMPARE_OPS } from "../../shared/step-semantics.mjs";
import type { CompareOp } from "../../shared/step-semantics.mjs";

export type AddStepKind =
  | "assertion"
  | "condition"
  | "loop"
  | "wait"
  | "goto"
  | "press"
  | "find"
  | "viewport"
  | "reload"
  | "echo"
  | "dblclick"
  | "rightclick"
  | "scroll"
  | "capture"
  | "download"
  | "runFlow"
  | "elementState"
  | "a11y"
  | "upload"
  | "api"
  | "aiCheck"
  | "emailCode"
  | "group"
  | "teardown"
  | "dialog"
  | "fill";

export const ADD_STEP_LABEL: Record<AddStepKind, string> = {
  assertion: "Add assertion",
  condition: "Add condition (if)",
  loop: "Repeat steps (loop)",
  wait: "Add wait",
  goto: "Go to URL",
  press: "Press key",
  find: "Find element",
  viewport: "Set viewport",
  reload: "Reload the page",
  echo: "Write to the run log",
  dblclick: "Double-click an element",
  rightclick: "Right-click an element",
  scroll: "Scroll",
  capture: "Capture a value",
  download: "Expect a download",
  runFlow: "Run a flow",
  elementState: "Set element state",
  a11y: "Check accessibility",
  upload: "Upload a file",
  api: "API request",
  aiCheck: "AI visual check",
  emailCode: "Read an emailed code",
  group: "Group steps",
  teardown: "Teardown (always runs)",
  dialog: "Handle next dialog",
  fill: "Fill with a variable",
};

/**
 * The pseudo-states the USER picks, which are deliberately not the same set as
 * `ElementState`.
 *
 * `:hover` and `:focus` are one step each. The other two need more than one
 * Playwright call, and a step emits exactly one awaited statement — so they are
 * emitted as SEVERAL ordinary rows, the same way the wait dialog emits one
 * `wait` step per ticked property. Rows rather than a compound step because
 * each stays independently reorderable, editable and deletable, and because a
 * user looking at `page.mouse.down()` in the list can see what will run.
 */
const STATE_OPTIONS: {
  value: StatePick;
  label: string;
  /** What the pick expands to, shown in the dialog so the row count is never a
   *  surprise after the fact. */
  emits: string;
  needsElement: boolean;
}[] = [
  { value: "hover", label: "Hover (:hover)", emits: "1 step — hover", needsElement: true },
  { value: "focus", label: "Focus (:focus)", emits: "1 step — focus", needsElement: true },
  {
    value: "focusVisible",
    label: "Keyboard focus (:focus-visible)",
    emits: "2 steps — press Tab, then focus",
    needsElement: true,
  },
  {
    value: "active",
    label: "Pressed (:active)",
    emits: "3 steps — hover, press, release",
    needsElement: true,
  },
];

// What a `capture` step reads. url/title read the page and need no element,
// which is why the target picker is hidden for them.
export const CAPTURE_OPTIONS: { value: CaptureSource; label: string; page?: boolean }[] = [
  { value: "text", label: "Element text" },
  { value: "value", label: "Input value" },
  { value: "attribute", label: "Element attribute" },
  { value: "count", label: "Match count" },
  { value: "url", label: "Page URL", page: true },
  { value: "title", label: "Page title", page: true },
];

/** Whether a capture source reads the PAGE, and so needs no element.
 *
 *  ONE spelling, because both halves of the kind ask it and they disagreed.
 *  The builder asked in its own words (`from === "url" || from === "title"`)
 *  and refused an element-scoped capture with no target — right, and it made
 *  the form's silence fatal: the form never asked at all, rendering no target
 *  picker for ANY source. So the four element sources (text, value, attribute,
 *  count) could never build, and the Add button sat permanently disabled with
 *  nothing left on screen to fill in. The `page` flag the list already carried
 *  was read by neither half.
 *
 *  An unrecognised source counts as element-scoped: that direction offers a
 *  picker and refuses the submit, where the other would emit a capture that
 *  reads nothing. */
export function isPageLevelCapture(from: CaptureSource): boolean {
  return CAPTURE_OPTIONS.find((o) => o.value === from)?.page === true;
}

// Condition predicates for an `if` block. Element conditions resolve a picked
// locator; page conditions match a substring of the current URL / title.
export const CONDITION_OPTIONS: { value: ConditionKind; label: string; page?: boolean }[] = [
  { value: "visible", label: "Element is visible" },
  { value: "hidden", label: "Element is hidden" },
  { value: "exists", label: "Element exists" },
  { value: "enabled", label: "Element is enabled" },
  { value: "disabled", label: "Element is disabled" },
  { value: "checked", label: "Element is checked" },
  { value: "unchecked", label: "Element is unchecked" },
  { value: "urlContains", label: "Page URL contains", page: true },
  { value: "titleContains", label: "Page title contains", page: true },
  // `page: true` reads as "needs no element", which is what it has always
  // meant to the builder below — a variable condition looks at nothing on the
  // page at all.
  { value: "variable", label: "Variable value", page: true },
];

// "Wait until" predicates. Element predicates resolve the picked locator; the
// two page predicates match a substring of the live URL / title. Mirrors the
// assertion list deliberately — a user who knows the assertion vocabulary
// already knows this one.
export const WAIT_UNTIL_OPTIONS: {
  value: WaitUntilKind;
  label: string;
  need: "none" | "text" | "value" | "count";
  page?: boolean;
}[] = [
  { value: "visible", label: "Element is visible", need: "none" },
  { value: "hidden", label: "Element is hidden", need: "none" },
  { value: "exists", label: "Element exists", need: "none" },
  { value: "enabled", label: "Element is enabled", need: "none" },
  { value: "disabled", label: "Element is disabled", need: "none" },
  { value: "checked", label: "Element is checked", need: "none" },
  { value: "unchecked", label: "Element is unchecked", need: "none" },
  { value: "text", label: "Element contains text", need: "text" },
  { value: "value", label: "Element has value", need: "value" },
  { value: "count", label: "Element count is", need: "count" },
  { value: "urlContains", label: "Page URL contains", need: "value", page: true },
  { value: "titleContains", label: "Page title contains", need: "value", page: true },
];

// assert kind → what operands it needs.
//
// Exported — with the capture, condition and wait lists above — so the test
// can pin each list against the model's kind list. Nothing rendered can do
// that: these feed native-menu-backed Selects, so a forgotten kind never
// enters the DOM of any test. And a kind missing HERE is worse than one menu
// row short: every other assert menu (recording view, trainer panel, the
// browser right-click menu) opens this composer with the kind preselected,
// and the `find` below is looked up with a non-null assertion — so
// `titleContains`, which shipped missing from this list alone, crashed the
// whole panel from three working menus.
type Need = "none" | "text" | "value" | "attr" | "count" | "css" | "variable";
export const ASSERT_OPTIONS: {
  value: AssertKind;
  label: string;
  need: Need;
  pageLevel?: boolean;
}[] = [
  { value: "visible", label: "Is visible", need: "none" },
  { value: "hidden", label: "Is hidden", need: "none" },
  { value: "text", label: "Contains text", need: "text" },
  { value: "exactText", label: "Has exact text", need: "text" },
  { value: "enabled", label: "Is enabled", need: "none" },
  { value: "disabled", label: "Is disabled", need: "none" },
  { value: "checked", label: "Is checked", need: "none" },
  { value: "unchecked", label: "Is unchecked", need: "none" },
  { value: "value", label: "Has value", need: "value" },
  { value: "attribute", label: "Has attribute", need: "attr" },
  { value: "count", label: "Has count", need: "count" },
  { value: "css", label: "Has CSS property", need: "css" },
  // "URL path is" first among the URL kinds: it is the robust default. The
  // other three compare the FULL URL, so query-string noise the site appends
  // between the recording and the run (`?variant=`, `utm_*`) fails them for a
  // reason that has nothing to do with the product.
  { value: "urlPathIs", label: "URL path is", need: "value", pageLevel: true },
  { value: "url", label: "URL contains", need: "value", pageLevel: true },
  { value: "urlEndsWith", label: "URL ends with", need: "value", pageLevel: true },
  { value: "urlIs", label: "URL is", need: "value", pageLevel: true },
  { value: "title", label: "Page title is", need: "value", pageLevel: true },
  { value: "titleContains", label: "Page title contains", need: "value", pageLevel: true },
  // The one kind that looks at nothing on the page. `pageLevel` is the
  // builder's name for "needs no element", which is exactly the case here.
  { value: "variable", label: "Variable value", need: "variable", pageLevel: true },
];

/**
 * Property + expected value for a `css` assertion.
 *
 * The load-bearing part is the live-values list. Playwright compares against
 * the COMPUTED value, so `red` never matches `rgb(255, 0, 0)` and `bold` never
 * matches `700` — a user typing what they wrote in their stylesheet gets a
 * failing test and no clue why. Offering the element's actual computed values
 * one click away makes the correct value the easy one.
 *
 * The values come from the picked element, read at the moment it was picked —
 * which means the user's real cursor was over it, so `:hover` styling is
 * already included. That is exactly right for a hover assertion and exactly
 * wrong if mistaken for resting styles, so the list says so rather than
 * leaving it to be discovered.
 */
function CssAssertFields({
  picked,
  cssProp,
  onCssProp,
  cssMatch,
  onCssMatch,
  value,
  onValue,
}: {
  picked: PickedElement | null;
  cssProp: string;
  onCssProp: (v: string) => void;
  cssMatch: CssMatch;
  onCssMatch: (v: CssMatch) => void;
  value: string;
  onValue: (v: string) => void;
}) {
  const computed = picked?.css ?? {};
  const live = Object.entries(computed);
  const prop = cssProp.trim();
  const validProp = isCssPropName(prop);
  // A property the picked element has a computed value for, but which isn't in
  // the curated list, still belongs in the dropdown — otherwise choosing it
  // from the live list would immediately look like a typo.
  const options = [...new Set([...CSS_ASSERT_PROPS, ...Object.keys(computed)])];

  return (
    <>
      {/* Two-up ONLY when there is room for it. This dialog renders in two very
          different places: the main window, which is never narrower than
          1200pt, and the docked trainer panel, which is 360. At 360 a
          half-width column is ~125pt — narrower than a Select showing "Has CSS
          property" or a segmented control offering "Is exactly / Contains", so
          both were drawn clipped, and before the `Field` fix they overflowed
          sideways into the column beside them. The breakpoint is on the
          VIEWPORT, which is the right question here precisely because the panel
          is its own window: it is genuinely a 360pt viewport, not a narrow box
          inside a wide one. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="CSS property" orientation="vertical">
          <Select value={options.includes(prop) ? prop : ""} onValueChange={onCssProp}>
            <SelectTrigger size="small">
              <SelectValue placeholder="Choose or type below" />
            </SelectTrigger>
            <SelectContent>
              {options.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Match" orientation="vertical">
          <SegmentedControl
            size="small"
            value={cssMatch}
            onValueChange={(v) => onCssMatch(v as CssMatch)}
          >
            <SegmentedControlItem value="is">Is exactly</SegmentedControlItem>
            <SegmentedControlItem value="contains">Contains</SegmentedControlItem>
          </SegmentedControl>
        </Field>
      </div>
      <Field label="Property name" orientation="vertical">
        <Input
          size="small"
          placeholder="background-color"
          value={cssProp}
          onChange={(e) => onCssProp(e.target.value)}
        />
      </Field>
      {prop && !validProp ? (
        <Text variant="small" color="red">
          “{prop}” isn’t a valid CSS property name. Use the kebab-case form —
          <code> background-color</code>, not <code>backgroundColor</code>.
        </Text>
      ) : null}
      <Field label="Expected value" orientation="vertical">
        <Input
          size="small"
          placeholder="rgb(0, 82, 204)"
          value={value}
          onChange={(e) => onValue(e.target.value)}
        />
      </Field>
      {live.length > 0 ? (
        <div className="flex flex-col gap-1">
          <Text variant="small" color="secondary">
            This element’s computed values — read while your cursor was over it, so any
            <code> :hover</code> styling is included. Click one to use it.
          </Text>
          <div className="flex flex-wrap gap-1">
            {live.map(([p, v]) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  onCssProp(p);
                  onValue(v);
                }}
                className="rounded-md border border-separator px-2 py-0.5 text-left text-small transition-colors hover:border-accent hover:bg-accent/5"
              >
                <span className="text-secondary">{p}</span>
                <span className="text-tertiary">: </span>
                <span className="font-mono">{v}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Text variant="small" color="tertiary">
          Pick a target element to see its current computed values and fill this in from
          them. Playwright compares the COMPUTED value, so <code>red</code> won’t match{" "}
          <code>rgb(255, 0, 0)</code>.
        </Text>
      )}
    </>
  );
}

// "Target element" picker — reuses the same crosshair element-picker as the
// per-step "Refine selector" flow. Instead of typing a CSS selector + value by
// hand, the user clicks a button, picks an element in the training browser, and
// chooses one of its candidate locators (best-first). Mirrors RefineSelectorDialog
// but inline so the rest of the Add-step form stays in one dialog.
function TargetElementPicker({
  picked,
  onChange,
  onStartPick,
  onClearPick,
}: {
  picked: PickedElement | null;
  /** null when the current choice is a custom draft that isn't valid (yet) —
   *  the composer's Add button keys off it. */
  onChange: (loc: Locator | null) => void;
  onStartPick: () => void;
  onClearPick: () => void;
}) {
  const [selected, setSelected] = React.useState<number | "custom">(0);
  const [customLoc, setCustomLoc] = React.useState<Locator | null>(null);
  const [ctx, setCtx] = React.useState<LocatorContext | null>(null);
  const [nth, setNth] = React.useState<number | null>(null);
  const candidates = picked?.candidates ?? [];

  /** One exit for every path, so context and position always ride the emitted
   *  locator — including across candidate switches, where the old inline
   *  composition silently dropped a configured context until it was next
   *  edited. `nth` composes last, matching the emitted chain's order. */
  const emit = React.useCallback(
    (base: Locator | null, c: LocatorContext | null, n: number | null) => {
      if (!base) {
        onChange(null);
        return;
      }
      const next: Locator = { ...base };
      if (c) next.ctx = c;
      else delete next.ctx;
      if (n !== null) next.nth = n;
      else delete next.nth;
      onChange(next);
    },
    [onChange],
  );

  // Seed the locator from the best candidate when a fresh element arrives.
  React.useEffect(() => {
    setSelected(0);
    setCustomLoc(null);
    setCtx(null);
    setNth(null);
    if (candidates[0]) onChange(candidates[0]);
    // onChange/candidates derive from picked; re-seed only on a new pick.
  }, [picked]);

  if (!picked || candidates.length === 0) {
    // No element picked (or none derivable): the crosshair is the first ask,
    // and the custom field is the standing alternative — it is also the ONLY
    // route to an element the picker cannot reach, like one that is hidden
    // until a hover the pick mode itself disturbs.
    return (
      <Field label="Target element" orientation="vertical">
        <div className="flex min-w-0 flex-col gap-2">
          <Button variant="secondary" size="small" onClick={onStartPick} className="w-fit">
            <Crosshair className="size-3.5" />
            {picked ? "No locator found — pick another" : "Pick element in browser"}
          </Button>
          {picked ? (
            <Text variant="small" color="tertiary">
              No locator could be derived for the picked element. Try another element.
            </Text>
          ) : null}
          <Text variant="small" color="tertiary">
            Or write a locator by hand:
          </Text>
          <CustomLocatorField ctx={null} onLocator={(l) => onChange(l)} />
        </div>
      </Field>
    );
  }

  return (
    <Field label="Target element" orientation="vertical">
      {/* `min-w-0` is load-bearing, not defensive tidiness.
       *
       * A labelled `Field` wraps its children in a flex ROW (see `Field` in
       * renderer/ui/layout.tsx). A flex item's automatic minimum size is its
       * MIN-CONTENT width, and the min-content width of this block is the
       * longest locator — an xpath like `//*[@id="controller"][1]/div[2]/…`
       * has no break opportunity in it at all. So without this the block
       * refuses to shrink, every `truncate` inside it is dead (a `truncate`
       * only truncates once its box is actually constrained), and the row
       * renders at its full natural width.
       *
       * The visible symptom is not a scrollbar. That wrapper is
       * `justify-end`, so the oversized box is right-aligned and the overflow
       * spills off the LEFT edge: measured at 476px inside the 360px trainer
       * panel, starting at x=-106. The locators are clipped on both sides and
       * the panel cannot be scrolled to reach them.
       *
       * It has to be here rather than on the wrapper — `min-w-0` on the
       * wrapper does not propagate to the child's automatic minimum, which was
       * confirmed by measuring both. */}
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-background-secondary px-2 py-1 font-mono text-xs text-primary">
            {picked.description || picked.tag || "element"}
          </code>
          <Button
            iconOnly
            variant="transparent"
            size="small"
            onClick={onClearPick}
            aria-label="Clear picked element"
            title="Clear"
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          {candidates.map((l, i) => {
            const active = i === selected;
            return (
              <button
                key={`${l.k}-${i}`}
                type="button"
                onClick={() => {
                  setSelected(i);
                  emit(l, ctx, nth);
                }}
                className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                  active ? "border-accent bg-accent/10" : "border-separator hover:bg-background-secondary"
                }`}
              >
                <span
                  className={`size-3.5 shrink-0 rounded-full border ${
                    active ? "border-accent bg-accent" : "border-separator"
                  }`}
                />
                <Badge color={active ? "blue" : "secondary"} className="shrink-0">
                  {KIND_LABEL[l.k]}
                </Badge>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-primary">
                  {formatLocator(l)}
                </code>
              </button>
            );
          })}
          {/* The escape hatch, LAST — same placement and same reasoning as the
              Refine dialog's row: picked candidates first, a hand-written
              locator when they can't express the intent. */}
          <button
            type="button"
            onClick={() => {
              setSelected("custom");
              emit(customLoc, ctx, nth);
            }}
            className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
              selected === "custom"
                ? "border-accent bg-accent/10"
                : "border-separator hover:bg-background-secondary"
            }`}
          >
            <span
              className={`size-3.5 shrink-0 rounded-full border ${
                selected === "custom" ? "border-accent bg-accent" : "border-separator"
              }`}
            />
            <Badge color={selected === "custom" ? "blue" : "secondary"} className="shrink-0">
              Custom
            </Badge>
            <Text variant="small" color="secondary" className="min-w-0 flex-1 truncate">
              Write a CSS selector or XPath by hand
            </Text>
          </button>
          {selected === "custom" ? (
            <CustomLocatorField
              ctx={ctx}
              onLocator={(l) => {
                setCustomLoc(l);
                emit(l, ctx, nth);
              }}
            />
          ) : null}
        </div>
        {/* The context picker sits UNDER the candidate list, because it answers
            the next question rather than the same one: the list is "how should
            this element be addressed", this is "which of the several it matches
            did you mean". It re-applies the current base with the new context
            so the caller only ever sees one locator. */}
        <ElementContextPicker
          picked={picked}
          onChange={(c) => {
            setCtx(c);
            emit(selected === "custom" ? customLoc : (candidates[selected] ?? null), c, nth);
          }}
        />
        <PositionField
          value={nth}
          onChange={(n) => {
            setNth(n);
            emit(selected === "custom" ? customLoc : (candidates[selected] ?? null), ctx, n);
          }}
        />
        <Button variant="ghost" size="small" onClick={onStartPick} className="w-fit">
          <Crosshair className="size-3.5" />
          Pick a different element
        </Button>
      </div>
    </Field>
  );
}

/** One tickable wait property: checkbox + clickable label + a line of hint.
 *  The label is a real `<label htmlFor>` so the hit target covers the text and
 *  the control is reachable by its accessible name. */
function CheckOption({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v: boolean | "indeterminate") => onChange(v === true)}
        className="mt-0.5"
      />
      <label htmlFor={id} className="flex min-w-0 flex-col gap-0.5 cursor-pointer">
        <Text size="small" className="text-primary">
          {label}
        </Text>
        <Text size="small" className="text-tertiary">
          {hint}
        </Text>
      </label>
    </div>
  );
}

/** Steps whose SUBJECT is how many elements the locator matches.
 *
 *  The match-count gate below refuses a locator that matches several elements,
 *  because Playwright's strict mode refuses it at run time. These three ask the
 *  opposite question: `count()` and `toHaveCount` never strict-resolve, and
 *  counting an ambiguous locator is the whole point of them — "capture a list's
 *  size, act, assert the size moved" (main/services/count-capture.test.ts).
 *  Gating them would disable Add on exactly the locator the step was written
 *  for, which is how a `Match count` capture would arrive broken the day the
 *  target picker was offered for it. */
function countsMatches(s: RawStep): boolean {
  if (s.type === "capture") return s.captureFrom === "count";
  if (s.type === "assert") return s.assert === "count";
  if (s.type === "wait") return s.waitUntil === "count";
  return false;
}

export function StepComposer({
  kind,
  onCancel,
  onAdd,
  picked,
  onStartPick,
  onClearPick,
  initialAssert,
  initialWaitMode,
  initialState,
  prefillText,
  prefillValue,
  initialWaitMs,
  currentTestId,
  variables = [],
  onCreateVariable,
}: {
  kind: AddStepKind;
  /** The test being edited, so it can't be offered as a flow to call itself. */
  currentTestId?: string;
  /** Dismiss without adding. The composer holds no "open" state of its own —
   *  it is mounted while composing and unmounted when not, so every open is a
   *  fresh one and there is no stale draft to reset. */
  onCancel: () => void;
  onAdd: (steps: RawStep[]) => void;
  /** Element the user picked in the training browser via the Target Element flow, if any. */
  picked: PickedElement | null;
  /** Enter pick mode — pauses the session so the user can click an element. */
  onStartPick: () => void;
  /** Clear the current pick (and leave pick mode). */
  onClearPick: () => void;
  /** When opened from the right-click menu: the assert kind to preselect. */
  initialAssert?: AssertKind;
  /** When opened from the right-click menu: the wait mode to preselect. */
  initialWaitMode?: WaitDialogMode;
  /** When opened from the right-click menu: the pseudo-state to preselect. Only
   *  the single-step states arrive this way — see ContextAction. */
  initialState?: "hover" | "focus";
  /** When opened from the right-click menu: prefilled text (the element's
   *  current text) for text/exactText asserts. */
  prefillText?: string;
  /** When opened from the right-click menu: prefilled value (the element's
   *  current value) for value asserts. */
  prefillValue?: string;
  /** When opened by the command box's "wait 2 seconds": the duration the
   *  wait form opens holding. Only meaningful with `initialWaitMode:
   *  "time"`, which that caller always sends alongside. */
  initialWaitMs?: number;
  /** Variables the owning test declares, for the "Fill with a variable" kind.
   *  Supplied by the host because the three of them read it from different
   *  places — the trainer from the live session, Edit Steps from the record. */
  variables?: TestVariable[];
  /** Declare a new variable from here. Absent where the host cannot persist one
   *  (no live session, no saved test), which hides the create affordance rather
   *  than offering a button that fails. */
  onCreateVariable?: (v: { name: string; kind: VariableKind; value: string }) => Promise<void>;
}) {
  const [locator, setLocator] = React.useState<Locator | null>(null);
  // How many elements the locator about to be submitted matches on the live
  // page, or null while unknown. Asked for every emitted locator that carries
  // no position: a locator matching several elements is a strict-mode
  // violation the run refuses, and the picker's own readout answers a
  // different question (how far the CONTEXT narrows the semantic base) — this
  // one is about the locator the step will actually hold, whichever
  // candidate it is. An indexed locator is skipped: the index IS the answer.
  const [matchCount, setMatchCount] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!locator || typeof locator.nth === "number") {
      setMatchCount(null);
      return;
    }
    let cancelled = false;
    setMatchCount(null);
    // Through a resolved promise, so a host whose bridge throws (or lacks the
    // call) lands in the catch as "could not count" rather than as a render
    // error — the gate must degrade to open, never to a crashed panel.
    void Promise.resolve()
      .then(() => api.recorder.countMatches(locator))
      .then((n) => {
        if (!cancelled) setMatchCount(n);
      })
      .catch(() => {
        if (!cancelled) setMatchCount(-1);
      });
    return () => {
      cancelled = true;
    };
  }, [locator]);
  const [assert, setAssert] = React.useState<AssertKind>("visible");
  const [cond, setCond] = React.useState<ConditionKind>("visible");
  const [text, setText] = React.useState("");
  const [value, setValue] = React.useState("");
  const [attr, setAttr] = React.useState("");
  const [count, setCount] = React.useState("1");
  const [soft, setSoft] = React.useState(false);
  const [cssProp, setCssProp] = React.useState("background-color");
  const [cssMatch, setCssMatch] = React.useState<CssMatch>("is");
  const [statePick, setStatePick] = React.useState<StatePick>("hover");
  const [url, setUrl] = React.useState("");
  const [key, setKey] = React.useState("Enter");
  // The three wait properties are independent checkboxes, not one mode: a
  // submit emits one `wait` step per ticked box, in the order they read down
  // the dialog (element, then condition, then duration as a settle pad). Each
  // lands as an ordinary step the user can reorder, edit or delete on its own,
  // which a single compound wait step could not offer.
  const [waitElement, setWaitElement] = React.useState(false);
  const [waitUntilOn, setWaitUntilOn] = React.useState(false);
  const [waitTime, setWaitTime] = React.useState(true);
  const [waitUntil, setWaitUntil] = React.useState<WaitUntilKind>("visible");
  const [waitTimeout, setWaitTimeout] = React.useState(String(DEFAULT_WAIT_TIMEOUT_MS));
  const [waitMs, setWaitMs] = React.useState("1000");
  const [pressTarget, setPressTarget] = React.useState<"page" | "element">("page");
  const [viewport, setViewport] = React.useState("desktop");
  const [vw, setVw] = React.useState("1280");
  const [vh, setVh] = React.useState("800");
  // Scroll step: to a picked element (the default — it self-corrects when the
  // page reflows) or to an absolute page position.
  const [scrollMode, setScrollMode] = React.useState<"element" | "position">("element");
  const [scrollXDraft, setScrollXDraft] = React.useState("0");
  const [scrollYDraft, setScrollYDraft] = React.useState("0");
  const [captureVar, setCaptureVar] = React.useState("");
  // The variable a `variable` assertion or condition reads, and how it
  // compares. Shared by both kinds on purpose: they are the same claim, and a
  // user who switches between them should not have to re-pick.
  const [compareVar, setCompareVar] = React.useState("");
  const [compareOp, setCompareOp] = React.useState<CompareOp>("eq");
  const [echoText, setEchoText] = React.useState("");
  const [captureFrom, setCaptureFrom] = React.useState<CaptureSource>("text");
  const [captureAttr, setCaptureAttr] = React.useState("");
  const [flowId, setFlowId] = React.useState("");
  // Iterations for the `loop` kind, held as text so a half-typed number
  // doesn't fight the input (same rule as the step row's numeric drafts).
  const [loopTimes, setLoopTimes] = React.useState("2");
  // The staged file an upload step will point at (scripts-relative path +
  // display name), set by the Choose-file button's round-trip.
  const [uploadRel, setUploadRel] = React.useState<string | null>(null);
  const [uploadName, setUploadName] = React.useState<string>("");
  const [uploadBusy, setUploadBusy] = React.useState(false);
  // API request fields. Headers draft as "Name: value" lines — parsed and
  // validated on build, kept as text while typing.
  const [apiMethod, setApiMethod] = React.useState<ApiMethod>("GET");
  const [apiUrl, setApiUrl] = React.useState("");
  const [apiHeadersDraft, setApiHeadersDraft] = React.useState("");
  const [apiBody, setApiBody] = React.useState("");
  const [apiStatus, setApiStatus] = React.useState("");
  const [apiCaptureVar, setApiCaptureVar] = React.useState("");
  const [apiCapturePath, setApiCapturePath] = React.useState("");
  // Whether the condition kind also inserts an ELSE half between the pair.
  const [withElse, setWithElse] = React.useState(false);
  // The a11y gate's impact floor. "serious" is axe's second-worst level and
  // the default that makes a first gate useful without drowning in minors.
  const [a11yImpact, setA11yImpact] = React.useState<A11yImpact>("serious");
  // The AI check's claim about the page at this point.
  const [aiClaim, setAiClaim] = React.useState("");
  // The emailed sign-in code: which mailbox to watch and where to put the
  // code. The digits field is here rather than fixed at six because the
  // default is a convention, not a standard — and a store using four would
  // otherwise have no way to say so.
  const [emailAddress, setEmailAddress] = React.useState("");
  const [emailVar, setEmailVar] = React.useState("loginCode");
  const [emailDigits, setEmailDigits] = React.useState("6");
  const [emailLabel, setEmailLabel] = React.useState("");
  const [groupLabel, setGroupLabel] = React.useState("");
  const [dialogAction, setDialogAction] = React.useState<DialogAction>("accept");
  const [dialogText, setDialogText] = React.useState("");
  // The `download` kind's three fields. Filename empty = "any download" —
  // the await itself is the assertion then, which is a real one.
  const [dlName, setDlName] = React.useState("");
  const [dlExact, setDlExact] = React.useState(false);
  const [dlVar, setDlVar] = React.useState("");
  // Draft values for the selected flow's parameters, keyed by parameter name.
  // Reset when the flow changes: two flows sharing a parameter name is a
  // coincidence, not a reason to carry a value across.
  const [flowArgVals, setFlowArgVals] = React.useState<Record<string, string>>({});
  // Which declared variable a `fill` step will use, and whether the inline
  // "declare one" form is open. The name rather than an index: the list can
  // gain an entry while this panel is open (that is the whole point of the
  // create form), and an index would then point at a different variable.
  const [fillVar, setFillVar] = React.useState("");
  const [creatingVar, setCreatingVar] = React.useState(false);

  // Seed the fields from whatever the caller preselected.
  //
  // There is no `open` to guard on now: the composer is MOUNTED while composing
  // and unmounted when not, and both call sites key it on the kind and the
  // picked element — so a fresh open, and a re-target from the right-click
  // menu, are both fresh mounts. There is no stale draft to clear.
  //
  // AND IT DELIBERATELY DOES NOT TOUCH `locator`, which it used to. `locator`
  // is seeded by `TargetElementPicker` — a CHILD — from the best candidate of
  // the picked element, and a child's effects run before its parent's. Resetting
  // it here therefore lands after the picker's seed and wipes it, leaving the
  // composer with no target for a step that needs one. That was survivable in
  // the modal, whose confirm button was always enabled and whose submit simply
  // did nothing; the inline panel disables the button when the step will not
  // build, so the same state shows up as a control that cannot be pressed.
  // `useState(null)` on a fresh mount is the reset, and it happens first.
  React.useEffect(() => {
    {
      setAssert(initialAssert ?? "visible");
      setCond("visible");
      setText(prefillText ?? "");
      setValue(prefillValue ?? "");
      setAttr("");
      setCount("1");
      setSoft(false);
      setCssProp("background-color");
      setCssMatch("is");
      setStatePick(initialState ?? "hover");
      setUrl("");
      setKey("Enter");
      // Preselect the box the caller asked for; with no caller preference the
      // dialog opens on a duration, as it always has. "hidden" is a Wait Until
      // rather than a plain element wait — see WaitDialogMode.
      setWaitElement(initialWaitMode === "element");
      setWaitUntilOn(initialWaitMode === "hidden" || initialWaitMode === "until");
      setWaitTime(!initialWaitMode || initialWaitMode === "time");
      setWaitUntil(initialWaitMode === "hidden" ? "hidden" : "visible");
      setWaitTimeout(String(DEFAULT_WAIT_TIMEOUT_MS));
      // The command box's "wait 2 seconds" opens the form holding the stated
      // duration; every other opener keeps the long-standing default.
      setWaitMs(initialWaitMs != null && initialWaitMs >= 0 ? String(initialWaitMs) : "1000");
      setPressTarget("page");
      setViewport("desktop");
      setVw("1280");
      setVh("800");
      setScrollMode("element");
      setScrollXDraft("0");
      setScrollYDraft("0");
      setCaptureVar("");
      setCaptureFrom("text");
      setCaptureAttr("");
      setFlowId("");
      setFlowArgVals({});
      setFlowRepeatMode("once");
      setFlowRepeatCount("2");
      setFlowRepeatName("");
      setFillVar("");
      setCreatingVar(false);
    }
  }, [kind, initialAssert, initialWaitMode, initialState, prefillText, prefillValue, initialWaitMs]);

  // Flows available to call from here. Fetched on mount rather than held by the
  // parent, so a flow created in another window shows up without a reload.
  const [flows, setFlows] = React.useState<FlowInfo[]>([]);
  // The call's loop: once, a fixed count, or driven by a variable's run-time
  // value. Mirrors the args dialog, which edits the same fields later.
  const [flowRepeatMode, setFlowRepeatMode] = React.useState<"once" | "count" | "variable">("once");
  const [flowRepeatCount, setFlowRepeatCount] = React.useState("2");
  const [flowRepeatName, setFlowRepeatName] = React.useState("");
  React.useEffect(() => {
    if (kind !== "runFlow") return;
    let live = true;
    void api.tests
      .listFlows(currentTestId)
      .then((f) => {
        if (live) setFlows(f);
      })
      .catch(() => {
        if (live) setFlows([]);
      });
    return () => {
      live = false;
    };
  }, [kind, currentTestId]);

  const opt = ASSERT_OPTIONS.find((o) => o.value === assert)!;
  const condOpt = CONDITION_OPTIONS.find((c) => c.value === cond)!;
  const waitUntilOpt = WAIT_UNTIL_OPTIONS.find((w) => w.value === waitUntil)!;
  // Both element-scoped wait boxes resolve the SAME picked element — the dialog
  // holds one pick — so the picker is rendered once and shared rather than
  // duplicated into two controls that would silently overwrite each other.
  const waitNeedsElement = waitElement || (waitUntilOn && !waitUntilOpt.page);

  function build(): RawStep[] | null {
    switch (kind) {
      case "goto":
        return url.trim() ? [{ type: "goto", url: url.trim() }] : null;
      case "press":
        return [
          {
            type: "press",
            value: key || "Enter",
            ...(pressTarget === "element" && locator ? { locator } : {}),
          },
        ];
      case "wait": {
        const steps: RawStep[] = [];
        // A ticked box with nothing to act on would emit a step that waits for
        // nothing, so the whole submit is refused rather than silently adding
        // the other two.
        if (waitElement) {
          if (!locator) return null;
          steps.push({ type: "wait", locator });
        }
        if (waitUntilOn) {
          const step: RawStep = {
            type: "wait",
            waitUntil,
            timeoutMs: Number(waitTimeout) || DEFAULT_WAIT_TIMEOUT_MS,
          };
          if (!waitUntilOpt.page) {
            if (!locator) return null;
            step.locator = locator;
          }
          if (waitUntilOpt.need === "text") step.text = text;
          if (waitUntilOpt.need === "value") step.value = value;
          if (waitUntilOpt.need === "count") step.count = Number(count) || 0;
          steps.push(step);
        }
        if (waitTime) steps.push({ type: "wait", waitMs: Number(waitMs) || 0 });
        return steps.length > 0 ? steps : null;
      }
      case "viewport": {
        if (viewport === "custom") {
          return [
            {
              type: "viewport",
              width: clampViewportAxis(vw, 1280),
              height: clampViewportAxis(vh, 800),
            },
          ];
        }
        const p = RESIZE_PRESETS.find((v) => v.id === viewport);
        return [{ type: "viewport", width: p?.w ?? 1280, height: p?.h ?? 800 }];
      }
      case "echo": {
        const text = echoText.trim();
        // Nothing to say refuses the submit: an echo with no message writes a
        // blank line into the run log, which is a step that looks added and
        // says nothing.
        return text ? [{ type: "echo", text }] : null;
      }
      case "reload":
        // No fields: a reload has nothing to configure. The per-step timeout,
        // like every other step's, is set from the step row afterwards.
        return [{ type: "reload" }];
      case "scroll": {
        if (scrollMode === "element") {
          // No target picked → refuse the submit, same rule as `find`: a
          // scroll-to-nothing is not a smaller step, it's a broken one.
          return locator ? [{ type: "scroll", locator }] : null;
        }
        // Parsed to NUMBERS here, not passed through as the typed strings —
        // these are emitted into the spec as bare numerals, and a string
        // reaching the generator is the shape of the original injection bug.
        const sx = Math.max(0, Math.trunc(Number(scrollXDraft) || 0));
        const sy = Math.max(0, Math.trunc(Number(scrollYDraft) || 0));
        return [{ type: "scroll", scrollX: sx, scrollY: sy }];
      }
      case "find":
        return locator ? [{ type: "assert", assert: "visible", locator }] : null;
      // No target refuses the WHOLE submit, the same rule `find` applies: a
      // click on nothing is not a smaller step, it is a broken one.
      case "dblclick":
        return locator ? [{ type: "dblclick", locator }] : null;
      case "rightclick":
        return locator ? [{ type: "rightclick", locator }] : null;
      case "fill": {
        // Both halves are required, and neither degrades usefully: a fill with
        // no target types into nothing, and a fill with no variable would write
        // the literal text "${}" into the field. The panel says which is
        // missing rather than disabling the button with no explanation.
        if (!locator || !fillVar) return null;
        return [{ type: "fill", locator, value: varRef(fillVar) }];
      }
      case "capture": {
        const name = captureVar.trim();
        if (!name) return null;
        const pageLevel = isPageLevelCapture(captureFrom);
        // An element-scoped capture with no target would silently capture
        // nothing, so refuse it here rather than emit a broken step.
        if (!pageLevel && !locator) return null;
        return [
          {
            type: "capture",
            captureVar: name,
            captureFrom,
            ...(captureFrom === "attribute" ? { captureAttr: captureAttr.trim() } : {}),
            ...(pageLevel ? {} : { locator: locator! }),
          },
        ];
      }
      case "runFlow": {
        if (!flowId) return null;
        const flow = flows.find((f) => f.id === flowId);
        // Only filled-in arguments are stored: a blank field means "use the
        // flow's default", which requires the KEY to be absent — an empty
        // string would override the default (see collectFlowArgs).
        const args = collectFlowArgs(flow?.flowParams ?? [], flowArgVals);
        // A variable-driven repeat needs a usable name; refuse the submit
        // rather than silently adding a call that runs once.
        if (flowRepeatMode === "variable" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(flowRepeatName)) {
          return null;
        }
        const repeatCount = Math.max(2, Math.min(100, Math.trunc(Number(flowRepeatCount) || 2)));
        return [
          {
            type: "runFlow",
            flowId,
            // The name is stored on the step so the list stays readable even if
            // the flow is later renamed or deleted.
            label: flow?.name ?? flowId,
            ...(Object.keys(args).length > 0 ? { flowArgs: args } : {}),
            ...(flowRepeatMode === "count" ? { repeat: repeatCount } : {}),
            ...(flowRepeatMode === "variable" ? { repeatVar: flowRepeatName } : {}),
          },
        ];
      }
      case "a11y":
        return [{ type: "a11y", a11yImpact }];
      case "upload": {
        if (!locator || !uploadRel) return null;
        return [{ type: "upload", locator, value: uploadRel }];
      }
      case "api": {
        const url = apiUrl.trim();
        if (url === "") return null;
        const step: RawStep = { type: "api", apiMethod, url };
        const headers: Record<string, string> = {};
        for (const line of apiHeadersDraft.split("\n")) {
          const t = line.trim();
          if (t === "") continue;
          const at = t.indexOf(":");
          // A malformed header line refuses the WHOLE submit rather than
          // silently dropping the line — same rule as the css assert.
          if (at <= 0) return null;
          const name = t.slice(0, at).trim();
          const value = t.slice(at + 1).trim();
          if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return null;
          headers[name] = value;
        }
        if (Object.keys(headers).length > 0) step.apiHeaders = headers;
        if (apiBody.trim() !== "") step.apiBody = apiBody;
        if (apiStatus.trim() !== "") {
          const n = Number(apiStatus.trim());
          if (!Number.isInteger(n) || n < 100 || n > 599) return null;
          step.expectStatus = n;
        }
        const cv = apiCaptureVar.trim();
        if (cv !== "") {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cv) || cv.length > 40) return null;
          step.captureVar = cv;
          const cp = apiCapturePath.trim();
          if (cp !== "") step.capturePath = cp;
        }
        return [step];
      }
      case "aiCheck": {
        const claim = aiClaim.trim();
        if (claim === "") return null;
        return [{ type: "aiCheck", text: claim }];
      }
      case "emailCode": {
        const address = emailAddress.trim();
        const name = emailVar.trim();
        // Both required. A code read into nowhere is not a step, and an
        // address-less one has no mailbox to watch — the generator emits
        // nothing for either, so refusing here is what makes that visible.
        if (address === "" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 40) {
          return null;
        }
        const step: RawStep = { type: "emailCode", mailboxAddress: address, captureVar: name };
        const digits = Number(emailDigits.trim());
        // Refuses the whole submit rather than silently falling back to six —
        // the api kind's rule for a malformed field.
        if (!Number.isInteger(digits) || digits < 4 || digits > 10) return null;
        if (digits !== 6) step.codeDigits = digits;
        if (emailLabel.trim() !== "") step.codeLabel = emailLabel.trim();
        return [step];
      }
      case "group": {
        // The pair inserts together, the loop kind's idiom — the user drags
        // steps between the halves.
        const label = groupLabel.trim();
        if (label === "") return null;
        return [{ type: "group", label }, { type: "endGroup" }];
      }
      // A DIVIDER, so there is no closing half to insert with it — everything
      // below the row is the teardown block. One per test; the generator
      // refuses a second and says so in the spec.
      case "teardown":
        return [{ type: "teardown" }];
      case "dialog": {
        const step: RawStep = { type: "dialog", dialogAction };
        if (dialogAction === "accept" && dialogText !== "") step.value = dialogText;
        return [step];
      }
      case "download": {
        const name = dlName.trim();
        const varName = dlVar.trim();
        const s: RawStep = { type: "download" };
        if (name !== "") {
          s.value = name;
          if (dlExact) s.downloadMatch = "exact";
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName) && varName.length <= 40) {
          s.captureVar = varName;
        }
        return [s];
      }
      case "loop": {
        // Insert an empty REPEAT/END-REPEAT pair, same idiom as the condition:
        // the user drags steps between the halves. The count is clamped here
        // AND at the boundary AND in the generator — three independent guards
        // for a numeral that lands in the spec bare.
        const n = Math.min(500, Math.max(1, Math.trunc(Number(loopTimes) || 1)));
        return [{ type: "loop", loopCount: n }, { type: "endLoop" }];
      }
      case "condition": {
        // Insert an empty IF/END-IF pair; the user drags steps between them.
        // With the else box ticked, the ELSE half rides along — steps dragged
        // between if and else run when the condition holds, steps between
        // else and end-if when it does not.
        const ifStep: RawStep = { type: "if", cond };
        if (cond === "variable") {
          // No variable chosen refuses the WHOLE submit, the same rule the css
          // assert applies: the boundary would drop `captureVar` and keep the
          // rest, producing a condition that compares nothing and silently
          // takes the same branch every run.
          if (!compareVar) return null;
          ifStep.captureVar = compareVar;
          ifStep.compareOp = compareOp;
          ifStep.value = value;
        } else if (condOpt.page) {
          ifStep.value = value;
        } else {
          if (!locator) return null;
          ifStep.locator = locator;
        }
        return withElse
          ? [ifStep, { type: "else" }, { type: "endif" }]
          : [ifStep, { type: "endif" }];
      }
      case "assertion": {
        const step: RawStep = { type: "assert", assert, soft: soft || undefined };
        if (!opt.pageLevel) {
          if (!locator) return null;
          step.locator = locator;
        }
        // A page-level assert with an empty value refuses the WHOLE submit,
        // the same rule the css case applies below: the generator refuses to
        // emit it (an empty "contains" matches every page), so accepting it
        // here plants a step that looks added and asserts nothing. Element
        // `value` asserts stay submittable empty — asserting an input is
        // blank is a real assertion.
        if (opt.pageLevel && opt.need === "value" && value === "") return null;
        if (opt.need === "text") step.text = text;
        if (opt.need === "value") step.value = value;
        if (opt.need === "attr") {
          step.attr = attr;
          step.value = value;
        }
        if (opt.need === "count") step.count = Number(count) || 0;
        if (opt.need === "variable") {
          if (!compareVar) return null;
          step.captureVar = compareVar;
          step.compareOp = compareOp;
          step.value = value;
        }
        if (opt.need === "css") {
          // A malformed property refuses the WHOLE submit, the same rule the
          // wait dialog applies to a ticked box with no element. The boundary
          // would drop `cssProp` and keep the rest, which produces a css assert
          // with no property — a step that looks added and asserts nothing.
          const prop = cssProp.trim();
          if (!isCssPropName(prop)) return null;
          step.cssProp = prop;
          step.cssMatch = cssMatch;
          step.value = value;
        }
        return [step];
      }
      case "elementState": {
        // The expansion itself lives in renderer/lib/element-states.ts: the
        // state picker is a native-menu Select, so a pick cannot be driven in
        // jsdom and the multi-row cases would otherwise be untestable.
        const stateSteps = buildStateSteps(statePick, locator);
        return stateSteps.length > 0 ? stateSteps : null;
      }
      default:
        return null;
    }
  }

  const steps = build();
  // A locator that matches several elements is refused here, with the count,
  // rather than recorded and refused by the run — where it fails against a
  // page the user is no longer looking at. Only MORE than one blocks: zero
  // may be a hand-typed locator for an element the page shows later (the
  // custom field exists for exactly those), and -1 is the page failing to
  // answer, which must never read as a verdict. And only when a built step
  // actually carries the locator — a page-level step beside a stale pick is
  // not a step about that element — and only when the step would strict-
  // resolve it, which a step that COUNTS the matches does not (countsMatches).
  const ambiguousTarget =
    matchCount !== null &&
    matchCount > 1 &&
    steps !== null &&
    steps.some((s) => s.locator !== undefined && s.locator === locator && !countsMatches(s))
      ? matchCount
      : null;
  // The panel is inline, so it can say what it would add BEFORE you press
  // anything — a modal with a permanently-enabled confirm can afford to fail
  // silently on submit because it stays open; a panel sitting in the list
  // cannot, and should not have to.
  const ready = steps !== null && steps.length > 0 && ambiguousTarget === null;

  function submit() {
    if (!ready) return;
    onAdd(steps!);
    onCancel();
  }

  return (
    <div
      className="gl-composer"
      data-gl="step-composer"
      // A form, so Enter submits from any field — which is what a panel in a
      // list should do and what a modal's confirm button was standing in for.
      role="form"
      aria-label={ADD_STEP_LABEL[kind]}
      onKeyDown={(e) => {
        // Escape closes, from anywhere inside. The dialog got this from Radix;
        // an inline panel has to say so itself, and without it the only way out
        // of a half-filled composer is the mouse.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="gl-composer-head">
        <span className="gl-section-title">{ADD_STEP_LABEL[kind]}</span>
        <button
          type="button"
          className="gl-icon-btn gl-composer-close"
          onClick={onCancel}
          aria-label="Cancel"
          title="Cancel"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="gl-composer-body">
        {kind === "goto" ? (
          <Field label="URL" orientation="vertical">
            <Input
              autoFocus
              placeholder="https://example.com/page"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
        ) : null}

        {kind === "press" ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Key" orientation="vertical">
                <Input size="small" value={key} onChange={(e) => setKey(e.target.value)} />
              </Field>
              <Field label="Target" orientation="vertical">
                <SegmentedControl
                  size="small"
                  value={pressTarget}
                  onValueChange={(v) => setPressTarget(v as "page" | "element")}
                >
                  <SegmentedControlItem value="page">Page</SegmentedControlItem>
                  <SegmentedControlItem value="element">Element</SegmentedControlItem>
                </SegmentedControl>
              </Field>
            </div>
            {pressTarget === "element" ? (
              <TargetElementPicker
                picked={picked}
                onChange={setLocator}
                onStartPick={onStartPick}
                onClearPick={onClearPick}
              />
            ) : null}
          </>
        ) : null}

        {kind === "wait" ? (
          <>
            <Field label="Wait for" orientation="vertical">
              <div className="flex flex-col gap-2">
                <CheckOption
                  id="wait-for-element"
                  checked={waitElement}
                  onChange={setWaitElement}
                  label="An element"
                  hint="Waits for the picked element to appear."
                />
                <CheckOption
                  id="wait-until"
                  checked={waitUntilOn}
                  onChange={setWaitUntilOn}
                  label="Wait until"
                  hint="Waits for a measurable condition to become true."
                />
                <CheckOption
                  id="wait-for-duration"
                  checked={waitTime}
                  onChange={setWaitTime}
                  label="A duration"
                  hint="A fixed pause, added last."
                />
              </div>
            </Field>
            <Text size="small" className="text-tertiary">
              Tick more than one to add several waits at once — they’re inserted as separate
              steps, in the order listed above.
            </Text>

            {waitUntilOn ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Condition" orientation="vertical">
                  <Select
                    value={waitUntil}
                    onValueChange={(v) => setWaitUntil(v as WaitUntilKind)}
                  >
                    <SelectTrigger size="small">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WAIT_UNTIL_OPTIONS.map((w) => (
                        <SelectItem key={w.value} value={w.value}>
                          {w.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Timeout (ms)" orientation="vertical">
                  {/* `Field label` renders a label with no `for`, so the input
                      needs its own accessible name — without one it is an
                      unnamed number box to a screen reader. */}
                  <Input
                    size="small"
                    type="number"
                    aria-label="Timeout (ms)"
                    value={waitTimeout}
                    onChange={(e) => setWaitTimeout(e.target.value)}
                  />
                </Field>
              </div>
            ) : null}

            {waitUntilOn && waitUntilOpt.need === "text" ? (
              <Field label="Text" orientation="vertical">
                <Input size="small" value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
            ) : null}
            {waitUntilOn && waitUntilOpt.need === "value" ? (
              <Field
                label={waitUntilOpt.page ? "Substring" : "Expected value"}
                orientation="vertical"
              >
                <Input size="small" value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            ) : null}
            {waitUntilOn && waitUntilOpt.need === "count" ? (
              <Field label="Expected count" orientation="vertical">
                <Input
                  size="small"
                  type="number"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              </Field>
            ) : null}

            {waitNeedsElement ? (
              <>
                <TargetElementPicker
                  picked={picked}
                  onChange={setLocator}
                  onStartPick={onStartPick}
                  onClearPick={onClearPick}
                />
                {waitElement && waitUntilOn && !waitUntilOpt.page ? (
                  <Text size="small" className="text-tertiary">
                    Both waits target this element.
                  </Text>
                ) : null}
              </>
            ) : null}

            {waitTime ? (
              <Field label="Duration (ms)" orientation="vertical">
                <Input
                  size="small"
                  type="number"
                  aria-label="Duration (ms)"
                  value={waitMs}
                  onChange={(e) => setWaitMs(e.target.value)}
                />
              </Field>
            ) : null}
          </>
        ) : null}

        {kind === "dblclick" || kind === "rightclick" ? (
          <>
            <Text variant="small" color="secondary">
              {kind === "dblclick" ? (
                <>
                  Double-click the element (Playwright <code>dblclick</code>). Recorded
                  automatically too &mdash; the trainer withdraws the two single clicks the browser
                  fires first.
                </>
              ) : (
                <>
                  Right-click the element (Playwright{" "}
                  <code>click(&#123; button: &quot;right&quot; &#125;)</code>). It cannot be
                  recorded by right-clicking in the training browser, because that gesture already
                  opens the trainer&rsquo;s own tools menu &mdash; use{" "}
                  <strong>Record a right-click here</strong> in that menu instead, or pick the
                  element below.
                </>
              )}
            </Text>
            <TargetElementPicker
              picked={picked}
              onChange={setLocator}
              onStartPick={onStartPick}
              onClearPick={onClearPick}
            />
          </>
        ) : null}

        {kind === "find" ? (
          <>
            <Text variant="small" color="secondary">
              Assert an element is present on the page (Playwright <code>toBeVisible</code>). Pick the
              target element in the browser.
            </Text>
            <TargetElementPicker
              picked={picked}
              onChange={setLocator}
              onStartPick={onStartPick}
              onClearPick={onClearPick}
            />
          </>
        ) : null}

        {kind === "fill" ? (
          <>
            <Text variant="small" color="secondary">
              Type a variable&apos;s value into a field (Playwright <code>fill</code>). The step
              stores the reference, not the value — so a <strong>Secret</strong> reaches the browser
              from the encrypted store at run time and never enters the generated spec.
            </Text>
            <TargetElementPicker
              picked={picked}
              onChange={setLocator}
              onStartPick={onStartPick}
              onClearPick={onClearPick}
            />
            <Field label="Variable" orientation="vertical">
              <VariableChips
                variables={variables}
                selected={fillVar}
                onPick={(name) => setFillVar(name)}
                emptyHint={
                  onCreateVariable
                    ? "This test declares no variables yet. Create one below."
                    : "This test declares no variables yet. Add one on the Variables tab."
                }
              />
            </Field>
            {onCreateVariable ? (
              creatingVar ? (
                <NewVariableForm
                  existingNames={variables.map((v) => v.name)}
                  onCancel={() => setCreatingVar(false)}
                  onCreate={async (v) => {
                    await onCreateVariable(v);
                    // Select it: the user created this variable in order to use
                    // it here, and leaving the choice empty would make the
                    // create button look like it had done nothing.
                    setFillVar(v.name);
                    setCreatingVar(false);
                  }}
                />
              ) : (
                <NewVariableButton onClick={() => setCreatingVar(true)} />
              )
            ) : null}
            {fillVar ? (
              <Text variant="small" color="secondary">
                Fills with <code className="font-mono">{varRef(fillVar)}</code>.
              </Text>
            ) : null}
          </>
        ) : null}

        {/* The variable comparison — shown for the `variable` assert kind and
            the `variable` condition alike, because they are the same claim.
            The expected value goes through the ordinary `value` field, so it
            interpolates `${other}` like every other value in this dialog and
            one variable can be compared against another. */}
        {(kind === "assertion" && assert === "variable") ||
        (kind === "condition" && cond === "variable") ? (
          <>
            <Field label="Variable" orientation="vertical">
              <VariableChips
                variables={variables}
                selected={compareVar}
                onPick={(name) => setCompareVar(name)}
                emptyHint={
                  onCreateVariable
                    ? "This test declares no variables yet. Create one below."
                    : "This test declares no variables yet. Add one on the Variables tab."
                }
              />
            </Field>
            <Field label="Comparison" orientation="vertical">
              <Select value={compareOp} onValueChange={(v) => setCompareOp(v as CompareOp)}>
                <SelectTrigger size="small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPARE_OPS.map((op) => (
                    <SelectItem key={op} value={op}>
                      {COMPARE_OP_LABEL[op]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Text variant="small" color="secondary">
              Compares the variable&rsquo;s value as text, exactly as it is:{" "}
              <strong>case matters and whitespace is not tidied up</strong>, because that is what
              the generated check really does. The four numeric comparisons read both sides as
              numbers, and a side that is not one fails the step rather than passing quietly.
            </Text>
          </>
        ) : null}

        {kind === "echo" ? (
          <>
            <Text variant="small" color="secondary">
              Writes a line into the run log at this point &mdash; no assertion, and it can never
              fail. The companion to a capture step: it answers &ldquo;what <em>is</em>{" "}
              <code className="font-mono">{"${orderId}"}</code> here?&rdquo; without making the run
              depend on the answer.
            </Text>
            <Field label="Message" orientation="vertical">
              <Input
                size="small"
                value={echoText}
                placeholder="order is ${orderId}"
                onChange={(e) => setEchoText(e.target.value)}
              />
            </Field>
          </>
        ) : null}

        {kind === "reload" ? (
          <Text variant="small" color="secondary">
            Reload the current page (Playwright <code>page.reload()</code>), as if the user had
            pressed ⌘R. The test carries on from whatever the reloaded page shows — anything the
            page held only in memory is gone, which is usually the point of reloading.
          </Text>
        ) : null}

        {kind === "viewport" ? (
          <>
            <Text variant="small" color="secondary">
              Resize the browser window mid-test (Playwright <code>setViewportSize</code>). Runs as a
              step wherever it sits in the list, and the new size applies to every step after it.
            </Text>
            <Field label="Viewport" orientation="vertical">
              <Select value={viewport} onValueChange={setViewport}>
                <SelectTrigger size="small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESIZE_PRESETS.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {viewport === "custom" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Width" orientation="vertical">
                  <Input size="small" type="number" value={vw} onChange={(e) => setVw(e.target.value)} />
                </Field>
                <Field label="Height" orientation="vertical">
                  <Input size="small" type="number" value={vh} onChange={(e) => setVh(e.target.value)} />
                </Field>
              </div>
            ) : null}
          </>
        ) : null}

        {kind === "scroll" ? (
          <>
            <Text variant="small" color="secondary">
              Scroll the page before the next step. Content some pages render only on scroll
              (lazy lists, infinite feeds) is not on the page until this happens — an assertion
              on it fails in a run without a scroll step ahead of it.
            </Text>
            <Field label="Scroll to" orientation="vertical">
              <Select
                value={scrollMode}
                onValueChange={(v) => setScrollMode(v === "position" ? "position" : "element")}
              >
                <SelectTrigger size="small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="element">An element (scrollIntoViewIfNeeded)</SelectItem>
                  <SelectItem value="position">A page position (x, y)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {scrollMode === "element" ? (
              <TargetElementPicker
                picked={picked}
                onChange={setLocator}
                onStartPick={onStartPick}
                onClearPick={onClearPick}
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="X (px)" orientation="vertical">
                  <Input
                    size="small"
                    type="number"
                    value={scrollXDraft}
                    onChange={(e) => setScrollXDraft(e.target.value)}
                  />
                </Field>
                <Field label="Y (px)" orientation="vertical">
                  <Input
                    size="small"
                    type="number"
                    value={scrollYDraft}
                    onChange={(e) => setScrollYDraft(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </>
        ) : null}

        {kind === "capture" ? (
          <>
            <Field label="Store as variable" orientation="vertical">
              <Input
                size="small"
                value={captureVar}
                placeholder="orderId"
                className="font-mono"
                aria-label="Store as variable"
                onChange={(e) => setCaptureVar(e.target.value)}
              />
            </Field>
            <Text size="small" className="text-secondary">
              Later steps can use it as <code className="font-mono">{"${" + (captureVar || "name") + "}"}</code>.
              Declare it on the Variables tab to give it a fallback value.
            </Text>
            <Field label="Capture from" orientation="vertical">
              <Select
                value={captureFrom}
                onValueChange={(v) => setCaptureFrom(v as CaptureSource)}
              >
                <SelectTrigger size="small" aria-label="Capture from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAPTURE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {/* The element the value is read from — offered for every source
                except the two that read the page itself, the same rule and the
                same placement the assertion kind uses (source first, then what
                it acts on, then its operands). Without it the four element
                sources were dead: `build()` refuses a capture with no target,
                so the panel asked for a variable name and then declined to add
                the step, with nothing on screen to complete. */}
            {!isPageLevelCapture(captureFrom) ? (
              <>
                <Text size="small" className="text-secondary">
                  {captureFrom === "count"
                    ? "Stores how many elements this locator matches. Several matches is the answer here, not a problem — a locator pinned to one element always captures 1."
                    : "The element this value is read from. Pick it in the training browser, or write a locator by hand."}
                </Text>
                <TargetElementPicker
                  picked={picked}
                  onChange={setLocator}
                  onStartPick={onStartPick}
                  onClearPick={onClearPick}
                />
              </>
            ) : null}
            {captureFrom === "attribute" ? (
              <Field label="Attribute" orientation="vertical">
                <Input
                  size="small"
                  value={captureAttr}
                  placeholder="href"
                  aria-label="Attribute"
                  onChange={(e) => setCaptureAttr(e.target.value)}
                />
              </Field>
            ) : null}
          </>
        ) : null}

        {kind === "download" ? (
          <>
            <Field label="Filename" orientation="vertical">
              <Input
                size="small"
                value={dlName}
                onChange={(e) => setDlName(e.target.value)}
                placeholder="report.csv — blank expects any download"
                aria-label="Expected filename"
              />
            </Field>
            {dlName.trim() !== "" ? (
              <SegmentedControl
                size="small"
                value={dlExact ? "exact" : "contains"}
                onValueChange={(v) => v && setDlExact(v === "exact")}
              >
                <SegmentedControlItem value="contains">Contains</SegmentedControlItem>
                <SegmentedControlItem value="exact">Exact name</SegmentedControlItem>
              </SegmentedControl>
            ) : null}
            <Field label="Save filename to variable (optional)" orientation="vertical">
              <Input
                size="small"
                value={dlVar}
                onChange={(e) => setDlVar(e.target.value)}
                placeholder="exportName"
                aria-label="Download filename variable"
              />
            </Field>
            <Text size="small" className="text-secondary">
              Expects the PREVIOUS step to start a file download — the run arms the listener
              before that step, then verifies the filename. In the trainer, transfers are
              cancelled and this records what to expect.
            </Text>
          </>
        ) : null}

        {kind === "loop" ? (
          <>
            <Field label="Times" orientation="vertical">
              <Input
                size="small"
                inputMode="numeric"
                value={loopTimes}
                onChange={(e) => setLoopTimes(e.target.value)}
                aria-label="Loop count"
                className="w-20"
              />
            </Field>
            <Text size="small" className="text-secondary">
              Inserts a repeat block. Drag the steps to run between the two halves — they run in
              order, that many times. The trainer&apos;s preview walks the body once; the real run
              repeats it.
            </Text>
          </>
        ) : null}

        {kind === "runFlow" ? (
          <>
            <Field label="Flow" orientation="vertical">
              <Select
                value={flowId}
                onValueChange={(id) => {
                  setFlowId(id);
                  setFlowArgVals({});
                }}
              >
                <SelectTrigger size="small">
                  <SelectValue placeholder="Choose a flow" />
                </SelectTrigger>
                <SelectContent>
                  {flows.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {(() => {
              const selected = flows.find((f) => f.id === flowId);
              if (!selected || selected.flowParams.length === 0) return null;
              return (
                <FlowArgsFields
                  params={selected.flowParams}
                  defaults={selected.paramDefaults}
                  values={flowArgVals}
                  onChange={setFlowArgVals}
                />
              );
            })()}
            {flows.length === 0 ? (
              <Text size="small" className="text-tertiary">
                No flows yet. Mark a test as a reusable flow on its Variables tab to call it from
                here.
              </Text>
            ) : (
              <Text size="small" className="text-secondary">
                The flow's steps are inlined into this test's script when it runs.
              </Text>
            )}
            {flowId ? (
              <>
                <Field label="Repeat" orientation="vertical">
                  <SegmentedControl
                    size="small"
                    value={flowRepeatMode}
                    onValueChange={(v) => setFlowRepeatMode(v as "once" | "count" | "variable")}
                  >
                    <SegmentedControlItem value="once">Once</SegmentedControlItem>
                    <SegmentedControlItem value="count">N times</SegmentedControlItem>
                    <SegmentedControlItem value="variable">By variable</SegmentedControlItem>
                  </SegmentedControl>
                </Field>
                {flowRepeatMode === "count" ? (
                  <Field label="Times" orientation="vertical">
                    <Input
                      size="small"
                      type="number"
                      min={2}
                      max={100}
                      value={flowRepeatCount}
                      aria-label="Repeat count"
                      onChange={(e) => setFlowRepeatCount(e.target.value)}
                    />
                  </Field>
                ) : null}
                {flowRepeatMode === "variable" ? (
                  <>
                    <Field label="Count variable" orientation="vertical">
                      <Input
                        size="small"
                        className="font-mono"
                        value={flowRepeatName}
                        placeholder="resultCount"
                        aria-label="Repeat count variable"
                        onChange={(e) => setFlowRepeatName(e.target.value)}
                      />
                    </Field>
                    <Text size="small" className="text-secondary">
                      The variable&apos;s value at run time decides how many times the flow runs
                      (capped at 100). Each iteration uses the same parameter values.
                    </Text>
                  </>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {kind === "assertion" ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Assertion" orientation="vertical">
                <Select value={assert} onValueChange={(v) => setAssert(v as AssertKind)}>
                  <SelectTrigger size="small" aria-label="Assertion">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSERT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Type" orientation="vertical">
                <SegmentedControl
                  size="small"
                  value={soft ? "soft" : "hard"}
                  onValueChange={(v) => setSoft(v === "soft")}
                >
                  <SegmentedControlItem value="hard">Hard</SegmentedControlItem>
                  <SegmentedControlItem value="soft">Soft</SegmentedControlItem>
                </SegmentedControl>
              </Field>
            </div>

            {!opt.pageLevel ? (
              <TargetElementPicker
                picked={picked}
                onChange={setLocator}
                onStartPick={onStartPick}
                onClearPick={onClearPick}
              />
            ) : null}

            {opt.need === "text" ? (
              <Field label="Text" orientation="vertical">
                <Input size="small" value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
            ) : null}
            {opt.need === "value" ? (
              // The label carries the kind's own contract, because the values
              // are LITERAL — the old copy said "substring or regex", and a
              // user who took it at its word got an assertion that matched
              // their pattern characters, not their pattern.
              <Field
                label={
                  assert === "urlPathIs"
                    ? "Expected path (query string and #fragment ignored)"
                    : "Expected value"
                }
                orientation="vertical"
              >
                <Input size="small" value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            ) : null}
            {opt.need === "attr" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Attribute" orientation="vertical">
                  <Input size="small" value={attr} onChange={(e) => setAttr(e.target.value)} />
                </Field>
                <Field label="Expected value" orientation="vertical">
                  <Input size="small" value={value} onChange={(e) => setValue(e.target.value)} />
                </Field>
              </div>
            ) : null}
            {opt.need === "count" ? (
              <Field label="Expected count" orientation="vertical">
                <Input size="small" type="number" value={count} onChange={(e) => setCount(e.target.value)} />
              </Field>
            ) : null}
            {opt.need === "css" ? (
              <CssAssertFields
                picked={picked}
                cssProp={cssProp}
                onCssProp={setCssProp}
                cssMatch={cssMatch}
                onCssMatch={setCssMatch}
                value={value}
                onValue={setValue}
              />
            ) : null}
          </>
        ) : null}

        {kind === "elementState" ? (
          <>
            <Text variant="small" color="secondary">
              Put an element into a pseudo-state so the assertion after it measures the
              styled state instead of the resting one. Add your CSS assertion directly
              after these steps.
            </Text>
            <Field label="State" orientation="vertical">
              <Select value={statePick} onValueChange={(v) => setStatePick(v as StatePick)}>
                <SelectTrigger size="small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATE_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {/* The row count is stated BEFORE the submit. Two of the four picks
                add more than one row, and a dialog that silently turns one
                choice into three steps reads as a bug the first time. */}
            <Text variant="small" color="tertiary">
              Adds {STATE_OPTIONS.find((s) => s.value === statePick)?.emits}.
              {statePick === "active"
                ? " Drag your assertion between the press and release rows."
                : null}
              {statePick === "focusVisible"
                ? " Focus rings that only appear for keyboard users need the Tab first; browsers differ on this, so verify it on the engines you run."
                : null}
            </Text>
            <TargetElementPicker
              picked={picked}
              onChange={setLocator}
              onStartPick={onStartPick}
              onClearPick={onClearPick}
            />
          </>
        ) : null}

        {kind === "condition" ? (
          <>
            <Text variant="small" color="secondary">
              Wrap steps in a conditional block. Steps you drag between the{" "}
              <code>if</code> and <code>end if</code> rows run only when this condition is
              true — otherwise they’re skipped and the test continues.
            </Text>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={withElse}
                onCheckedChange={(v: boolean | "indeterminate") => setWithElse(v === true)}
                aria-label="Include an ELSE branch"
              />
              <Text variant="small">Include an ELSE branch — steps after it run when the condition does NOT hold</Text>
            </label>
            <Field label="Run the block when" orientation="vertical">
              <Select value={cond} onValueChange={(v) => setCond(v as ConditionKind)}>
                <SelectTrigger size="small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {condOpt.page ? (
              <Field label="Substring (or regex)" orientation="vertical">
                <Input size="small" value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            ) : (
              <TargetElementPicker
                picked={picked}
                onChange={setLocator}
                onStartPick={onStartPick}
                onClearPick={onClearPick}
              />
            )}
          </>
        ) : null}
        {kind === "aiCheck" ? (
          <>
            <Text size="small" className="text-secondary">
              Screenshots the page at this point; after the run, your configured AI model judges
              the claim against it. The run itself never fails on the verdict — failed claims are
              counted on the run and listed in its output.
            </Text>
            <Field label="The claim to verify" orientation="vertical">
              <textarea
                aria-label="AI check claim"
                className="gl-textarea"
                rows={2}
                placeholder="The cart badge shows 3 items"
                value={aiClaim}
                onChange={(e) => setAiClaim(e.target.value)}
              />
            </Field>
          </>
        ) : null}
        {kind === "group" ? (
          <>
            <Text size="small" className="text-secondary">
              Inserts a named section — organization only, nothing runs. Drag steps between the
              group and its end; the spec carries the name as a comment.
            </Text>
            <Field label="Group name" orientation="vertical">
              <Input
                size="small"
                aria-label="Group name"
                placeholder="Log in"
                value={groupLabel}
                onChange={(e) => setGroupLabel(e.target.value)}
              />
            </Field>
          </>
        ) : null}
        {kind === "teardown" ? (
          <Text size="small" className="text-secondary">
            Splits the test: every step below this row runs even when a step above it
            failed — cleanup that has to happen either way. The test still fails for the
            original reason; a teardown step that fails on its own is reported too. One
            per test, and it cannot sit inside an if or repeat block.
          </Text>
        ) : null}
        {kind === "dialog" ? (
          <>
            <Text size="small" className="text-secondary">
              Arms a one-shot answer for the NEXT alert, confirm or prompt — place it BEFORE the
              step that triggers the dialog. Without one, runs auto-dismiss every dialog. For a
              pop-up or banner the page itself draws — a newsletter form, a cookie-consent banner
              — use Handle pop-ups instead: it is in the run options, and in Settings → Overlay
              rules.
            </Text>
            <Field label="Answer" orientation="vertical">
              <SegmentedControl
                size="small"
                value={dialogAction}
                onValueChange={(v) => setDialogAction(v as DialogAction)}
              >
                <SegmentedControlItem value="accept">Accept</SegmentedControlItem>
                <SegmentedControlItem value="dismiss">Dismiss</SegmentedControlItem>
              </SegmentedControl>
            </Field>
            {dialogAction === "accept" ? (
              <Field label="Prompt text (optional)" orientation="vertical">
                <Input
                  size="small"
                  aria-label="Prompt text"
                  placeholder="Jane"
                  value={dialogText}
                  onChange={(e) => setDialogText(e.target.value)}
                />
              </Field>
            ) : null}
          </>
        ) : null}
        {kind === "a11y" ? (
          <>
            <Text size="small" className="text-secondary">
              Runs axe against the page at this point and FAILS the test on any new violation at
              or above the chosen impact. Violations already accepted on this test&apos;s
              Accessibility tab don&apos;t fail the gate.
            </Text>
            <Field label="Fail on" orientation="vertical">
              <Select value={a11yImpact} onValueChange={(v) => setA11yImpact(v as A11yImpact)}>
                <SelectTrigger size="small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {A11Y_IMPACTS.map((impact) => (
                    <SelectItem key={impact} value={impact}>
                      {impact === "minor" ? "minor or worse (strictest)" : impact + " or worse"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </>
        ) : null}
        {kind === "upload" ? (
          <>
            <Text size="small" className="text-secondary">
              Sets a file input&apos;s files. The picked file is COPIED into this test&apos;s own
              fixtures, so the step keeps working when the original moves. The preview narrates
              it; runs perform it.
            </Text>
            <TargetElementPicker
              picked={picked}
              onChange={setLocator}
              onStartPick={onStartPick}
              onClearPick={onClearPick}
            />
            <div className="flex items-center gap-2">
              <Btn
                tone="ghost"
                disabled={uploadBusy}
                onClick={() => {
                  setUploadBusy(true);
                  void api.recorder
                    .stageUpload()
                    .then((res) => {
                      if (res.canceled) return;
                      if (res.problem || !res.relPath) {
                        toast.error(res.problem ?? "Could not stage the file.");
                        return;
                      }
                      setUploadRel(res.relPath);
                      setUploadName(res.name ?? res.relPath);
                    })
                    .catch((err: unknown) => toast.error(String(err)))
                    .finally(() => setUploadBusy(false));
                }}
              >
                {uploadBusy ? "Choosing…" : "Choose file…"}
              </Btn>
              {uploadName ? (
                <Text size="small" className="font-mono">
                  {uploadName}
                </Text>
              ) : (
                <Text size="small" className="text-tertiary">
                  No file staged yet.
                </Text>
              )}
            </div>
          </>
        ) : null}
        {kind === "emailCode" ? (
          <>
            <Text size="small" className="text-secondary">
              Waits for the one-time code emailed to this address and puts it in a variable — the
              way into a store whose sign-in has no password. A later step types{" "}
              <code className="font-mono">{"${" + (emailVar.trim() || "loginCode") + "}"}</code>{" "}
              into the form. Needs a mailbox in Settings &rsaquo; Integrations. Only mail that
              arrives <strong>after this run starts</strong> counts, so a code already sitting in
              the inbox is never typed.
            </Text>
            <div className="flex items-center gap-2">
              <Input
                size="small"
                aria-label="Mailbox address"
                placeholder="shopper@mail.example.com"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={emailAddress}
                className="flex-1"
                onChange={(e) => setEmailAddress(e.target.value)}
              />
              <Input
                size="small"
                aria-label="Store the code in"
                placeholder="loginCode"
                value={emailVar}
                className="w-40"
                onChange={(e) => setEmailVar(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Input
                size="small"
                aria-label="Code length"
                placeholder="6"
                value={emailDigits}
                className="w-20"
                onChange={(e) => setEmailDigits(e.target.value)}
              />
              <Input
                size="small"
                aria-label="Code follows this text"
                placeholder="Code follows this text (optional)"
                value={emailLabel}
                className="flex-1"
                onChange={(e) => setEmailLabel(e.target.value)}
              />
            </div>
          </>
        ) : null}
        {kind === "api" ? (
          <>
            <Text size="small" className="text-secondary">
              One HTTP request through the run&apos;s browser context (cookies carry over).
              Without an expected status the step still fails on any 4xx/5xx. Values accept{" "}
              <code className="font-mono">{"${variable}"}</code> references.
            </Text>
            <div className="flex items-center gap-2">
              <Select value={apiMethod} onValueChange={(v) => setApiMethod(v as ApiMethod)}>
                <SelectTrigger size="small" aria-label="Method" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {API_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                size="small"
                aria-label="Request URL"
                placeholder="https://api.example.com/users"
                value={apiUrl}
                className="flex-1"
                onChange={(e) => setApiUrl(e.target.value)}
              />
            </div>
            <Field label="Headers — one per line, Name: value" orientation="vertical">
              <textarea
                aria-label="Request headers"
                className="gl-textarea"
                rows={2}
                value={apiHeadersDraft}
                onChange={(e) => setApiHeadersDraft(e.target.value)}
              />
            </Field>
            <Field label="Body (optional)" orientation="vertical">
              <textarea
                aria-label="Request body"
                className="gl-textarea"
                rows={3}
                value={apiBody}
                onChange={(e) => setApiBody(e.target.value)}
              />
            </Field>
            <div className="flex items-center gap-2">
              <Field label="Expect status (optional)" orientation="vertical">
                <Input
                  size="small"
                  aria-label="Expected status"
                  placeholder="200"
                  className="w-24"
                  value={apiStatus}
                  onChange={(e) => setApiStatus(e.target.value)}
                />
              </Field>
              <Field label="Capture into variable (optional)" orientation="vertical">
                <Input
                  size="small"
                  aria-label="Capture variable"
                  placeholder="userId"
                  className="w-36 font-mono"
                  value={apiCaptureVar}
                  onChange={(e) => setApiCaptureVar(e.target.value)}
                />
              </Field>
              <Field label="JSON path (optional)" orientation="vertical">
                <Input
                  size="small"
                  aria-label="Capture JSON path"
                  placeholder="data.items[0].id"
                  className="w-44 font-mono"
                  value={apiCapturePath}
                  onChange={(e) => setApiCapturePath(e.target.value)}
                />
              </Field>
            </div>
          </>
        ) : null}
      </div>
      <div className="gl-composer-foot">
        {ambiguousTarget !== null ? (
          <Text variant="small" color="tertiary" className="min-w-0 flex-1" data-gl="ambiguous-target">
            {ambiguousTargetHint(ambiguousTarget)}
          </Text>
        ) : null}
        {/* Disabled until the step is actually buildable, and the reason is
            worth a sentence: `build()` returns null for a half-filled form —
            a wait with no element, a capture with no variable name, a CSS
            assert whose property is malformed — and the modal answered that
            by doing nothing when confirmed. In a panel that stays where it is,
            a button that silently declines is indistinguishable from a broken
            one. */}
        <Btn tone="go" onClick={submit} disabled={!ready}>
          Add step
        </Btn>
        <Btn tone="ghost" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

