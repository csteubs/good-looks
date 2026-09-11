// Hint — what a control says on hover and on keyboard focus.
//
// THE THEME'S ONE TOOLTIP, and the first Radix primitive in this layer. The
// redesign carried its hints as native `title` attributes — assertable as
// attributes, no library, "the rail's hint idiom" — and that premise broke on
// the platform the app ships on: since Electron 38.8.2 (still open at 43.3.0,
// electron/electron#49843) macOS shows a `title` tooltip on the first hover
// and very rarely afterwards. A hint only a `title` carries is a hint that is
// not shown, and a `cursor: help` over one is a promise the app breaks.
//
// Radix rather than a hand-rolled box, unlike `Menu`. A tooltip has to leave
// its trigger's scroll container (the rail rows sit in a scrollport that would
// clip anything positioned inside it) and flip away from a viewport edge (the
// range switch sits at the top-right of the pane) — a portal and collision
// handling, the two things worth a library. `Menu` drew its own because its
// ITEMS had to be real DOM for tests; a tooltip's text is real DOM with Radix
// too. The surface is restyled here (`.gl-hint`: hairline, square, the panel
// near-black) so it wears the theme and not `@ui`'s radius.
//
// Focus opens it as well as hover, so a keyboard user gets the same words —
// and so a test can: jsdom cannot open a Radix tooltip by pointer (the
// trigger's pointer tracking needs APIs jsdom lacks) but `fireEvent.focus` on a
// focusable trigger does. A trigger that cannot take focus (a Panel's id, a
// span inside a button) is hover-only; there the words must be reachable some
// other way — an id is already on screen, truncated; a row's delta box has a
// focusable twin in the detail.
//
// Self-providing, like `@ui`'s Tooltip: Radix throws without a Provider above
// the Root, and the trainer window and the browser preview mount roots of
// their own.

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

export type HintSide = "top" | "right" | "bottom" | "left";

export interface HintProps {
  /** The explanation. Absent or empty → the child renders as itself with no
   *  tooltip machinery around it, so a call site can pass an optional hint
   *  straight through. */
  text?: string;
  side?: HintSide;
  /** The trigger, rendered AS ITSELF (`asChild`): it keeps its element, class,
   *  role, handlers and ref, and gains the tooltip's handlers and a
   *  `data-state`. It must put its `ref` on a DOM node — Radix anchors the
   *  tooltip to it, and a component that drops the ref gets no tooltip. */
  children: React.ReactElement;
}

export function Hint({ text, side = "bottom", children }: HintProps): React.ReactElement {
  if (text === undefined || text === "") return children;
  return (
    <TooltipPrimitive.Provider delayDuration={450}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="gl-hint"
            data-gl="hint"
            side={side}
            sideOffset={6}
            collisionPadding={8}
          >
            {text}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
