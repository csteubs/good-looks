// A one-shot handoff from an insights recommendation to the test detail view.
//
// The "Debug with AI" action must open the SAME dialog the Output panel's
// button opens — same context assembly, same Sending-strip review before
// anything is sent. That context is built from queries only the detail view
// runs, so the action can't open the dialog itself; instead it records the
// intent, navigates, and the detail view consumes it once its context exists.
//
// Module state rather than a store or router state on purpose: it is a single
// pending navigation's payload, never rendered, never persisted, and a second
// navigation simply replaces it. Consuming is one-shot so a later manual visit
// to the same test cannot replay an old click.

let pendingAiDebugTestId: string | null = null;

export function requestAiDebugFor(testId: string): void {
  pendingAiDebugTestId = testId;
}

/** True exactly once per request, and only for the test it was made for. */
export function consumeAiDebugRequest(testId: string): boolean {
  if (pendingAiDebugTestId !== testId) return false;
  pendingAiDebugTestId = null;
  return true;
}
