// Manually add a trainer step without interacting with the page — mabl's
// "Add step" menu. One dialog renders the fields for the chosen kind and returns
// a RawStep that the trainer inserts at the current cursor.

import * as React from "react";
import {
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

import type { AssertKind, Locator, LocatorKind, RawStep } from "../lib/recorder-types";

export type AddStepKind = "assertion" | "wait" | "goto" | "press" | "find" | "viewport";

export const ADD_STEP_LABEL: Record<AddStepKind, string> = {
  assertion: "Add assertion",
  wait: "Add wait",
  goto: "Go to URL",
  press: "Press key",
  find: "Find element",
  viewport: "Set viewport",
};

// Locator kinds a user can pick for a manually-added step.
const LOCATOR_KINDS: { value: LocatorKind; label: string }[] = [
  { value: "css", label: "CSS selector" },
  { value: "xpath", label: "XPath" },
  { value: "text", label: "Text" },
  { value: "testid", label: "Test ID" },
  { value: "label", label: "Label" },
  { value: "placeholder", label: "Placeholder" },
  { value: "role", label: "Role" },
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
  { value: "url", label: "Page URL is", need: "value", pageLevel: true },
  { value: "title", label: "Page title is", need: "value", pageLevel: true },
];

function LocatorFields({
  locator,
  onChange,
}: {
  locator: Locator;
  onChange: (loc: Locator) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Locator" orientation="vertical">
        <Select value={locator.k} onValueChange={(k) => onChange({ ...locator, k: k as LocatorKind })}>
          <SelectTrigger size="small">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCATOR_KINDS.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={locator.k === "role" ? "Role" : "Value"} orientation="vertical">
        <Input
          size="small"
          placeholder={locator.k === "css" ? ".btn-primary" : locator.k === "xpath" ? "//button" : ""}
          value={locator.k === "role" ? locator.role ?? "" : locator.v ?? ""}
          onChange={(e) =>
            onChange(
              locator.k === "role"
                ? { ...locator, role: e.target.value }
                : { ...locator, v: e.target.value },
            )
          }
        />
      </Field>
      {locator.k === "role" ? (
        <Field label="Accessible name (optional)" orientation="vertical" className="col-span-2">
          <Input
            size="small"
            value={locator.name ?? ""}
            onChange={(e) => onChange({ ...locator, name: e.target.value })}
          />
        </Field>
      ) : null}
    </div>
  );
}

export function AddStepDialog({
  open,
  kind,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  kind: AddStepKind;
  onOpenChange: (open: boolean) => void;
  onAdd: (step: RawStep) => void;
}) {
  const [locator, setLocator] = React.useState<Locator>({ k: "css", v: "" });
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
      setLocator({ k: kind === "find" ? "css" : "css", v: "" });
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
          ...(pressTarget === "element" ? { locator } : {}),
        };
      case "wait":
        return waitMode === "time"
          ? { type: "wait", waitMs: Number(waitMs) || 0 }
          : { type: "wait", locator };
      case "viewport": {
        if (viewport === "custom") {
          return { type: "viewport", width: Number(vw) || 1280, height: Number(vh) || 800 };
        }
        const p = VIEWPORTS.find((v) => v.id === viewport);
        return { type: "viewport", width: p?.w ?? 1280, height: p?.h ?? 800 };
      }
      case "find":
        return { type: "assert", assert: "visible", locator };
      case "assertion": {
        const step: RawStep = { type: "assert", assert, soft: soft || undefined };
        if (!opt.pageLevel) step.locator = locator;
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
              <LocatorFields locator={locator} onChange={setLocator} />
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
              <LocatorFields locator={locator} onChange={setLocator} />
            )}
          </>
        ) : null}

        {kind === "find" ? (
          <>
            <Text variant="small" color="secondary">
              Assert an element is present on the page (Playwright <code>toBeVisible</code>).
            </Text>
            <LocatorFields locator={locator} onChange={setLocator} />
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

            {!opt.pageLevel ? <LocatorFields locator={locator} onChange={setLocator} /> : null}

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
