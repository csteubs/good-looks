// ⌘P — play the currently selected step.
//
// Handled in the RENDERER, unlike its sibling ⌘R (the recording/paused toggle,
// which lives in the main process — see recording-shortcut.ts there). The
// asymmetry is forced from both ends: ⌘R collides with the View menu's Reload
// accelerator, which beats any renderer keydown listener, so only the main
// process can claim it; ⌘P collides with nothing in the menus, and the thing
// it acts on — WHICH step is selected — is per-window renderer state
// (`selection.anchorId` in each trainer view) that the main process never
// sees. Each trainer window resolves the chord against its own selection,
// which is also what a user looking at that window expects.

import * as React from "react";

/** The slice of a keydown this decision reads — structural so the matcher can
 *  be tested in the node project, where there is no KeyboardEvent. */
export interface PlayStepChord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}

/** True when this keydown is ⌘P / Ctrl+P with no other modifier. Auto-repeat
 *  is refused: a held key must not queue a replay per repeat tick. */
export function isPlayStepChord(e: PlayStepChord): boolean {
  if (e.repeat) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.altKey || e.shiftKey) return false;
  return e.key.toLowerCase() === "p";
}

/**
 * Bind ⌘P for the lifetime of the calling view.
 *
 * Two situations hand the key back untouched, before any of this shortcut's
 * own logic runs:
 *
 * - A FIELD has focus. "Never steal a keystroke from a field" is the
 *   app-strip's rule and it holds here too — Ctrl+P is a caret movement
 *   inside macOS text fields, and consuming it while someone types in a
 *   composer would eat a real edit for nothing.
 * - A DIALOG is open. Radix portals into `document.body`, so a keydown born
 *   inside GenerateStepsDialog or the exit confirmation still bubbles to this
 *   window listener — and a replay started behind a modal yanks OS focus to
 *   the training window (`withCaptureSuspended` focuses the page) out from
 *   under the dialog the user is typing in.
 *
 * Past those, `onPlay` is null when there is nothing to play — no selected
 * step, controls disabled (loading, replaying, running), or an armed picker
 * (assert/refine, where a replayed click would be swallowed by the armed
 * mode's own capture branch and record a step the user never made). The chord
 * is still CONSUMED in that state: preventDefault() runs so the key cannot
 * fall through to whatever a future menu item might bind, and "does nothing
 * right now" stays a state of this shortcut rather than a different shortcut.
 *
 * The handler rides in a ref so the listener is attached once per mount, not
 * re-subscribed on every render — `onPlay` closes over the live selection and
 * changes identity constantly.
 */
export function usePlayStepShortcut(onPlay: (() => void) | null): void {
  const ref = React.useRef(onPlay);
  ref.current = onPlay;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPlayStepChord(e)) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      ref.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
