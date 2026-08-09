// InsertGap — the cursor between two steps.
//
// 7px at rest, 16px hovered, a lit rule when it is where the next step will
// land. It is the affordance that makes a step list something you compose IN
// rather than append to, and it is the prerequisite for retiring the 1,170-line
// add-step dialog in Phase C (REDESIGN §6.2): once the cursor exists, "add a
// step" has somewhere to put one and no longer needs a modal to ask.
//
// IT GROWS ON HOVER RATHER THAN APPEARING. A control that materialises under
// the pointer is a control nobody discovers, because it is invisible in every
// screenshot, every demo and every first look at the screen. 7px of permanent
// dead space between rows is a hint that something lives there; zero px is not.
//
// AND THE LIST MUST NOT REFLOW WHEN IT GROWS. The gap animates its own height,
// so hovering between steps 3 and 4 pushes everything below down by 9px — which
// would make the row you were aiming at move out from under the cursor. So the
// element keeps a FIXED 16px footprint and the visible rule inside it is what
// changes: nothing below ever moves.

import * as React from "react";

export interface InsertGapProps {
  /** Where a step inserted here would land. */
  index: number;
  /** This is the current insert point. Draws the lit rule. */
  active?: boolean;
  onInsert?: (index: number) => void;
  /** Names the position for assistive tech — "Insert step after step 3". A row
   *  of identical "insert" buttons is unusable without it. */
  label: string;
}

export function InsertGap({ index, active, onInsert, label }: InsertGapProps): React.ReactElement {
  return (
    <button
      type="button"
      className="gl-insert-gap"
      data-gl="insert-gap"
      data-active={active ? "true" : undefined}
      data-index={index}
      aria-label={label}
      onClick={() => onInsert?.(index)}
    >
      <span className="gl-insert-gap-rule" aria-hidden />
    </button>
  );
}
