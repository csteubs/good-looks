// Local desktop notification when a run finishes with something worth looking
// at — a failure, or a visual change.
//
// Deliberately LOCAL only: a macOS notification via the SDK's Notification API.
// The roadmap defers external alerting (Slack/email) because it means storing
// credentials and shipping run data off the machine; nothing here leaves it.
//
// Off by default (RecorderSettings.notifyOnRunIssues) and best-effort — a
// notification failure must never affect the run it is reporting on.

import { Notification, logger } from "@glaze/core/backend";

export interface RunOutcomeNotice {
  testName: string;
  status: "passed" | "failed";
  /** how many steps exceeded the visual threshold (0 when not a capture run) */
  changedSteps: number;
  /** label of the failing step, when known */
  failedLabel?: string;
}

/** Decide whether a finished run is worth interrupting the user for, and what
 *  to say. Returns null for a clean run — the point is to surface problems, not
 *  to narrate every success. Pure, so the decision is regression-checkable
 *  without a notification centre. */
export function buildRunNotice(
  notice: RunOutcomeNotice,
): { title: string; body: string } | null {
  const failed = notice.status === "failed";
  const changed = notice.changedSteps > 0;
  if (!failed && !changed) return null;

  const title = failed ? `${notice.testName} failed` : `${notice.testName}: visual change`;
  const parts: string[] = [];
  if (failed) {
    parts.push(notice.failedLabel ? `Failed at: ${notice.failedLabel}` : "The run failed.");
  }
  if (changed) {
    parts.push(
      `${notice.changedSteps} step${notice.changedSteps === 1 ? "" : "s"} changed visually.`,
    );
  }
  return { title, body: parts.join(" ") };
}

/** Post the notification for a finished run, when there's something to say. */
export function notifyRunOutcome(notice: RunOutcomeNotice): void {
  const built = buildRunNotice(notice);
  if (!built) return;
  try {
    new Notification({ title: built.title, body: built.body }).show();
  } catch (err) {
    // Notifications can fail for permission or platform reasons; that's not a
    // reason to disturb the run that just completed.
    logger.warn("runner", "Failed to post run notification", { err: String(err) });
  }
}
