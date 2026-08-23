// The insights scheduler: while the app is open, a due report writes itself.
//
// Same mechanics as routine-scheduler.ts — a 60s unref'd interval whose tick
// swallows its own errors, because a scheduler that throws inside its interval
// stops ticking silently and the symptom is "my report stopped happening"
// noticed weeks later — but the OPPOSITE catch-up posture, on purpose. The
// routine scheduler bounds its timer to the session and OFFERS missed
// occurrences (routine-scheduler.ts:19-26), because a routine seizes the
// machine. A report is a background HTTP call, so a period missed while the
// app was closed is simply still DUE at the first tick and generates quietly.
// The due-rule that makes that safe is calendar-anchored — see
// insight-schedule.ts.
//
// Ordering rules, each load-bearing:
// - Nothing is persisted at attempt START. `lastAttemptAt` is stamped when a
//   FAILED attempt settles (every attempt settles — complete() has a hard
//   timeout), which is what reconciles quit-safety (a killed generation
//   leaves no trace and the period stays due) with the retry backoff (a
//   failing provider is retried hourly, not per-tick).
// - The tick defers, unstamped, while an INTERACTIVE llm request is in
//   flight: local runtimes serve one request at a time, and a scheduled job
//   must never starve a user who is sitting there waiting.
// - The enabled setting is re-checked when the completion settles. Toggling
//   the feature off mid-generation discards the result and stamps nothing —
//   the user said stop, and re-enabling should regenerate.
//
// Deps-injected so tests drive firing decisions with no clock, no LLM and no
// disk; `insightsService` at the bottom is the real wiring. Side-effect-free
// at import — the timer starts only when main/index.ts calls start(), inside
// whenReady, AFTER metricsStore.init(): a tick before the DB opens would not
// crash (every query tolerates a null handle), it would generate a report
// that confidently says "no failure clusters" because the cache was closed.

import { randomUUID } from "crypto";

import { app, logger } from "@shell/backend";

import type {
  InsightReport,
  InsightsState,
  InsightsStatus,
  InsightStats,
  RecorderSettings,
} from "../../recorder/types.js";
import type { LlmChatParams } from "../llm/types.js";
import { llmService, LlmCompletionError, type LlmCompletion } from "../llm-service.js";
import { insightReportStore } from "../insight-report-store.js";
import { recorderSettingsStore } from "../recorder-settings-store.js";
import { runHistoryStore } from "../run-history-store.js";
import { testStore } from "../test-store.js";
import { metricsStore } from "../metrics-store.js";
import { healJournalStore } from "../heal-journal-store.js";
import { scriptChangeStore } from "../script-change-store.js";
import { routineStore } from "../routine-store.js";
import { shopifySignatureStore } from "../shopify-signature-store.js";
import { redactWithSnapshot, refreshSecretSnapshot } from "../secret-redaction.js";
import { sendInsightReportAlert } from "../alert-service.js";
import { sendToMain } from "../app-window.js";
import { contentWindow, isDue } from "./insight-schedule.js";
import { buildInsightFacts, type InsightFacts } from "./facts-builder.js";
import {
  buildInsightMessages,
  describeInsightsSending,
  INSIGHTS_TIMEOUT_MS,
} from "./insight-prompts.js";
import { parseInsightResponse } from "./parse-insight-response.js";
import { notifyInsightsReady } from "./insights-notifier.js";

const TICK_MS = 60_000;

type InsightsSettings = Pick<
  RecorderSettings,
  "aiInsightsEnabled" | "aiInsightsCadence" | "notifyOnInsightsReady"
>;

export interface InsightsDeps {
  now(): number;
  newId(): string;
  settings(): InsightsSettings;
  state(): InsightsState;
  saveState(patch: Partial<InsightsState>): void;
  buildFacts(
    cadence: InsightsSettings["aiInsightsCadence"],
    window: { since: number; until: number },
  ): Promise<{ facts: InsightFacts; stats: InsightStats; testIndex: Set<string> }>;
  /** Refresh the secret snapshot, then `redact` scrubs with it. */
  refreshRedaction(): Promise<void>;
  redact(text: string): string;
  complete(params: LlmChatParams, opts: { timeoutMs: number }): Promise<LlmCompletion>;
  interactiveCount(): number;
  saveReport(report: InsightReport): InsightReport | null;
  push(): void;
  notify(notice: { cadence: InsightsSettings["aiInsightsCadence"]; headline: string }, enabled: boolean): void;
  /** Announce the saved report to its configured Slack channel. Fire-and-
   *  forget with its own gate and URL inside — see sendInsightReportAlert. */
  slack(report: InsightReport): void;
  appVersion(): string;
}

export type GenerateNowResult =
  | { started: true }
  | { started: false; reason: "disabled" | "alreadyRunning" };

export function createInsightsService(deps: InsightsDeps) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let generating = false;

  /** One generation attempt. The caller has already decided it should happen —
   *  this owns only the overlap guard and the settle-time bookkeeping. */
  async function generate(): Promise<GenerateNowResult> {
    if (generating) return { started: false, reason: "alreadyRunning" };
    const settings = deps.settings();
    if (!settings.aiInsightsEnabled) return { started: false, reason: "disabled" };
    generating = true;
    // Announce the state change: the view renders "writing the report" off
    // `insights:status`, and without this push it only learns at the end.
    deps.push();
    try {
      const cadence = settings.aiInsightsCadence;
      const window = contentWindow(cadence, deps.now());
      const { facts, stats, testIndex } = await deps.buildFacts(cadence, window);
      // The disclosure is derived from the same facts the prompt serializes,
      // and stored with the report — it describes THIS send, not the one
      // today's builder would make.
      const sending = describeInsightsSending(facts);
      await deps.refreshRedaction();
      const messages = buildInsightMessages(facts).map((m) => ({
        ...m,
        content: deps.redact(m.content),
      }));
      const completion = await deps.complete(
        // The chat slot, said so: three roles can name three providers, and
        // the report goes where the user's conversations go.
        { messages, temperature: 0.2, role: "chat" },
        { timeoutMs: INSIGHTS_TIMEOUT_MS },
      );
      if (!deps.settings().aiInsightsEnabled) {
        // Toggled off while the model was answering: discard, stamp nothing.
        return { started: true };
      }
      const parsed = parseInsightResponse(completion.text, testIndex);
      const generatedAt = deps.now();
      const report: InsightReport = {
        id: deps.newId(),
        cadence,
        periodStart: window.since,
        periodEnd: window.until,
        generatedAt,
        provider: completion.provider,
        model: completion.model,
        headline: parsed.headline,
        sections: parsed.sections,
        actions: parsed.actions,
        stats,
        sending,
        ...(parsed.degraded ? { degraded: true as const } : {}),
        promptChars: completion.promptChars,
        answerChars: completion.answerChars,
        durationMs: completion.durationMs,
        firstTokenMs: completion.firstTokenMs,
        read: false,
      };
      const saved = deps.saveReport(report);
      deps.saveState({
        lastGeneratedAt: generatedAt,
        lastError: null,
        lastSeenAppVersion: deps.appVersion(),
      });
      deps.push();
      if (saved) {
        deps.notify(
          { cadence, headline: saved.headline },
          deps.settings().notifyOnInsightsReady,
        );
        // The Slack announcement carries its own enabled gate and URL check —
        // called unconditionally here so the gate lives in exactly one place.
        deps.slack(saved);
      }
      logger.info("insights", "Generated insights report", {
        cadence,
        degraded: parsed.degraded,
        provider: completion.provider,
        model: completion.model,
        durationMs: completion.durationMs,
      });
      return { started: true };
    } catch (err) {
      if (deps.settings().aiInsightsEnabled) {
        const at = deps.now();
        const kind = err instanceof LlmCompletionError ? err.kind : "provider";
        const message = err instanceof Error ? err.message : String(err);
        // Settle-time stamp: this is the backoff clock, and it exists only for
        // attempts that actually settled as failures.
        deps.saveState({ lastAttemptAt: at, lastError: { at, kind, message } });
        logger.warn("insights", "Report generation failed", { kind, message });
      }
      deps.push();
      return { started: true };
    } finally {
      generating = false;
    }
  }

  async function tickAsync(): Promise<void> {
    try {
      if (generating) return;
      const settings = deps.settings();
      if (!settings.aiInsightsEnabled) return;
      const state = deps.state();
      const due = isDue({
        enabled: true,
        cadence: settings.aiInsightsCadence,
        lastGeneratedAt: state.lastGeneratedAt,
        lastAttemptAt: state.lastAttemptAt,
        now: deps.now(),
      });
      if (!due) return;
      // Deferred, NOT stamped: a deferral is not an attempt, and stamping it
      // would push a due report an hour away because the user asked the AI
      // about something else.
      if (deps.interactiveCount() > 0) return;
      await generate();
    } catch (err) {
      logger.warn("insights", "Insights tick failed", { err: String(err) });
    }
  }

  return {
    /** Idempotent. No immediate tick: the first evaluation is ~60s after
     *  start, which keeps the LLM call out of the launch window where
     *  retention and reconciliation are already working. */
    start(): void {
      if (timer) return;
      timer = setInterval(() => void tickAsync(), TICK_MS);
      timer.unref?.();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** The user pressed the button: skip the due-rule and the backoff (they
     *  asked), and skip the interactive-busy deferral (they know what they're
     *  doing) — but never the overlap guard, and never the enabled gate. */
    async generateNow(): Promise<GenerateNowResult> {
      return generate();
    },

    status(): InsightsStatus {
      return { ...deps.state(), generating };
    },

    /** For tests: one tick, awaited. */
    async tick(): Promise<void> {
      return tickAsync();
    },
  };
}

export type InsightsService = ReturnType<typeof createInsightsService>;

/** The real wiring. Reads settings and state fresh on every use — the store
 *  re-reads its file per call, same cost profile as the routine scheduler
 *  re-listing routines each tick — so a settings change needs no subscription
 *  here. */
export const insightsService: InsightsService = createInsightsService({
  now: () => Date.now(),
  newId: () => randomUUID(),
  settings: () => {
    const s = recorderSettingsStore.get();
    return {
      aiInsightsEnabled: s.aiInsightsEnabled,
      aiInsightsCadence: s.aiInsightsCadence,
      notifyOnInsightsReady: s.notifyOnInsightsReady,
    };
  },
  state: () => insightReportStore.state(),
  saveState: (patch) => void insightReportStore.saveState(patch),
  buildFacts: (cadence, window) =>
    buildInsightFacts(cadence, window, {
      runs: () => runHistoryStore.list(),
      prunedDays: () => runHistoryStore.totals().prunedDays,
      tests: () => testStore.list(),
      metricsDb: () => metricsStore.handle(),
      pendingHeals: () => healJournalStore.listAll().filter((e) => e.status === "pending").length,
      unreviewedScriptChanges: () => scriptChangeStore.listAll().filter((e) => !e.reviewed).length,
      routines: () => routineStore.list(),
      shopifyStatuses: () => shopifySignatureStore.list(),
      appVersion: () => app.getVersion(),
      lastSeenAppVersion: () => insightReportStore.state().lastSeenAppVersion,
    }),
  refreshRedaction: () => refreshSecretSnapshot(),
  redact: (text) => redactWithSnapshot(text),
  complete: (params, opts) => llmService.complete(params, opts),
  interactiveCount: () => llmService.activeCount(),
  saveReport: (report) => insightReportStore.save(report),
  push: () => sendToMain("insights:changed", null),
  notify: (notice, enabled) => notifyInsightsReady(notice, enabled),
  slack: (report) => void sendInsightReportAlert(report),
  appVersion: () => app.getVersion(),
});
