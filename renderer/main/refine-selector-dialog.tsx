// Review dialog for the "Refine Selector" picker. Shows the element the user
// picked in the training window — its candidate locators (best-first) plus CSS
// context — and applies the chosen locator to the step being refined. Closing
// either way resumes the paused training session.

import * as React from "react";
import { Badge, Dialog, Text } from "@ui";

import { ElementContextPicker } from "./element-context-picker";
import { testIdOverride, testIdSelector } from "../../shared/testid-attr.mjs";
import type { Locator, LocatorContext, PickedElement } from "../lib/recorder-types";

/** Playwright-style label for a locator candidate. */
export function formatLocator(l: Locator): string {
  switch (l.k) {
    case "testid": {
      // Mirrors locatorBase in script-generator.ts — what this label promises
      // is the call the generated script will contain.
      const attr = testIdOverride(l.attr);
      return attr
        ? `locator(${JSON.stringify(testIdSelector(attr, l.v ?? ""))})`
        : `getByTestId(${JSON.stringify(l.v ?? "")})`;
    }
    case "role":
      return l.name
        ? `getByRole(${JSON.stringify(l.role ?? "")}, { name: ${JSON.stringify(l.name)} })`
        : `getByRole(${JSON.stringify(l.role ?? "")})`;
    case "label":
      return `getByLabel(${JSON.stringify(l.v ?? "")})`;
    case "placeholder":
      return `getByPlaceholder(${JSON.stringify(l.v ?? "")})`;
    case "text":
      return `getByText(${JSON.stringify(l.v ?? "")})`;
    case "css":
      return `locator(${JSON.stringify(l.v ?? "")})`;
    case "xpath":
      return `locator(${JSON.stringify("xpath=" + (l.v ?? ""))})`;
    default:
      return JSON.stringify(l);
  }
}

export const KIND_LABEL: Record<Locator["k"], string> = {
  testid: "Test ID",
  role: "Role",
  label: "Label",
  placeholder: "Placeholder",
  text: "Text",
  css: "CSS",
  xpath: "XPath",
};

export function RefineSelectorDialog({
  picked,
  stepLabel,
  onApply,
  onClose,
}: {
  picked: PickedElement;
  /** short description of the step whose selector is being refined */
  stepLabel?: string;
  onApply: (locator: Locator) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = React.useState(0);
  const [ctx, setCtx] = React.useState<LocatorContext | null>(null);

  // Reset selection whenever a new element is picked.
  React.useEffect(() => {
    setSelected(0);
    setCtx(null);
  }, [picked]);

  const candidates = picked.candidates ?? [];
  const cssEntries = Object.entries(picked.css ?? {});

  function apply() {
    const loc = candidates[selected];
    if (!loc) {
      onClose();
      return;
    }
    // Context rides on the locator, so it is applied here rather than as a
    // second patch — `updateStep` drops a step's fingerprint when its locator
    // changes, and two separate writes would make that fire twice for one edit.
    const next: Locator = { ...loc };
    if (ctx) next.ctx = ctx;
    else delete next.ctx;
    onApply(next);
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Refine Selector"
      size="large"
      onConfirm={apply}
      confirmLabel="Update selector"
    >
      <div className="flex flex-col gap-4">
        {stepLabel ? (
          <Text variant="small" color="secondary">
            Refining selector for: <span className="font-mono text-primary">{stepLabel}</span>
          </Text>
        ) : null}

        <div className="flex flex-col gap-1">
          <Text variant="small" color="secondary">
            Picked element
          </Text>
          <code className="rounded bg-background-secondary px-2 py-1 font-mono text-xs text-primary">
            {picked.description || picked.tag || "element"}
          </code>
        </div>

        <div className="flex flex-col gap-2">
          <Text variant="small" color="secondary">
            Choose a locator (best matches first)
          </Text>
          <div className="flex flex-col gap-1.5">
            {candidates.length === 0 ? (
              <Text variant="small" color="tertiary">
                No locator could be derived for this element.
              </Text>
            ) : (
              candidates.map((l, i) => {
                const active = i === selected;
                return (
                  <button
                    key={`${l.k}-${i}`}
                    type="button"
                    onClick={() => setSelected(i)}
                    className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                      active
                        ? "border-accent bg-accent/10"
                        : "border-separator hover:bg-background-secondary"
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
              })
            )}
          </div>
        </div>

        {candidates.length > 0 ? (
          <ElementContextPicker picked={picked} onChange={setCtx} />
        ) : null}

        {cssEntries.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Text variant="small" color="secondary">
              CSS properties
            </Text>
            {/* Two-up only when there is room, same rule as the step composer.
                This dialog also renders in the docked trainer panel, where the
                window is 360pt: two columns leave ~150 per cell, and a property
                name like `background-color` takes 116 of it, so the VALUE — the
                only part being read — truncated to "rg…". Stacking gives each
                pair the full width. The main window is never below 1000, so it
                keeps two columns. */}
            <div className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-md border border-separator px-3 py-2 sm:grid-cols-2">
              {cssEntries.map(([k, v]) => (
                <div key={k} className="flex min-w-0 items-baseline gap-2">
                  <code className="shrink-0 font-mono text-xs text-tertiary">{k}</code>
                  <code className="min-w-0 truncate font-mono text-xs text-primary">{v}</code>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <Text variant="small" color="tertiary">
          Updating replaces this step’s locator with the chosen one, then resumes recording.
        </Text>
      </div>
    </Dialog>
  );
}
