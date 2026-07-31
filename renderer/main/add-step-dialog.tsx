// Manually add a trainer step without interacting with the page — mabl's
// "Add step" menu. One dialog renders the fields for the chosen kind and returns
// a RawStep that the trainer inserts at the current cursor.

import * as React from "react";
import {
  Badge,
  Button,
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

import type { AssertKind, Locator, PickedElement, RawStep } from "../lib/recorder-types";
import { formatLocator, KIND_LABEL } from "./refine-selector-dialog";

export type AddStepKind = "assertion" | "wait" | "goto" | "press" | "find" | "viewport";

export const ADD_STEP_LABEL: Record<AddStepKind, string> = {
  assertion: "Add assertion",
  wait: "Add wait",
  goto: "Go to URL",
  press: "Press key",
  find: "Find element",
  viewport: "Set viewport",
};

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
  { value: "url", label: "Page URL is", need: "value", pageLevel: true },
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

export function AddStepDialog({
  open,
  kind,
  onOpenChange,
  onAdd,
  picked,
  onStartPick,
  onClearPick,
}: {
  open: boolean;
  kind: AddStepKind;
  onOpenChange: (open: boolean) => void;
  onAdd: (step: RawStep) => void;
  /** Element the user picked in the training browser via the Target Element flow, if any. */
  picked: PickedElement | null;
  /** Enter pick mode — pauses the session so the user can click an element. */
  onStartPick: () => void;
  /** Clear the current pick (and leave pick mode). */
  onClearPick: () => void;
}) {
  const [locator, setLocator] = React.useState<Locator | null>(null);
  const [assert, setAssert] = React.useState<AssertKind>("visible");
  const [text, setText] = React.useState("");
  const [value, setValue] = React.useState("");
  const [attr, setAttr] = React.useState("");
  const [count, setCount] = React.useState("1");
  const [soft, setSoft] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [key, setKey] = React.useState("Enter");
  const [waitMode, setWaitMode] = React.useState<"time" | "element">("time");
  const [waitMs, setWaitMs] = React.useState("1000");
  const [pressTarget, setPressTarget] = React.useState<"page" | "element">("page");
  const [viewport, setViewport] = React.useState("desktop");
  const [vw, setVw] = React.useState("1280");
  const [vh, setVh] = React.useState("800");

  // Reset transient fields whenever a fresh dialog opens.
  React.useEffect(() => {
    if (open) {
      setLocator(null);
      setAssert("visible");
      setText("");
      setValue("");
      setAttr("");
      setCount("1");
      setSoft(false);
      setUrl("");
      setKey("Enter");
      setWaitMode("time");
      setWaitMs("1000");
      setPressTarget("page");
      setViewport("desktop");
      setVw("1280");
      setVh("800");
    }
  }, [open, kind]);

  const opt = ASSERT_OPTIONS.find((o) => o.value === assert)!;

  function build(): RawStep | null {
    switch (kind) {
      case "goto":
        return url.trim() ? { type: "goto", url: url.trim() } : null;
      case "press":
        return {
          type: "press",
          value: key || "Enter",
          ...(pressTarget === "element" && locator ? { locator } : {}),
        };
      case "wait":
        return waitMode === "time"
          ? { type: "wait", waitMs: Number(waitMs) || 0 }
          : locator
            ? { type: "wait", locator }
            : null;
      case "viewport": {
        if (viewport === "custom") {
          return { type: "viewport", width: Number(vw) || 1280, height: Number(vh) || 800 };
        }
        const p = VIEWPORTS.find((v) => v.id === viewport);
        return { type: "viewport", width: p?.w ?? 1280, height: p?.h ?? 800 };
      }
      case "find":
        return locator ? { type: "assert", assert: "visible", locator } : null;
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
        return step;
      }
      default:
        return null;
    }
  }

  function submit() {
    const step = build();
    if (!step) return;
    onAdd(step);
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
              <SegmentedControl
                size="small"
                value={waitMode}
                onValueChange={(v) => setWaitMode(v as "time" | "element")}
              >
                <SegmentedControlItem value="time">A duration</SegmentedControlItem>
                <SegmentedControlItem value="element">An element</SegmentedControlItem>
              </SegmentedControl>
            </Field>
            {waitMode === "time" ? (
              <Field label="Duration (ms)" orientation="vertical">
                <Input
                  size="small"
                  type="number"
                  value={waitMs}
                  onChange={(e) => setWaitMs(e.target.value)}
                />
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
