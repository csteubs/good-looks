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

import { logger } from "@glaze/core/backend";

import { webhookUrlStore } from "./webhook-url-store.js";
import { recorderSettingsStore } from "./recorder-settings-store.js";
import type { BatchSummary } from "../recorder/types.js";

/** A webhook that hangs must not hold a batch open. */
const ALERT_TIMEOUT_MS = 10_000;

export interface RunAlert {
  kind: "run";
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
  browser?: string;
}

export type Alert = RunAlert | BatchAlert;

export interface AlertPayload {
  /** rendered by Slack/Discord; also the human-readable line for anything else */
  text: string;
  event: "run" | "batch";
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
 * Decide whether an event is worth alerting on, and build exactly what gets
 * sent. Returns null when there's nothing wrong — the point is to surface
 * problems, not narrate every success.
 *
 * Pure, and the single place the outgoing shape is defined, so the redaction
 * guarantee above is enforceable by a regression check.
 */
export function buildAlertPayload(alert: Alert): AlertPayload | null {
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

    return {
      text: parts.length > 0 ? `${headline} — ${parts.join(" · ")}` : headline,
      event: "run",
      status: failed ? "failed" : "changed",
      detail: {
        testName: alert.testName,
        status: alert.status,
        changedSteps: alert.changedSteps,
        ...(alert.failedLabel ? { failedStep: alert.failedLabel } : {}),
        ...(alert.durationMs !== undefined ? { durationMs: alert.durationMs } : {}),
        ...(alert.browser ? { browser: alert.browser } : {}),
      },
      source: "Good Looks!",
    };
  }

  // Batches alert on failure or on being stopped partway — a clean suite stays
  // quiet, same rule as single runs.
  const { summary } = alert;
  if (summary.failed === 0 && !alert.stopped) return null;

  const headline = alert.stopped
    ? `⏹ Batch stopped — ${summary.passed}/${summary.total} passed`
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
    const res = await fetch(url, {
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
export async function sendAlert(alert: Alert): Promise<void> {
  try {
    if (!recorderSettingsStore.get().alertWebhookEnabled) return;
    const payload = buildAlertPayload(alert);
    if (!payload) return;
    const url = await webhookUrlStore.getUrl();
    if (!url) return;
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
