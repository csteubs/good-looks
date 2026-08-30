// Which keystroke toggles recording/paused — ⌘R (Ctrl+R off macOS).
//
// WHY THIS IS DECIDED IN THE MAIN PROCESS AT ALL. The application menu carries
// `role: "viewMenu"`, whose Reload item owns CmdOrCtrl+R — and a menu
// accelerator is dispatched before the focused page ever sees the keydown, so
// a renderer listener for ⌘R is not "lower priority", it is UNREACHABLE. Worse,
// the accelerator it loses to RELOADS THE WINDOW, which during a recording
// session tears down the very view showing the session. The one documented
// lever that runs ahead of both is `before-input-event` on a webContents,
// whose `preventDefault()` stops the page event AND the menu shortcut — so the
// decision has to be made where that event is delivered: the main process.
// `attachRecorderShortcuts` in recorder-service.ts is the attachment; this
// module is the matcher, kept pure so the chord itself is testable without an
// Electron window.
//
// Two neighbours are deliberately NOT matched:
//   • ⌘⇧R (force reload) falls through — while ⌘R is repurposed during a
//     session, this stays as the escape hatch for a genuinely wedged window,
//     and matching "any modifier combination containing ⌘R" would take it too.
//   • The TRAINING PAGE's ⌘R is not this chord's business. There it means
//     "reload the site", is deliberately left to happen, and is RECORDED as a
//     reload step (see the `before-input-event` note in recorder-service.ts).
//     Nothing routes the training page's webContents through this matcher.

/** The slice of Electron's `Input` this decision reads. Structural rather than
 *  importing Electron types so the matcher — and its tests — stay pure. */
export interface RecordingShortcutInput {
  type: string;
  key?: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  isAutoRepeat?: boolean;
}

/**
 * True when this input is the recording/paused toggle chord: ⌘R or Ctrl+R,
 * with no other modifier, on the key going DOWN and not auto-repeating.
 *
 * `control || meta` rather than a platform switch, matching the reload-notice
 * matcher in recorder-service.ts — the app's other reading of this same key.
 * `isAutoRepeat` is refused because a held key would toggle the session
 * on/off/on at the keyboard's repeat rate, ending wherever the key-up lands.
 */
export function isRecordingToggleInput(input: RecordingShortcutInput): boolean {
  if (input.type !== "keyDown") return false;
  if (input.isAutoRepeat) return false;
  if (!(input.control || input.meta)) return false;
  if (input.alt || input.shift) return false;
  return String(input.key ?? "").toLowerCase() === "r";
}

/** The session flags the chord's meaning depends on, at the moment it lands. */
export interface RecordingToggleState {
  /** A recording session exists. */
  hasSession: boolean;
  /** The training browser has loaded its first page. */
  pageReady: boolean;
  /** A replay owns the window (`withCaptureSuspended`). */
  replaying: boolean;
  /** The Refine Selector picker is armed. */
  refineMode: boolean;
}

/**
 * What the matched chord DOES, given the session's state.
 *
 * - `"fallthrough"` — no session: the chord still belongs to View → Reload,
 *   so the handler must not `preventDefault()`.
 * - `"consume"` — a session exists but is not toggleable: `preventDefault()`
 *   and do nothing. THE KEY MUST NEVER MEAN "RELOAD THE WINDOW" WHILE A
 *   SESSION IS LIVE — a fall-through here hands the chord to the accelerator
 *   whose winning is the failure this whole feature exists to prevent, on
 *   exactly the states (loading, mid-replay) where a reload hurts most. Same
 *   rule as the sibling ⌘P hook: "does nothing right now" is a state of this
 *   shortcut, not a different shortcut.
 * - `"toggle"` — pause or resume.
 *
 * Not toggleable: before the page is ready (nothing meaningful to pause);
 * while a replay owns the window (`withCaptureSuspended` saves and restores
 * `session.paused`, so a toggle would be silently unwound when it exits); and
 * while the Refine picker is armed (`startRefine` pauses and `endRefine`
 * restores — refine owns the flag the same way a replay does, and a resume
 * mid-pick runs capture live behind the review dialog).
 */
export type RecordingToggleAction = "fallthrough" | "consume" | "toggle";

export function recordingToggleAction(state: RecordingToggleState): RecordingToggleAction {
  if (!state.hasSession) return "fallthrough";
  if (!state.pageReady || state.replaying || state.refineMode) return "consume";
  return "toggle";
}
