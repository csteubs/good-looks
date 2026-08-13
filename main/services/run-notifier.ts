// Local desktop notification when a run finishes with something worth looking
// at — a failure, or a visual change.
//
// Deliberately LOCAL only: a macOS notification via the SDK's Notification API.
// The roadmap defers external alerting (Slack/email) because it means storing
// credentials and shipping run data off the machine; nothing here leaves it.
//
// Off by default (RecorderSettings.notifyOnRunIssues) and best-effort — a
// notification failure must never affect the run it is reporting on.

import { Notification, logger } from "@shell/backend";

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

/**
 * Should a finished RUN post its own desktop notification?
 *
 * A pure predicate rather than an inline condition in the runner, because the
 * runner's post-run block can't be driven without spawning Playwright, and this
 * rule got the batch case wrong for a long time: a batch with eight failures
 * fired eight notifications and none for the batch. A run inside a batch is
 * silent — the batch posts one notice for the whole suite (see batch-runner).
 */
export function shouldNotifyRun(opts: { batchId?: string; enabled: boolean }): boolean {
  if (opts.batchId) return false;
  return opts.enabled;
}

/** Post the notification for a finished run, when there's something to say. */
export function notifyRunOutcome(notice: RunOutcomeNotice): void {
  const built = buildRunNotice(notice);
  if (!built) return;
  post(built, "run");
}

export interface BatchOutcomeNotice {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  stopped: boolean;
  /** Why it stopped. Absent = the user pressed Stop, which is what `stopped`
   *  meant on its own. */
  stoppedBy?: "user" | "failure";
  /** The test whose failure stopped it, for `stoppedBy: "failure"`. */
  stoppedByTest?: string;
}

/**
 * What to say when a batch finishes.
 *
 * Unlike `buildRunNotice` this NEVER returns null — a clean suite is exactly
 * the case worth reporting. The reason to notify on a batch is that the user
 * started a long job and walked away, so "all 12 passed" is the message they
 * were waiting for; staying silent on success would mean the only way to learn
 * a batch finished cleanly is to go back and look, which is the thing the
 * notification exists to avoid.
 */
export function buildBatchNotice(notice: BatchOutcomeNotice): { title: string; body: string } {
  const ran = notice.passed + notice.failed;
  if (notice.stopped) {
    // WHO stopped it, not just that it stopped. This notification is often the
    // only thing seen of a scheduled routine, and "Batch stopped" for a run
    // nobody touched reads as somebody having intervened.
    const tail = `${notice.passed} passed, ${notice.failed} failed, ${notice.skipped} not run.`;
    if (notice.stoppedBy === "failure") {
      return {
        title: "Routine stopped by a failure",
        body: notice.stoppedByTest ? `"${notice.stoppedByTest}" failed. ${tail}` : tail,
      };
    }
    return { title: "Batch stopped", body: tail };
  }
  if (notice.failed > 0) {
    return {
      title: `Batch finished — ${notice.failed} failed`,
      body: `${notice.failed} of ${ran} run${ran === 1 ? "" : "s"} failed.${
        notice.skipped > 0 ? ` ${notice.skipped} skipped.` : ""
      }`,
    };
  }
  return {
    title: "Batch passed",
    body: `All ${notice.passed} run${notice.passed === 1 ? "" : "s"} passed.${
      notice.skipped > 0 ? ` ${notice.skipped} skipped.` : ""
    }`,
  };
}

/**
 * A Routine's `notify` step, on the desktop.
 *
 * NO GATE ON `notifyOnBatchDone`. The batch notification is a courtesy the user
 * can switch off; this one is a step they put in a job on purpose, and a step
 * that silently does nothing because of an unrelated preference is worse than
 * no step at all. The message is the user's own text — see `RoutineNotifyStep`
 * for why it is never interpolated.
 */
export function notifyRoutineMessage(routineName: string, message: string): void {
  post({ title: routineName, body: message }, "routine");
}

/** Post the notification for a finished batch. */
export function notifyBatchOutcome(notice: BatchOutcomeNotice): void {
  post(buildBatchNotice(notice), "batch");
}

function post(built: { title: string; body: string }, scope: string): void {
  try {
    new Notification({ title: built.title, body: built.body }).show();
  } catch (err) {
    // Notifications can fail for permission or platform reasons; that's not a
    // reason to disturb the run that just completed.
    logger.warn(scope, "Failed to post notification", { err: String(err) });
  }
}
