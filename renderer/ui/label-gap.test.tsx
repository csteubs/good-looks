// A Label that WRAPS its control has to put space between the two.
//
// The bug this pins: `Label` carried only typography classes, so
// `<Label><RadioGroupItem/>Ollama</Label>` — the shape used by every radio row
// in Settings — laid the text directly against the radio circle, which read as
// the two overlapping. Nothing catches this elsewhere: the pane tests find
// their options by accessible name, and that name is correct either way.
//
// Asserted on class names rather than computed spacing because the dom project
// runs with `css: false` (vitest.config.ts) — Tailwind utilities produce no
// values here, so a `getComputedStyle(...).gap` assertion would read "" for the
// fixed and the broken markup alike and pass vacuously forever.
// `check:renderer-classes` is what proves these names emit real rules.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Label, RadioGroup, RadioGroupItem } from "./index";

/** The `gap-N` step on an element, in Tailwind units. 0 when it has none. */
function gapStep(el: HTMLElement): number {
  for (const cls of el.classList) {
    const m = /^gap-(\d+(?:\.\d+)?)$/.exec(cls);
    if (m) return Number(m[1]);
  }
  return 0;
}

function isFlex(el: HTMLElement): boolean {
  return el.classList.contains("flex") || el.classList.contains("inline-flex");
}

function labelFor(name: string): HTMLElement {
  const el = screen.getByRole("radio", { name }).closest("label");
  if (!el) throw new Error(`the "${name}" radio is not wrapped in a label`);
  return el;
}

describe("Label spacing around a wrapped control", () => {
  it("separates the control from its text", () => {
    render(
      <Label>
        <RadioGroupItem value="ollama" aria-label="Ollama" />
        Ollama
      </Label>,
      { wrapper: ({ children }) => <RadioGroup value="ollama">{children}</RadioGroup> },
    );

    const label = labelFor("Ollama");
    expect(isFlex(label)).toBe(true);
    expect(gapStep(label)).toBeGreaterThan(0);
  });

  it("keeps a caller's own layout classes winning over the default", () => {
    render(<Label className="flex flex-wrap gap-2">Server URL</Label>);

    const label = screen.getByText("Server URL");
    // tailwind-merge must collapse inline-flex/flex to the caller's choice
    // rather than emitting both — `setting-row.tsx` relies on this.
    expect(label.classList.contains("inline-flex")).toBe(false);
    expect(label.classList.contains("flex")).toBe(true);
  });
});

describe("RadioGroup spacing between options", () => {
  it("puts more space between two options than inside one", () => {
    render(
      <RadioGroup value="ollama" orientation="horizontal">
        <Label>
          <RadioGroupItem value="ollama" aria-label="Ollama" />
          Ollama
        </Label>
        <Label>
          <RadioGroupItem value="lmstudio" aria-label="LM Studio" />
          LM Studio
        </Label>
      </RadioGroup>,
    );

    const group = screen.getByRole("radiogroup");
    const between = gapStep(group);
    const within = gapStep(labelFor("Ollama"));

    expect(within).toBeGreaterThan(0);
    expect(between).toBeGreaterThan(within);
  });
});
