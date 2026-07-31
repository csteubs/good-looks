// Review dialog for the "Refine Selector" picker. Shows the element the user
// picked in the training window — its candidate locators (best-first) plus CSS
// context — and inserts a "Find element" step (assert visible) using the chosen
// locator. Closing either way resumes the paused training session.

import * as React from "react";
import { Badge, Dialog, Text } from "@glaze/core/components";

import type { Locator, PickedElement, RawStep } from "../lib/recorder-types";

/** Playwright-style label for a locator candidate. */
function formatLocator(l: Locator): string {
  switch (l.k) {
    case "testid":
      return `getByTestId(${JSON.stringify(l.v ?? "")})`;
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

const KIND_LABEL: Record<Locator["k"], string> = {
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
  onInsert,
  onClose,
}: {
  picked: PickedElement;
  onInsert: (step: RawStep) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = React.useState(0);

  // Reset selection whenever a new element is picked.
  React.useEffect(() => {
    setSelected(0);
  }, [picked]);

  const candidates = picked.candidates ?? [];
  const cssEntries = Object.entries(picked.css ?? {});

  function insert() {
    const loc = candidates[selected];
    if (loc) onInsert({ type: "assert", assert: "visible", locator: loc });
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Refine Selector"
      size="large"
      onConfirm={insert}
      confirmLabel="Insert Find step"
    >
      <div className="flex flex-col gap-4">
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

        {cssEntries.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Text variant="small" color="secondary">
              CSS properties
            </Text>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-separator px-3 py-2">
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
          Inserting adds a “Find element” assertion at the current insert point, then resumes
          recording.
        </Text>
      </div>
    </Dialog>
  );
}
