// "Couldn't open the training browser" — the consumer for `recorder:loadFailed`.
//
// WHY THIS IS NOT IN `RecordingView`, where it lived until 2026-08-09. It was
// there, gated on `state.loadFailed`, and it could never once have opened.
// Two independent reasons, either of which alone is fatal:
//
//   1. `RecorderState.loadFailed` is always false. The service sets
//      `session.loadFailed = true`, then tears the session down — `session =
//      null` — and only THEN calls `broadcastState()`. `currentState()` reads
//      `session?.loadFailed ?? false`, so the state that actually goes over the
//      wire says the load did not fail.
//   2. Even if it said otherwise, nothing would render it. `root-view.tsx`
//      mounts `RecordingView` only while `state.recording`, which is
//      `!!session` — also false by then. The component hosting the dialog is
//      unmounted at the exact moment the dialog is meant to appear.
//
// So the failure had exactly one carrier, the `recorder:loadFailed` push, and
// nothing in the renderer subscribed to it. The training window would fail to
// open, the whole session would tear itself down, and the user would be left
// looking at the library with no dialog, no toast and no error — the service's
// own comment on that path calls the dialog "the primary feedback".
//
// Hence this: a listener on the push itself, mounted where the teardown cannot
// reach it. It deliberately holds its own copy of the message rather than
// reading session state, because by the time it hears anything there is no
// session left to read.

import * as React from "react";
import { Dialog, Text } from "@ui";

import { api } from "../lib/api";

/** Payload of `recorder:loadFailed`. */
export interface LoadFailedPayload {
  testId?: string | null;
  /** The service's own sentence, naming the URL it could not open. */
  message?: string;
}

/**
 * The copy, exported so tests can assert the sentence rather than the element.
 *
 * `fallback` matters more than it looks: the message is the only part that
 * names the URL, and a push that arrives without one must still explain itself.
 * An empty body under a title would read as the app losing the error.
 */
export const LOAD_FAILED_COPY = {
  title: "Couldn't open the training browser",
  description:
    "The training window didn't open. This can happen on a slow network, a redirect loop, or if the site is unreachable.",
  fallback: "The training window didn't open in time.",
  logged: "The failure has been logged to Stats → Run history.",
  dismiss: "OK",
  checkStats: "Check Stats",
} as const;

/**
 * Shows the load-failure dialog when the backend reports one.
 *
 * `onCheckStats` is injected rather than routed here, for the reason
 * `onFinished` is: this is a MAIN-WINDOW behaviour, and the trainer panel runs
 * the same provider tree with no router at all.
 */
export function LoadFailedDialog({ onCheckStats }: { onCheckStats: () => void }) {
  const [failure, setFailure] = React.useState<LoadFailedPayload | null>(null);

  React.useEffect(() => {
    return api.on<LoadFailedPayload | undefined>("recorder:loadFailed", (payload) => {
      // Normalised to an object so a payload-less push still opens the dialog.
      // The event is the fact; the fields are decoration.
      setFailure({ testId: payload?.testId ?? null, message: payload?.message });
    });
  }, []);

  if (!failure) return null;

  return (
    <Dialog
      open
      // Dismissible, unlike the version this replaces. There is nothing left to
      // acknowledge: the service has already closed the window, cleared the
      // session and logged the run before this push is sent, so trapping the
      // user behind a modal buys nothing and strands them if the buttons ever
      // fail. Esc and the close button both clear it.
      onOpenChange={(open) => {
        if (!open) setFailure(null);
      }}
      title={LOAD_FAILED_COPY.title}
      description={LOAD_FAILED_COPY.description}
      confirmLabel={LOAD_FAILED_COPY.dismiss}
      confirmVariant="accent"
      // No "Try again". The old dialog offered one and wired it to `stop()`,
      // which by this point stops a session that no longer exists; there is
      // also nothing held here to restart it from. Starting again is the
      // sidebar's job, and saying so beats a button that looks like a retry.
      onConfirm={() => setFailure(null)}
      secondaryAction={{
        // `secondaryAction`, not `destructiveAction` — the old one used the
        // destructive slot and drew "Check Stats" as a red button, which reads
        // as "delete something" on a dialog that is already about a failure.
        label: LOAD_FAILED_COPY.checkStats,
        onClick: () => {
          setFailure(null);
          onCheckStats();
        },
      }}
    >
      <Text variant="small" color="secondary">
        {failure.message || LOAD_FAILED_COPY.fallback} {LOAD_FAILED_COPY.logged}
      </Text>
    </Dialog>
  );
}
