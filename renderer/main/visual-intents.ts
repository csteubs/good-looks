// A frame chosen in one place and opened in another.
//
// The History tab's picture is a SHORTCUT INTO the Visual view, not a second
// copy of it: comparing, masking and accepting a baseline all live there, and
// the strip's job is to say which frame is worth opening. But "open the Visual
// view" is not enough on its own — that screen defaults to the newest captured
// run and, inside it, to the failure. A user who clicks the picture of THIS
// test's last frame and lands on another test's run has been sent somewhere
// else, which is the failure this module exists against.
//
// ── Why it is consumed on read ────────────────────────────────────────
// The dangerous failure is not a dropped request — it is a stale one. A value
// left in place would drag the user back to a frame they clicked ten minutes
// ago every time the Visual view mounts, and the view's own run selection would
// never stick. Reading clears, so a request is honoured exactly once.
//
// Module state rather than a context or a router search param, the same choice
// `insight-intents.ts` and `pending-branch-switch.ts` made: it is one pending
// navigation's payload, never rendered, never persisted, and a second click
// simply replaces it. The router also runs on memory history, so a search param
// would be a URL nothing can link to.

export interface VisualFrameRequest {
  testId: string;
  runId: string;
  /** The step whose frame should be in view on arrival. */
  stepId: string;
}

let pending: VisualFrameRequest | null = null;

export function requestVisualFrame(request: VisualFrameRequest): void {
  pending = request;
}

/** The pending request, if any, clearing it. See the header for why. */
export function consumeVisualFrame(): VisualFrameRequest | null {
  const value = pending;
  pending = null;
  return value;
}

/** Test hygiene: module state outlives a test, and a request left behind by one
 *  test moves the next one's Visual view to a run it never asked for. */
export function clearVisualFrame(): void {
  pending = null;
}
