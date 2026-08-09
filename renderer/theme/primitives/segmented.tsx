// Segmented — a row of choices in one hairline box. Used ~12 times across the
// app (compare modes, scopes, layouts, ranges).
//
// THE ACTIVE ITEM IS NEUTRAL, NEVER A STATUS HUE. This is the primitive where
// that rule is easiest to break and hardest to notice: an accent-coloured
// active segment looks completely normal in isolation, and only misleads when
// it sits beside a red row — at which point the control is claiming to report
// something. A lift plus a ring, no colour. Pinned by
// `check:selection-neutral`.
//
// REAL BUTTONS WITH `aria-pressed`, not a radiogroup and not divs. Two
// consequences, both deliberate. Radix's `TabsTrigger` activates on
// pointer-down, which is why so many tests in this repo have to use
// `fireEvent.mouseDown` and why using `fireEvent.click` on one silently asserts
// against the previous tab (CLAUDE.md). These are plain buttons: `click` works,
// keyboard works, and the tests can say what they mean. And `aria-pressed` is
// what the stylesheet selects on, so the visual state cannot disagree with the
// announced one — there is no separate `selected` class to forget.

import * as React from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Native `title`, not a Tooltip — Radix tooltips cannot be opened under
   *  jsdom, so anything only reachable by hover is untestable copy. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Names the control for assistive tech. A bare row of buttons announces as
   *  five unrelated buttons otherwise. */
  label: string;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedProps<T>): React.ReactElement {
  return (
    <div
      className={["gl-segmented", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={label}
      data-gl="segmented"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="gl-segmented-item"
          aria-pressed={opt.value === value}
          disabled={opt.disabled}
          title={opt.title}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
