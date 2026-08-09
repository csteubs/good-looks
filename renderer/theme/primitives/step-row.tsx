// StepRow — one step in a list. Number, glyph, type chip, description, Temp.
//
// STATUS IS AN INSET 2px RAIL, not a background and not a border. This is the
// single most repeated motif in the design — step rows, diff lines, verdict
// blocks, menu hover, risk rows — and both alternatives were rejected for
// reasons this repo has already paid for:
//
//   • A background tint strong enough to read fights the text sitting on it,
//     and a step description is the thing you came to read.
//   • A real `border` participates in layout, so a list where some rows have
//     one and some do not JUMPS BY 2px per status change. `renderer/styles.css`
//     records exactly this bug being fixed once already, for `.step-new`.
//
// `box-shadow` is drawn outside the box model, so it composes: a row can be
// selected AND failing, and neither claim hides the other. The selection ring
// and the status rail are both shadows on the same element and are combined
// rather than overwriting one another — which is the bug `.step-new` hit when
// an animation touched the whole `box-shadow` property and silently erased the
// selection highlight.
//
// SELECTION IS NEUTRAL, never a status hue. On a row that is both selected and
// failing, a coloured selection would be a second thing claiming to report an
// outcome. Pinned by `check:selection-neutral`.

import * as React from "react";

import { SEL_BG, SEL_RING, TONE, insetRail } from "../tokens";
import type { ToneName } from "../tokens";
import { Temp } from "./temp";
import type { TempMode } from "./temp";
import { TypeChip } from "./type-chip";
import type { StepType } from "../../lib/recorder-types";

export interface StepRowProps {
  /** 1-based, as shown. Not the array index — a reader counts from one and a
   *  failure report that says "step 0" costs someone a minute. */
  index: number;
  type: StepType;
  description: string;
  /** The outcome, if this step has one. Absent means it has not run. */
  tone?: ToneName;
  /** A single glyph for the step's shape, drawn before the chip. */
  glyph?: React.ReactNode;
  selected?: boolean;
  /** Nesting depth for `if`/`endif` blocks. */
  indent?: number;
  ms?: number;
  median?: number | null;
  tempMode?: TempMode;
  onSelect?: () => void;
  /** Trailing controls — replay, refine, delete. */
  right?: React.ReactNode;
}

export function StepRow({
  index,
  type,
  description,
  tone,
  glyph,
  selected,
  indent = 0,
  ms,
  median,
  tempMode,
  onSelect,
  right,
}: StepRowProps): React.ReactElement {
  // Both shadows, in one declaration, composed rather than chosen between. The
  // rail is listed first so it sits at the leading edge under the ring.
  const shadows = [
    tone ? insetRail(TONE[tone]) : null,
    selected ? `inset 0 0 0 1px ${SEL_RING}` : null,
  ].filter(Boolean);

  return (
    <div
      className="gl-step-row"
      data-gl="step-row"
      data-tone={tone ?? "none"}
      data-selected={selected ? "true" : undefined}
      style={{
        ...(shadows.length ? { boxShadow: shadows.join(", ") } : null),
        ...(selected ? { background: SEL_BG } : null),
        paddingInlineStart: 8 + indent * 18,
      }}
      // A real button would nest the trailing controls inside a button, which
      // is invalid and swallows their clicks. `role="row"` with a click target
      // keeps the controls reachable; the list that owns these rows carries the
      // keyboard model.
      onClick={onSelect}
    >
      <span className="gl-step-index">{index}</span>
      {glyph !== undefined ? (
        <span className="gl-step-glyph" aria-hidden>
          {glyph}
        </span>
      ) : null}
      <TypeChip type={type} />
      <span className="gl-step-desc" title={description}>
        {description}
      </span>
      {ms !== undefined ? (
        <span className="gl-step-temp">
          <Temp ms={ms} median={median} mode={tempMode} />
        </span>
      ) : null}
      {right !== undefined ? <span className="gl-step-right">{right}</span> : null}
    </div>
  );
}
