// TypeChip — the step-type pill.
//
// Seventeen step types, and the chip is how a step list is scanned rather than
// read: `fill` rows and `assert` rows have different shapes of consequence, and
// the eye should find them without parsing the description.
//
// THE PALETTE IS SEPARATE FROM THE STATUS PALETTE, and that separation is the
// whole reason this is its own map rather than a reuse of `TONE`. A step's TYPE
// is not an outcome — an `assert` step is not "failing" because assertions are
// what fail — so the type colours are deliberately desaturated and read as
// categories, while the four status hues stay reserved for results. Put a
// status hue on a type chip and every step list looks like a list of verdicts.
//
// ONE THEME SHIPS. `syntax: phosphor` is fixed as the default (REDESIGN §0) and
// "Code & step colors" is a real setting, so the shape here is a map of themes
// with one entry — adding the others is a data change, not a refactor. It is
// written that way on purpose rather than hardcoding phosphor: a single-branch
// conditional invented later is where the second theme goes wrong.

import * as React from "react";

import type { StepType } from "../../lib/recorder-types";

export type SyntaxTheme = "phosphor";

/** Category colours, per theme. Muted on purpose — see the header. */
const SYNTAX: Record<SyntaxTheme, Record<StepType, string>> = {
  phosphor: {
    // Navigation and lifecycle — the frame around a test.
    goto: "#7fd6b0",
    viewport: "#7fd6b0",
    cookie: "#7fd6b0",
    capture: "#7fd6b0",
    // Interaction — the things a person did.
    click: "#8fd0e8",
    fill: "#8fd0e8",
    press: "#8fd0e8",
    select: "#8fd0e8",
    check: "#8fd0e8",
    uncheck: "#8fd0e8",
    scroll: "#8fd0e8",
    // Claims — the things that can be wrong.
    assert: "#d7c98a",
    state: "#d7c98a",
    // Control flow and waiting — the things that change what runs.
    if: "#b9a6e0",
    endif: "#b9a6e0",
    runFlow: "#b9a6e0",
    wait: "#9aa3a8",
  },
};

/** What the chip says. Not the raw union: `endif` reads as a typo, `runFlow`
 *  as a variable name, and both are shown to people who did not write them. */
const LABEL: Partial<Record<StepType, string>> = {
  endif: "end if",
  runFlow: "flow",
  viewport: "size",
};

export interface TypeChipProps {
  type: StepType;
  theme?: SyntaxTheme;
}

export function TypeChip({ type, theme = "phosphor" }: TypeChipProps): React.ReactElement {
  const color = SYNTAX[theme][type] ?? SYNTAX[theme].wait;
  return (
    <span
      className="gl-type-chip"
      data-gl="type-chip"
      data-type={type}
      style={{ color, borderColor: `${color}44` }}
    >
      {LABEL[type] ?? type}
    </span>
  );
}
