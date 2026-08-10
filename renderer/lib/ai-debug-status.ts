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
import type { ToneName } from "../theme/tokens";

export interface AiDebugTone {
  /**
   * Class for the icon's colour. A `gl-*` class rather than an inline style
   * because every call site already threads `className` through, and because a
   * class we declare is one `check:renderer-classes` can prove resolves — an
   * SDK class name is not (CLAUDE.md).
   *
   * The names are SEMANTIC, not colours: `.gl-ai-busy`, never `.gl-ai-amber`.
   * Retuning which hue "thinking" takes should not turn a class name into a
   * lie, and this is the one mapping in the app where a name that lies about
   * its meaning is the whole bug.
   */
  className: string;
  /**
   * The palette tone this status resolves to, for tests to assert against
   * `TONE` directly.
   *
   * THE POINT OF THIS FIELD IS THAT THE CONTRACT BECOMES CHECKABLE. Before B9
   * the colour was a Tailwind string, and jsdom has no computed styles worth
   * trusting — so the only thing a test could pin was the LABEL, which is a
   * different claim. A wrong colour with a right label passed everything.
   */
  tone: ToneName;
  /** Tooltip + aria-label. Never rely on the colour by itself. */
  label: string;
  /** True while the model is working — drives the subtle pulse on the icon. */
  busy: boolean;
  /** True when there is a finished response waiting to be read. */
  ready: boolean;
}

/**
 * Cyan: ready to accept input. Amber: the model is thinking. Phosphor:
 * finished, suggestions ready for review. Red: the request failed.
 *
 * THESE FOUR MAP ONTO THE PRE-REDESIGN CONTRACT EXACTLY (REDESIGN §B9):
 * blue→cyan, orange→amber, green→phos, red→red. That is not a restyle with a
 * palette applied to it — it is the same four meanings in the new vocabulary,
 * and the mapping was specified in the plan precisely because getting it wrong
 * is silent. The panel works perfectly while the icon lies: the user walks away
 * from a finished answer, or waits on a dead one.
 *
 * Cyan for "ready" also happens to be what the palette already declares it for
 * — "running / live / focus" — and amber for "thinking" is caution rather than
 * an outcome. Neither is a coincidence, but neither is the reason: the reason
 * is that the four states had four distinct colours and they still do.
 *
 * `interrupted` is deliberately CYAN, not red: nothing is broken, the app just
 * quit mid-stream, and the only action is to send it again — which is exactly
 * what cyan means everywhere else in this mapping.
 */
export function toneFor(status: AiDebugStatus): AiDebugTone {
  switch (status) {
    case "idle":
      return {
        className: "gl-ai-ready",
        tone: "cyan",
        label: "Debug with AI — ready",
        busy: false,
        ready: false,
      };
    case "streaming":
      return {
        className: "gl-ai-busy",
        tone: "amber",
        label: "AI is thinking…",
        busy: true,
        ready: false,
      };
    case "done":
      return {
        className: "gl-ai-done",
        tone: "phos",
        label: "AI finished — suggestions ready for review",
        busy: false,
        ready: true,
      };
    case "error":
      return {
        className: "gl-ai-failed",
        tone: "red",
        label: "AI request failed",
        busy: false,
        ready: false,
      };
    case "cancelled":
      return {
        className: "gl-ai-ready",
        tone: "cyan",
        label: "AI request stopped — ready to send again",
        busy: false,
        ready: false,
      };
    case "interrupted":
      return {
        className: "gl-ai-ready",
        tone: "cyan",
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
