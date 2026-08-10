// "The training viewport just got narrower" — the notice for `trainerPanel:
// viewportNarrowed`.
//
// WHY THIS MATTERS. Docking the panel shrinks the training browser, and a
// responsive site lays out from the viewport it is given. So the page being
// recorded can be a different page — different DOM, different locators — from
// the one the generated spec will run against, which uses whatever viewport the
// spec sets. That divergence is silent in both directions: nothing throws while
// recording, and the run that finally fails blames the locator rather than the
// width. The backend has sent this push since the panel landed (2026-08-06) and
// nothing subscribed to it, so the warning DECISIONS describes as the mitigation
// was never actually shown.
//
// WHERE IT IS SUBSCRIBED, and why the panel is not enough on its own. The push
// comes from `noteViewportChange`, and on the ordinary path — a panel that opens
// already docked — that call runs BEFORE `panelWindow.loadURL`. The panel's page
// does not exist yet, so the message is delivered to a window with no listeners
// and dropped. A subscription living only in the panel would therefore never
// fire in the real app, while a component test that emits into a mounted panel
// passes happily: the failure would be invisible in exactly the place we would
// look for it. The main window has been loaded since the session started, so
// `RecordingView` is the receiver that can be relied on.
//
// The panel subscribes as well, for the path that does reach it: a session that
// opened undocked for want of room and is docked later by hand goes through
// `dock()`, which sends the same push with both windows alive. That is also the
// moment the user is most owed an answer, having just pressed the button that
// caused it. Both windows are live renderings of one session, so both showing
// the notice is the same mirroring the step list already does.
//
// One notice per session is the BACKEND's guarantee (`viewportHintSent`), not
// something re-derived here — one flag, at the point that knows whether the
// width actually changed.

import * as React from "react";

import { api } from "../lib/api";
import { toast } from "@ui";

/** Payload of `trainerPanel:viewportNarrowed`. */
export interface ViewportNarrowedPayload {
  /** The training browser's new width, in points. */
  width?: number;
}

/**
 * The notice as the user reads it.
 *
 * Exported as text, and asserted as text, for the reason `DOCK_TOOLTIP` is: a
 * toast raised through sonner is recorded by the test stub as a call, not as
 * rendered DOM, so the sentence is only checkable against the constant that
 * produced it. Keeping the builder here also means the two subscribing windows
 * cannot drift into wording the other doesn't have.
 */
export function viewportNarrowedNotice(width?: number): { title: string; description: string } {
  // The width arrives from our own backend, but `api.on` hands back whatever was
  // on the channel with no runtime check, and a title reading "narrowed to
  // NaNpt" would look like a bug in the feature rather than a bad payload.
  const px = typeof width === "number" && Number.isFinite(width) ? Math.round(width) : null;
  return {
    title: px === null ? "Training viewport narrowed" : `Training viewport narrowed to ${px}pt`,
    description:
      "Docking the trainer panel shrank the training browser, so a responsive site may lay " +
      "out differently here than on a real run. Undock the panel to give the width back.",
  };
}

/**
 * Show the notice when the backend says the training viewport narrowed.
 *
 * The toast does NOT auto-dismiss. It is raised at the moment the panel docks,
 * which is the moment focus moves to the training browser and the panel beside
 * it — a notice that expires after a few seconds would, on the main window's
 * ordinary path, count down entirely behind another window and be gone before
 * anyone looked. The condition it describes lasts for as long as the session
 * stays docked, so the notice lasts until it is dismissed.
 */
export function useViewportNarrowedNotice(): void {
  React.useEffect(() => {
    return api.on<ViewportNarrowedPayload | undefined>(
      "trainerPanel:viewportNarrowed",
      (payload) => {
        const { title, description } = viewportNarrowedNotice(payload?.width);
        toast.warning(title, { description, duration: Infinity, closeButton: true });
      },
    );
  }, []);
}
