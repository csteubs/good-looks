// Outgoing webhook alerts for runs and batches that need attention.
//
// This is the ONLY thing in the app that sends data off the machine, so the
// constraints are deliberate and worth stating:
//
//   • OFF by default, and inert until the user configures a URL themselves.
//   • SUMMARY ONLY. Run logs are never sent — they routinely contain page
//     content, URLs with tokens, and typed fixture values (passwords, card
//     numbers) captured during recording. What goes out is: test name, status,
//     failing step LABEL, counts, duration. `buildAlertPayload` is pure so
//     `check:alerts` can assert that nothing else ever leaks in.
//   • Best-effort. A webhook that is slow, down, or wrong must never affect the
//     run it reports on — every failure is logged and swallowed.
//   • Generic JSON with a top-level `text`, which is what Slack and Discord
//     incoming webhooks render, while remaining readable to any other endpoint.

import { logger } from "@shell/backend";

import { webhookUrlStore } from "./webhook-url-store.js";
import { appFetch } from "./proxy-service.js";
import { insightsSlackUrlStore } from "./insights/insights-slack-url-store.js";
import { recorderSettingsStore } from "./recorder-settings-store.js";
import { allRedactableValues, redact } from "./secret-redaction.js";
import { buildDeepLink } from "../../shared/deep-link.mjs";
import type { BatchSummary, InsightReport, InsightsCadence } from "../recorder/types.js";

/** A webhook that hangs must not hold a batch open. */
const ALERT_TIMEOUT_MS = 10_000;

export interface RunAlert {
  kind: "run";
  /** Both ids are REQUIRED rather than optional, so the link cannot be dropped
   *  by a caller that forgot. A notification nobody can act on is the thing
   *  this pair exists to prevent. */
  testId: string;
  runId: string;
  testName: string;
  status: "passed" | "failed";
  /** steps exceeding the visual threshold (0 when not a capture run) */
  changedSteps: number;
  /** label of the failing step, when known */
  failedLabel?: string;
  durationMs?: number;
  browser?: string;
}

export interface BatchAlert {
  kind: "batch";
  summary: BatchSummary;
  /** names of the tests that failed, for a scannable message */
  failedTests: string[];
  stopped: boolean;
  /** Why it stopped — see BatchState. Absent = the user pressed Stop. */
  stoppedBy?: "user" | "failure";
  /** The test whose failure stopped it, for `stoppedBy: "failure"`. */
  stoppedByTest?: string;
  browser?: string;
}

/**
 * A `notify` step in a Routine reached its point in the run.
 *
 * THE MESSAGE IS THE ONLY VARIABLE PART, and it is text the user typed into the
 * editor — never interpolated from run data. That is what keeps this alert
 * inside the same guarantee as the other two: what leaves the machine is a
 * summary and a sentence somebody wrote, not anything the run produced. See
 * `RoutineNotifyStep`, and `check:alerts` for the assertion.
 */
export interface RoutineNotifyAlert {
  kind: "routineNotify";
  /** What the user wrote. Trimmed and capped by the store. */
  message: string;
  /** The Routine it came from, for context in the channel. */
  routineName: string;
}

/**
 * A finished insights report, announced to the channel the user configured
 * for it.
 *
 * The input is the report's HEADLINE and its deterministic STATS — never the
 * sections. That is a structural guarantee in the builder's signature, same
 * shape as the run/batch alerts taking no log parameter: the report body is
 * pages of model prose, and a chat channel gets the one-line read plus counts,
 * with the full text living in the app, the PDF, or the filed issue. The
 * headline is model output, so `redactPayload` scrubs it before the send like
 * every other text field.
 */
export interface InsightReportAlert {
  kind: "insightReport";
  cadence: InsightsCadence;
  headline: string;
  runs: number;
  failed: number;
  previousRuns: number;
  healedSteps: number;
  visualChanges: number | null;
  newClusters: number | null;
}

export type Alert = RunAlert | BatchAlert | RoutineNotifyAlert | InsightReportAlert;

export interface AlertPayload {
  /** rendered by Slack/Discord; also the human-readable line for anything else */
  text: string;
  event: "run" | "batch" | "insights";
  status: "failed" | "changed" | "passed";
  /** machine-readable detail — deliberately a fixed, log-free shape */
  detail: Record<string, unknown>;
  source: "Good Looks!";
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * Strip secret values from a built payload.
 *
 * The payload already carries no run log, but it DOES carry a step label, and a
 * step recorded before variables existed has its typed value baked into that
 * label — a password among them. Kept separate from `buildAlertPayload` so that
 * function stays pure and the check can still assert its shape directly.
 */
export function redactPayload(payload: AlertPayload, secrets: readonly string[]): AlertPayload {
  if (secrets.length === 0) return payload;
  const detail: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload.detail)) {
    detail[k] = typeof v === "string" ? redact(v, secrets) : v;
  }
  return { ...payload, text: redact(payload.text, secrets), detail };
}

/**
 * Decide whether an event is worth alerting on, and build exactly what gets
 * sent. Returns null when there's nothing wrong — the point is to surface
 * problems, not narrate every success.
 *
 * Pure, and the single place the outgoing shape is defined, so the redaction
 * guarantee above is enforceable by a regression check.
 */
export function buildAlertPayload(alert: Alert): AlertPayload | null {
  if (alert.kind === "insightReport") {
    // Always sends, like routineNotify: the report existing IS the event the
    // user subscribed the channel to, so a clean period is not suppressed.
    const cadenceWord =
      alert.cadence === "daily" ? "Daily" : alert.cadence === "weekly" ? "Weekly" : "Monthly";
    const parts = [`${alert.runs} run${alert.runs === 1 ? "" : "s"}, ${alert.failed} failed`];
    if (alert.healedSteps > 0) parts.push(`${alert.healedSteps} healed`);
    if (alert.visualChanges !== null && alert.visualChanges > 0) {
      parts.push(`${alert.visualChanges} visual change${alert.visualChanges === 1 ? "" : "s"}`);
    }
    if (alert.newClusters !== null && alert.newClusters > 0) {
      parts.push(`${alert.newClusters} new failure signature${alert.newClusters === 1 ? "" : "s"}`);
    }
    return {
      text: `📈 ${cadenceWord} testing report — ${alert.headline}\n${parts.join(" · ")} · full report in Good Looks! → Insights`,
      event: "insights",
      status: alert.failed > 0 ? "failed" : "passed",
      detail: {
        cadence: alert.cadence,
        headline: alert.headline,
        runs: alert.runs,
        failed: alert.failed,
        previousRuns: alert.previousRuns,
        healedSteps: alert.healedSteps,
        ...(alert.visualChanges !== null ? { visualChanges: alert.visualChanges } : {}),
        ...(alert.newClusters !== null ? { newClusters: alert.newClusters } : {}),
      },
      source: "Good Looks!",
    };
  }
  if (alert.kind === "routineNotify") {
    // The ONLY alert that always sends — the other two are conditional on a
    // failure, because they report on something. This one IS the thing the
    // user asked to be told, so suppressing it on a clean run would be
    // suppressing the message they wrote.
    //
    // `detail` carries no run data at all. That is not an oversight: the whole
    // reason a notify's message is static text is that this payload must not
    // become a route from a run to a third-party endpoint.
    return {
      text: `🔔 ${alert.routineName}: ${alert.message}`,
      event: "batch",
      status: "passed",
      detail: { routineName: alert.routineName, message: alert.message },
      source: "Good Looks!",
    };
  }
  if (alert.kind === "run") {
    const failed = alert.status === "failed";
    const changed = alert.changedSteps > 0;
    if (!failed && !changed) return null;

    const headline = failed
      ? `❌ ${alert.testName} failed`
      : `👁 ${alert.testName}: visual change`;
    const parts: string[] = [];
    if (failed && alert.failedLabel) parts.push(`Failed at: ${alert.failedLabel}`);
    if (changed) {
      parts.push(`${alert.changedSteps} step${alert.changedSteps === 1 ? "" : "s"} changed visually`);
    }
    if (alert.durationMs !== undefined) parts.push(fmtDuration(alert.durationMs));
    if (alert.browser) parts.push(alert.browser);

    // THE ONE FIELD THAT TURNS A NOTICE INTO A JUMP. Without it a 02:00 failure
    // read at 09:00 means opening the app, finding the test in the library
    // rail, opening the run panel and scrolling the history table for the run
    // that fired this message. Built with the same `buildDeepLink` the
    // issue-tracker payload uses, so there is no second spelling of the URL.
    //
    // The step is deliberately NOT in the link even when `failedLabel` is
    // known: the link takes ids, and a label is a human string, not a stepId.
    // A link that selects the run is correct; one that guesses at a step would
    // open the wrong row.
    const link = buildDeepLink({ testId: alert.testId, runId: alert.runId });

    return {
      text: parts.length > 0 ? `${headline} — ${parts.join(" · ")} · ${link}` : `${headline} — ${link}`,
      event: "run",
      status: failed ? "failed" : "changed",
      detail: {
        testName: alert.testName,
        status: alert.status,
        changedSteps: alert.changedSteps,
        ...(alert.failedLabel ? { failedStep: alert.failedLabel } : {}),
        ...(alert.durationMs !== undefined ? { durationMs: alert.durationMs } : {}),
        ...(alert.browser ? { browser: alert.browser } : {}),
        runId: alert.runId,
        link,
      },
      source: "Good Looks!",
    };
  }

  // Batches alert on failure or on being stopped partway — a clean suite stays
  // quiet, same rule as single runs.
  const { summary } = alert;
  if (summary.failed === 0 && !alert.stopped) return null;

  // A stop by policy is not the same event as a person pressing Stop, and this
  // line is what a chat channel sees. Naming the test is the whole value: the
  // suite did not merely end early, a specific step said it should.
  const headline = alert.stopped
    ? alert.stoppedBy === "failure"
      ? `⏹ Routine stopped${alert.stoppedByTest ? ` — "${alert.stoppedByTest}" failed` : " by a failure"} — ${summary.passed}/${summary.total} passed`
      : `⏹ Batch stopped — ${summary.passed}/${summary.total} passed`
    : `❌ Batch: ${summary.failed} of ${summary.total} failed`;
  const parts: string[] = [];
  if (alert.failedTests.length > 0) {
    // Cap the list: a suite where everything failed shouldn't produce a wall
    // of text in a chat channel.
    const shown = alert.failedTests.slice(0, 5);
    const rest = alert.failedTests.length - shown.length;
    parts.push(`Failed: ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`);
  }
  parts.push(fmtDuration(summary.durationMs));
  if (alert.browser) parts.push(alert.browser);

  return {
    text: `${headline} — ${parts.join(" · ")}`,
    event: "batch",
    status: "failed",
    detail: {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      stopped: alert.stopped,
      ...(alert.stoppedBy ? { stoppedBy: alert.stoppedBy } : {}),
      failedTests: alert.failedTests,
      durationMs: summary.durationMs,
      ...(alert.browser ? { browser: alert.browser } : {}),
    },
    source: "Good Looks!",
  };
}

/** POST a prepared payload. Exported for the "Send test alert" button, which
 *  needs to surface the failure rather than swallow it. */
export async function postWebhook(url: string, payload: AlertPayload): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
  try {
    const res = await appFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Webhook returned ${res.status} ${res.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget alert for a finished run or batch. Never throws and never
 * rejects — callers sit on the run-completion path.
 */
/**
 * Announce a finished insights report to its configured Slack channel.
 *
 * Its own gate (`insightsSlackEnabled`) and its own URL store, never the
 * alert webhook's: the incident channel and the report channel are different
 * subscriptions. Takes the REPORT and maps it onto the alert input here, in
 * one visible place — the mapping reads the headline and the stats and
 * nothing else, which is what keeps the payload chat-sized and inside the
 * summary-only guarantee `check:alerts` holds. Fire-and-forget like
 * `sendAlert`: this sits on the generation path, and announcing a report must
 * never fail the report.
 */
export async function sendInsightReportAlert(report: InsightReport): Promise<void> {
  try {
    if (!recorderSettingsStore.get().insightsSlackEnabled) return;
    const url = await insightsSlackUrlStore.getUrl();
    if (!url) return;
    const built = buildAlertPayload({
      kind: "insightReport",
      cadence: report.cadence,
      headline: report.headline,
      runs: report.stats.runs,
      failed: report.stats.failed,
      previousRuns: report.stats.previousRuns,
      healedSteps: report.stats.healedSteps,
      visualChanges: report.stats.visualChanges,
      newClusters: report.stats.newClusters,
    });
    if (!built) return;
    // Same late redaction as sendAlert, for the same reason — and the same
    // `allRedactableValues()` rather than the snapshot, since this call site
    // is async too.
    const payload = redactPayload(built, await allRedactableValues());
    await postWebhook(url, payload);
    logger.info("alerts", "Sent insights report to Slack", { status: payload.status });
  } catch (err) {
    logger.warn("alerts", "Failed to send insights report to Slack", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function sendAlert(alert: Alert): Promise<void> {
  try {
    if (!recorderSettingsStore.get().alertWebhookEnabled) return;
    const built = buildAlertPayload(alert);
    if (!built) return;
    const url = await webhookUrlStore.getUrl();
    if (!url) return;
    // This is the only path that sends anything off the machine automatically,
    // so redaction happens here, immediately before the send, rather than
    // anywhere a later refactor could route around.
    //
    // `allRedactableValues()`, not `testSecretsStore.allValues()`. This call
    // site is async and so does NOT go through the snapshot every other
    // redactor reads, which means widening the snapshot silently leaves this
    // one behind — as it did when Shopify signatures were added to it.
    const payload = redactPayload(built, await allRedactableValues());
    await postWebhook(url, payload);
    logger.info("alerts", "Sent webhook alert", { event: payload.event, status: payload.status });
  } catch (err) {
    // Includes network errors, timeouts, and non-2xx responses. Reporting a
    // problem must never itself become one.
    logger.warn("alerts", "Failed to send webhook alert", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
