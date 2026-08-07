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
} from "@glaze/core/components";
import { Crosshair, X } from "lucide-react";

import { DEFAULT_WAIT_TIMEOUT_MS } from "../lib/recorder-types";
import type {
  AssertKind,
  CaptureSource,
  ConditionKind,
  Locator,
  PickedElement,
  RawStep,
  WaitDialogMode,
  WaitUntilKind,
} from "../lib/recorder-types";
import { api } from "../lib/api";
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
  | "runFlow";

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
};

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
type Need = "none" | "text" | "value" | "attr" | "count";
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
  { value: "url", label: "URL contains", need: "value", pageLevel: true },
  { value: "urlEndsWith", label: "URL ends with", need: "value", pageLevel: true },
  { value: "urlIs", label: "URL is", need: "value", pageLevel: true },
  { value: "title", label: "Page title is", need: "value", pageLevel: true },
];

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
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
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
                className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
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
  }, [open, kind, initialAssert, initialWaitMode, prefillText, prefillValue]);

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
          return [{ type: "viewport", width: Number(vw) || 1280, height: Number(vh) || 800 }];
        }
        const p = VIEWPORTS.find((v) => v.id === viewport);
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
        return [step];
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
            <div className="grid grid-cols-2 gap-3">
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
              <div className="grid grid-cols-2 gap-3">
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
            <Field label="Viewport" orientation="vertical">
              <Select value={viewport} onValueChange={setViewport}>
                <SelectTrigger size="small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VIEWPORTS.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {viewport === "custom" ? (
              <div className="grid grid-cols-2 gap-3">
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
            <div className="grid grid-cols-2 gap-3">
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
              <div className="grid grid-cols-2 gap-3">
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

const VIEWPORTS = [
  { id: "desktop", label: "Desktop 1280×800", w: 1280, h: 800 },
  { id: "laptop", label: "Laptop 1440×900", w: 1440, h: 900 },
  { id: "tablet", label: "Tablet 768×1024", w: 768, h: 1024 },
  { id: "mobile", label: "Mobile 390×844", w: 390, h: 844 },
] as const;
