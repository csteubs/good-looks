// MenuItem — a label, and a line saying what choosing it does.
//
// THE CONSEQUENCE LINE IS THE WHOLE POINT OF THIS PRIMITIVE. A menu of bare
// labels makes the user guess, and the guesses are expensive here: the
// concurrency menu in Batch is a row of numbers where the honest description of
// "8" is *"a laptop will thrash and report failures it caused"* — a failure
// mode that looks exactly like a flaky suite and costs an afternoon to
// diagnose. The number cannot say that. A second line can.
//
// So `consequence` is not a tooltip and not a disclosure. It renders
// unconditionally, in the menu, at the moment of choosing — the same rule
// Settings uses for `risk` copy (REDESIGN §B4: a row with `risk` renders it
// unconditionally, never behind a disclosure). Copy that only appears on hover
// is copy that is not there: Radix tooltips cannot even be opened under jsdom,
// so it would also be untestable.
//
// `danger` takes the red inset rail — the same vocabulary as a failing step
// row, deliberately, so "this can bite you" looks the same everywhere in the
// app rather than being reinvented per surface.

import * as React from "react";

import { TONE, insetRail } from "../tokens";

export interface MenuItemProps {
  label: string;
  /** What happens if you pick this. Renders unconditionally — see the header. */
  consequence?: string;
  /** Destructive or irreversible. Takes the red rail. */
  danger?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export function MenuItem({
  label,
  consequence,
  danger,
  selected,
  disabled,
  onSelect,
}: MenuItemProps): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      className="gl-menu-item"
      data-gl="menu-item"
      data-danger={danger ? "true" : undefined}
      // `aria-current`, not `aria-selected`: this is "the one in force", not a
      // selection within a listbox, and a screen reader says so differently.
      aria-current={selected ? "true" : undefined}
      disabled={disabled}
      onClick={onSelect}
      style={danger ? { boxShadow: insetRail(TONE.red) } : undefined}
    >
      <span className="gl-menu-item-label">{label}</span>
      {consequence !== undefined ? (
        <span className="gl-menu-item-consequence">{consequence}</span>
      ) : null}
    </button>
  );
}
