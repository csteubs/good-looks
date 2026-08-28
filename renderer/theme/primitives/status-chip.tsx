// StatusChip — one shape, one width, every status in the app.
//
// THE FIXED WIDTH IS THE POINT. Every chip is exactly `STATUS_W` (78px), so a
// column of them has ONE EDGE rather than a ragged one that shifts with the
// length of each word. That is a layout contract, not a style, and it fails one
// row at a time — a single chip sized to its content looks perfectly fine on
// its own and only reads as wrong beside the others. Nothing in the type system
// or the test suite can see it, hence `check:status-width`.
//
// Colour comes from the tone, derived in exactly one place: `tone + "55"` for
// the line over `tone + "12"` for the fill (`toneSurface` in tokens.ts).
//
// `running` IS NOT A TONE, and that is not a technicality. Running is the
// absence of an outcome, not one of the outcomes — give it a status hue and a
// row still in flight looks like a row that has finished and reported
// something. It takes the holo treatment instead, which is the same reason AI
// does: a treatment says "this is not a result".

import * as React from "react";

import { TONE, toneSurface } from "../tokens";
import type { ToneName } from "../tokens";

export interface StatusChipProps {
  /** Which outcome this is reporting. Omit for a neutral chip — a state that is
   *  real but is not a result ("Never run", "Skipped"). */
  tone?: ToneName;
  /** In flight. Takes the holo border and overrides `tone`, because a chip
   *  cannot be reporting an outcome and waiting for one at the same time. */
  running?: boolean;
  /** Ambient motion for the holo drift. Off by default so a chip in a test or a
   *  screenshot is still; the shell turns it on. Stopped by `calm` — the drift
   *  is decoration, and the WORD is what reports the state. */
  animated?: boolean;
  title?: string;
  /** Makes the chip a real `<button>` — for the one place a status IS the
   *  control: the trainer's Recording/Paused chip, which toggles the state it
   *  reports. Everywhere else omit it and the chip stays a passive `<span>`;
   *  a chip in a table must not grow a click target because a handler was
   *  convenient. Pass `title` alongside so the action is discoverable — the
   *  visible word still names the STATE, not the action. */
  onClick?: () => void;
  children: React.ReactNode;
}

export function StatusChip({
  tone,
  running,
  animated,
  title,
  onClick,
  children,
}: StatusChipProps): React.ReactElement {
  const shared = {
    // `gl-status-chip-btn` only ever appears WITH `gl-status-chip`: it resets
    // the button UA styles (padding, background) without touching the width
    // contract, which stays declared once, on the base class.
    className: [
      "gl-status-chip",
      onClick ? "gl-status-chip-btn" : null,
      running ? "gl-status-chip-running" : null,
    ]
      .filter(Boolean)
      .join(" "),
    // Not `role="status"`. A live region announces on every change, and these
    // sit in tables of dozens — a filter that repaints the list would read the
    // whole column aloud. The row's own accessible name carries the state.
    style: running || !tone ? undefined : toneSurface(TONE[tone]),
    "data-gl": "status-chip" as const,
    "data-tone": running ? "running" : (tone ?? "neutral"),
    ...(animated && running ? { "data-gl-motion": "ambient" as const } : null),
    title,
  };
  if (onClick) {
    return (
      <button type="button" onClick={onClick} {...shared}>
        {children}
      </button>
    );
  }
  return <span {...shared}>{children}</span>;
}
