// Manually add a trainer step without interacting with the page — mabl's
// "Add step" menu. One dialog renders the fields for the chosen kind and returns
// a RawStep that the trainer inserts at the current cursor.

import * as React from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
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
} from "@ui";
import { Crosshair, X } from "lucide-react";

import {
  CSS_ASSERT_PROPS,
  DEFAULT_WAIT_TIMEOUT_MS,
  isCssPropName,
} from "../lib/recorder-types";
import type {
  AssertKind,
  CaptureSource,
  ConditionKind,
  CssMatch,
  Locator,
  PickedElement,
  RawStep,
  WaitDialogMode,
  WaitUntilKind,
} from "../lib/recorder-types";
import { api } from "../lib/api";
import { buildStateSteps, type StatePick } from "../lib/element-states";
import { clampViewportAxis, RESIZE_PRESETS } from "../lib/viewport-presets";
import { formatLocator, KIND_LABEL } from "./refine-selector-dialog";

export type AddStepKind =
  | "assertion"
  | "condition"
  | "wait"
  | "goto"
  | "press"
  | "find"
  | "viewport"
  | "capture"
  | "runFlow"
  | "elementState";

export const ADD_STEP_LABEL: Record<AddStepKind, string> = {
  assertion: "Add assertion",
  condition: "Add condition (if)",
  wait: "Add wait",
  goto: "Go to URL",
  press: "Press key",
  find: "Find element",
  viewport: "Set viewport",
  capture: "Capture a value",
  runFlow: "Run a flow",
  elementState: "Set element state",
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
const CAPTURE_OPTIONS: { value: CaptureSource; label: string; page?: boolean }[] = [
  { value: "text", label: "Element text" },
  { value: "value", label: "Input value" },
  { value: "attribute", label: "Element attribute" },
  { value: "url", label: "Page URL", page: true },
  { value: "title", label: "Page title", page: true },
];

// Condition predicates for an `if` block. Element conditions resolve a picked
// locator; page conditions match a substring of the current URL / title.
const CONDITION_OPTIONS: { value: ConditionKind; label: string; page?: boolean }[] = [
  { value: "visible", label: "Element is visible" },
  { value: "hidden", label: "Element is hidden" },
  { value: "exists", label: "Element exists" },
  { value: "enabled", label: "Element is enabled" },
  { value: "disabled", label: "Element is disabled" },
  { value: "checked", label: "Element is checked" },
  { value: "unchecked", label: "Element is unchecked" },
  { value: "urlContains", label: "Page URL contains", page: true },
  { value: "titleContains", label: "Page title contains", page: true },
];

// "Wait until" predicates. Element predicates resolve the picked locator; the
// two page predicates match a substring of the live URL / title. Mirrors the
// assertion list deliberately — a user who knows the assertion vocabulary
// already knows this one.
const WAIT_UNTIL_OPTIONS: {
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
type Need = "none" | "text" | "value" | "attr" | "count" | "css";
const ASSERT_OPTIONS: {
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
  { value: "url", label: "URL contains", need: "value", pageLevel: true },
  { value: "urlEndsWith", label: "URL ends with", need: "value", pageLevel: true },
  { value: "urlIs", label: "URL is", need: "value", pageLevel: true },
  { value: "title", label: "Page title is", need: "value", pageLevel: true },
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
  onChange: (loc: Locator) => void;
  onStartPick: () => void;
  onClearPick: () => void;
}) {
  const [selected, setSelected] = React.useState(0);
  const candidates = picked?.candidates ?? [];

  // Seed the locator from the best candidate when a fresh element arrives.
  React.useEffect(() => {
    setSelected(0);
    if (candidates[0]) onChange(candidates[0]);
    // onChange/candidates derive from picked; re-seed only on a new pick.
  }, [picked]);

  if (!picked || candidates.length === 0) {
    return (
      <Field label="Target element" orientation="vertical">
        <Button variant="secondary" size="small" onClick={onStartPick} className="w-fit">
          <Crosshair className="size-3.5" />
          {picked ? "No locator found — pick another" : "Pick element in browser"}
        </Button>
        {picked ? (
          <Text variant="small" color="tertiary">
            No locator could be derived for the picked element. Try another element.
          </Text>
        ) : null}
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
                  onChange(l);
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
        </div>
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

export function AddStepDialog({
  open,
  kind,
  onOpenChange,
  onAdd,
  picked,
  onStartPick,
  onClearPick,
  initialAssert,
  initialWaitMode,
  initialState,
  prefillText,
  prefillValue,
  currentTestId,
}: {
  open: boolean;
  kind: AddStepKind;
  /** The test being edited, so it can't be offered as a flow to call itself. */
  currentTestId?: string;
  onOpenChange: (open: boolean) => void;
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
}) {
  const [locator, setLocator] = React.useState<Locator | null>(null);
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
  const [captureVar, setCaptureVar] = React.useState("");
  const [captureFrom, setCaptureFrom] = React.useState<CaptureSource>("text");
  const [captureAttr, setCaptureAttr] = React.useState("");
  const [flowId, setFlowId] = React.useState("");

  // Reset transient fields whenever a fresh dialog opens. When opened from the
  // right-click menu, seed the assert kind / wait mode / text / value from the
  // context action so the dialog opens already targeted at the right-clicked
  // element.
  React.useEffect(() => {
    if (open) {
      setLocator(null);
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
      setWaitMs("1000");
      setPressTarget("page");
      setViewport("desktop");
      setVw("1280");
      setVh("800");
      setCaptureVar("");
      setCaptureFrom("text");
      setCaptureAttr("");
      setFlowId("");
    }
  }, [open, kind, initialAssert, initialWaitMode, initialState, prefillText, prefillValue]);

  // Flows available to call from here. Fetched when the dialog opens rather
  // than held by the parent, so a flow created in another window shows up
  // without a reload.
  const [flows, setFlows] = React.useState<{ id: string; name: string; flowParams: string[] }[]>([]);
  React.useEffect(() => {
    if (!open || kind !== "runFlow") return;
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
  }, [open, kind, currentTestId]);

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
      case "find":
        return locator ? [{ type: "assert", assert: "visible", locator }] : null;
      case "capture": {
        const name = captureVar.trim();
        if (!name) return null;
        const pageLevel = captureFrom === "url" || captureFrom === "title";
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
        return [
          {
            type: "runFlow",
            flowId,
            // The name is stored on the step so the list stays readable even if
            // the flow is later renamed or deleted.
            label: flow?.name ?? flowId,
          },
        ];
      }
      case "condition": {
        // Insert an empty IF/END-IF pair; the user drags steps between them.
        const ifStep: RawStep = { type: "if", cond };
        if (condOpt.page) {
          ifStep.value = value;
        } else {
          if (!locator) return null;
          ifStep.locator = locator;
        }
        return [ifStep, { type: "endif" }];
      }
      case "assertion": {
        const step: RawStep = { type: "assert", assert, soft: soft || undefined };
        if (!opt.pageLevel) {
          if (!locator) return null;
          step.locator = locator;
        }
        if (opt.need === "text") step.text = text;
        if (opt.need === "value") step.value = value;
        if (opt.need === "attr") {
          step.attr = attr;
          step.value = value;
        }
        if (opt.need === "count") step.count = Number(count) || 0;
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

  function submit() {
    const steps = build();
    if (!steps || steps.length === 0) return;
    onAdd(steps);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={ADD_STEP_LABEL[kind]}
      size="large"
      onConfirm={submit}
      confirmLabel="Add step"
    >
      <div className="flex flex-col gap-3">
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

        {kind === "capture" ? (
          <>
            <Field label="Store as variable" orientation="vertical">
              <Input
                size="small"
                value={captureVar}
                placeholder="orderId"
                className="font-mono"
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
                <SelectTrigger size="small">
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
            {captureFrom === "attribute" ? (
              <Field label="Attribute" orientation="vertical">
                <Input
                  size="small"
                  value={captureAttr}
                  placeholder="href"
                  onChange={(e) => setCaptureAttr(e.target.value)}
                />
              </Field>
            ) : null}
          </>
        ) : null}

        {kind === "runFlow" ? (
          <>
            <Field label="Flow" orientation="vertical">
              <Select value={flowId} onValueChange={setFlowId}>
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
            {flows.length === 0 ? (
              <Text size="small" className="text-tertiary">
                No flows yet. Mark a test as a reusable flow to call it from here.
              </Text>
            ) : (
              <Text size="small" className="text-secondary">
                The flow's steps are inlined into this test's script when it runs.
              </Text>
            )}
          </>
        ) : null}

        {kind === "assertion" ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Assertion" orientation="vertical">
                <Select value={assert} onValueChange={(v) => setAssert(v as AssertKind)}>
                  <SelectTrigger size="small">
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
              <Field label={opt.pageLevel ? "Expected (substring or regex)" : "Expected value"} orientation="vertical">
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
      </div>
    </Dialog>
  );
}

