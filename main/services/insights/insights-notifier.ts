// Local desktop notification when an insights report is ready.
//
// Same shape and rules as run-notifier.ts and ai-debug-notifier.ts: LOCAL
// only, best-effort, gated on a setting (RecorderSettings.notifyOnInsightsReady,
// which is only reachable while the feature itself is on). It fires on
// success by design — the report generates unattended, so "it's ready" is the
// entire message; failures are NOT notified, they surface in the Insights
// view and the Alerts pane readout, because a macOS banner about a background
// job's retry loop is how the feature gets turned off.

import { Notification, logger } from "@shell/backend";

import type { InsightsCadence } from "../../recorder/types.js";

const CADENCE_TITLES: Record<InsightsCadence, string> = {
  daily: "Daily insights ready",
  weekly: "Weekly insights ready",
  monthly: "Monthly insights ready",
};

/** What the notification says. Pure, so the wording is regression-checkable
 *  without a notification centre. The body is the report's own headline —
 *  the one sentence the model led with is exactly the one worth a banner. */
export function buildInsightsNotice(notice: {
  cadence: InsightsCadence;
  headline: string;
}): { title: string; body: string } {
  return { title: CADENCE_TITLES[notice.cadence], body: notice.headline };
}

/** Post the notification, when the setting allows it. */
export function notifyInsightsReady(
  notice: { cadence: InsightsCadence; headline: string },
  enabled: boolean,
): void {
  if (!enabled) return;
  try {
    new Notification(buildInsightsNotice(notice)).show();
  } catch (err) {
    // A notification failure must never reach the report it announces.
    logger.warn("insights", "Failed to post notification", { err: String(err) });
  }
}
