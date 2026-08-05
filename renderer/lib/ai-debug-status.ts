// The one place an AI debug session's status becomes a colour and a label.
//
// The colour IS the feature — a minimized job is only useful if its icon tells
// you truthfully whether the model is still working or the answer is waiting —
// so the mapping lives here as pure data rather than inline className ternaries
// spread across the run panel, the trainer step rows and the global chip.
//
// Every state also carries a distinct `label`. Colour alone is not an
// accessible signal, and it is not assertable in jsdom (which has no computed
// styles worth trusting), so the label is what the tests actually pin.

import type { AiDebugStatus } from "./recorder-types";

export interface AiDebugTone {
  /** Tailwind text-colour class for the icon. */
  className: string;
  /** Tooltip + aria-label. Never rely on the colour by itself. */
  label: string;
  /** True while the model is working — drives the subtle pulse on the icon. */
  busy: boolean;
  /** True when there is a finished response waiting to be read. */
  ready: boolean;
}

/** Blue: ready to accept input. Orange: the model is thinking. Green: finished,
 *  suggestions ready for review. Red: the request failed.
 *
 *  `interrupted` is deliberately BLUE, not red: nothing is broken, the app just
 *  quit mid-stream, and the only action is to send it again — which is exactly
 *  what blue means everywhere else in this mapping. */
export function toneFor(status: AiDebugStatus): AiDebugTone {
  switch (status) {
    case "idle":
      return {
        className: "text-accent",
        label: "Debug with AI — ready",
        busy: false,
        ready: false,
      };
    case "streaming":
      return {
        className: "text-support-orange",
        label: "AI is thinking…",
        busy: true,
        ready: false,
      };
    case "done":
      return {
        className: "text-support-green",
        label: "AI finished — suggestions ready for review",
        busy: false,
        ready: true,
      };
    case "error":
      return {
        className: "text-support-red",
        label: "AI request failed",
        busy: false,
        ready: false,
      };
    case "cancelled":
      return {
        className: "text-accent",
        label: "AI request stopped — ready to send again",
        busy: false,
        ready: false,
      };
    case "interrupted":
      return {
        className: "text-accent",
        label: "Interrupted when the app quit — send again to retry",
        busy: false,
        ready: false,
      };
    default: {
      // Exhaustiveness guard: adding a status without giving it a colour is a
      // COMPILE error here, not a silent fall-through to some default tone.
      const never: never = status;
      throw new Error(`Unhandled AI debug status: ${String(never)}`);
    }
  }
}

/** A session in a terminal state holds no live request — nothing to cancel, and
 *  it no longer counts against the concurrent-stream cap. */
export function isTerminal(status: AiDebugStatus): boolean {
  return status !== "streaming" && status !== "idle";
}
