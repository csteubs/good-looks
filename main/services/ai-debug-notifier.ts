// Local desktop notification when an AI debug job finishes.
//
// Same shape and rules as run-notifier.ts: LOCAL only, off by default
// (RecorderSettings.notifyOnAiDebugDone), best-effort. Unlike a run notice this
// fires on success too — the reason to be told is that the user minimized a
// slow job and walked away, and "the answer is ready" is the message they were
// waiting for.
//
// Triggered over IPC from the renderer rather than observed here: AI debug
// completion is a renderer-store state (the LLM stream terminates in the
// renderer's session map), so the backend has no independent way to see it.

import { Notification, logger } from "@shell/backend";

export interface AiDebugOutcomeNotice {
  testName: string;
  status: "done" | "error";
}

/** What the notification says. Pure, so the wording is regression-checkable
 *  without a notification centre. Never null: both outcomes are worth a line —
 *  a finished answer AND a dead job the user would otherwise keep waiting on. */
export function buildAiDebugNotice(notice: AiDebugOutcomeNotice): { title: string; body: string } {
  if (notice.status === "error") {
    return {
      title: `AI debug failed — ${notice.testName}`,
      body: "The request died before an answer arrived. Open the job to retry.",
    };
  }
  return {
    title: `AI debug finished — ${notice.testName}`,
    body: "The suggestions are ready for review.",
  };
}

/** Should a finished AI debug job post a desktop notification? A pure predicate
 *  for symmetry with shouldNotifyRun — the gate must be testable without
 *  posting anything. */
export function shouldNotifyAiDebug(opts: { enabled: boolean }): boolean {
  return opts.enabled;
}

/** Post the notification, when the setting allows it. */
export function notifyAiDebugOutcome(notice: AiDebugOutcomeNotice, enabled: boolean): void {
  if (!shouldNotifyAiDebug({ enabled })) return;
  try {
    new Notification(buildAiDebugNotice(notice)).show();
  } catch (err) {
    // A notification failure must never reach the job it is reporting on.
    logger.warn("ai-debug", "Failed to post notification", { err: String(err) });
  }
}
