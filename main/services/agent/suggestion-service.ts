// The AI suggestion strip's engine — the trainer's ONE unattended LLM send.
//
// Every other AI affordance in the trainer fires from an explicit user
// action (the command box, Generate Steps, per-step debug); this one fires
// on a DEBOUNCE after a captured step, with nobody reviewing the individual
// payload. That difference is the whole design:
//
//   • OFF BY DEFAULT. `RecorderSettings.aiSuggestionsEnabled` is a security
//     default like `aiInsightsEnabled`, and the flag is re-checked at the
//     moment of every send, not at scheduling time — a setting flipped off
//     mid-debounce must win.
//   • BOUNDED CONTEXT ONLY. The payload is the describeStep tail and the
//     element inventory from page-summary.ts — never logs, scripts, headers,
//     raw HTML or a field's value. check:agent-egress pins it the way
//     check:insights-egress pins the report.
//   • OFFERS, NEVER ACTIONS. A suggestion is a chip; nothing runs until the
//     user takes one, and a taken step goes through the SAME verify gate as
//     everything else (recorderService.tryStep) — inserted only once it has
//     worked on the live page.
//
// Deps-injected like its siblings; real bindings at the bottom.

import { randomUUID } from "node:crypto";

import type { RawStep, Step } from "../../recorder/types.js";
import type { LlmMessage } from "../llm/types.js";
import type { TryStepOutcome } from "../recorder-service.js";
import type { PageSummary } from "./page-summary.js";
import {
  buildSuggestionMessages,
  normalizeSuggestionTurn,
  SUGGESTION_SCHEMA,
} from "./agent-prompts.js";

/** How long a capture burst settles before one send fires. Long enough that
 *  a click-click-click sequence costs one request, short enough that the
 *  offer still describes the page the user is looking at. */
export const SUGGESTION_DEBOUNCE_MS = 2_500;
export const SUGGESTION_TIMEOUT_MS = 30_000;

/** Step types a suggestion may carry. An ALLOWLIST, enforced here rather
 *  than trusted to the prompt: model output is untrusted text, and the rule
 *  that matters most — never a `fill` or `press`, whose value the model
 *  would have to invent — must hold whatever the model was told. */
const SUGGESTABLE_TYPES = new Set(["click", "check", "uncheck", "select", "wait", "scroll", "assert"]);

export interface Suggestion {
  id: string;
  label: string;
  raw: RawStep;
}

/** What the renderer sees: label and id only. The raw step stays in this
 *  process — accepting sends the id back, and the gate judges the step. */
export interface SuggestionsPayload {
  suggestions: { id: string; label: string }[];
}

export interface SuggestionDeps {
  completeJson: (
    params: {
      messages: LlmMessage[];
      role: "instant";
      temperature: number;
      schema: object;
      schemaName?: string;
    },
    opts: { timeoutMs: number },
  ) => Promise<{ value: unknown }>;
  refreshRedaction: () => Promise<void>;
  redact: (text: string) => string;
  /** THE security gate — read at send time, every time. */
  suggestionsEnabled: () => boolean;
  session: () => { steps: Step[]; liveUrl: string } | null;
  /** The agent drawer's run — while it drives, this service stays quiet. */
  agentRunning: () => boolean;
  pageSummary: () => Promise<PageSummary | null>;
  describeStep: (step: Step) => string;
  /** normalizeRawStep + describeStep; null refuses the suggestion. */
  normalizeStep: (raw: unknown) => { raw: RawStep; label: string } | null;
  tryStep: (input: unknown) => Promise<TryStepOutcome>;
  push: (payload: SuggestionsPayload) => void;
  debounceMs?: number;
}

export interface TrainerSuggestionService {
  /** A step was captured — (re)start the debounce. Checks the flag first so
   *  a disabled machine never even holds a timer. */
  noteCapture(): void;
  /** The session ended or the flag flipped — drop offers and timers. */
  clear(): void;
  accept(id: unknown): Promise<{ ok: boolean; detail?: string }>;
  dismiss(id: unknown): boolean;
  current(): SuggestionsPayload;
}

export function createTrainerSuggestionService(deps: SuggestionDeps): TrainerSuggestionService {
  const debounceMs = deps.debounceMs ?? SUGGESTION_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let suggestions: Suggestion[] = [];
  // Bumped by every capture and clear: a generation that comes back stale
  // (the page has moved on) is dropped rather than offered.
  let generation = 0;

  function payload(): SuggestionsPayload {
    return { suggestions: suggestions.map((s) => ({ id: s.id, label: s.label })) };
  }

  function set(next: Suggestion[]): void {
    suggestions = next;
    deps.push(payload());
  }

  async function generate(gen: number): Promise<void> {
    // Every gate re-checked at SEND time: the flag (flipped off
    // mid-debounce must win), the session (may have ended), and the agent
    // (already driving the same page — two proposers would race the gate).
    if (!deps.suggestionsEnabled()) return;
    if (deps.agentRunning()) return;
    const sess = deps.session();
    if (!sess) return;
    const summary = await deps.pageSummary();
    if (gen !== generation) return;
    const messages = buildSuggestionMessages({
      url: sess.liveUrl,
      title: summary?.title ?? "",
      stepsTail: sess.steps.map((s) => deps.describeStep(s)),
      summary,
    });
    await deps.refreshRedaction();
    const redacted = messages.map((m) => ({ ...m, content: deps.redact(m.content) }));
    let value: unknown;
    try {
      // The INSTANT slot: frequent, small, unattended — the role built for
      // helpers (and it follows the chat slot when unassigned).
      const completion = await deps.completeJson(
        { messages: redacted, role: "instant", temperature: 0.2, schema: SUGGESTION_SCHEMA, schemaName: "suggestions" },
        { timeoutMs: SUGGESTION_TIMEOUT_MS },
      );
      value = completion.value;
    } catch {
      // An unattended helper that cannot reach a model offers nothing — a
      // toast here would nag on every capture of an offline evening.
      return;
    }
    // Toggled off while the model was answering: discard — the insights
    // rule. The user withdrew consent; nothing bought with it is shown.
    if (!deps.suggestionsEnabled()) return;
    if (gen !== generation) return;
    const next: Suggestion[] = [];
    for (const raw of normalizeSuggestionTurn(value)) {
      const type = (raw as { type?: unknown }).type;
      if (typeof type !== "string" || !SUGGESTABLE_TYPES.has(type)) continue;
      const normalized = deps.normalizeStep(raw);
      if (!normalized) continue;
      next.push({ id: randomUUID(), ...normalized });
    }
    set(next);
  }

  return {
    noteCapture(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      generation++;
      if (!deps.suggestionsEnabled()) {
        if (suggestions.length > 0) set([]);
        return;
      }
      // A fresh capture makes the standing offers stale immediately — the
      // page the model described is not the page any more.
      if (suggestions.length > 0) set([]);
      const gen = generation;
      timer = setTimeout(() => {
        timer = null;
        void generate(gen);
      }, debounceMs);
    },

    clear(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      generation++;
      if (suggestions.length > 0) set([]);
    },

    async accept(id: unknown): Promise<{ ok: boolean; detail?: string }> {
      const suggestion = suggestions.find((s) => s.id === id);
      if (!suggestion) return { ok: false, detail: "That suggestion is no longer available." };
      // Accepting is ATTENDED — a user click — so it runs whatever the flag
      // says now; the flag gates the SEND, not the user's own choice. The
      // step goes through the same gate as every other arrival.
      const outcome = await deps.tryStep(suggestion.raw);
      generation++;
      set([]);
      if (outcome.status === "inserted") return { ok: true };
      if (outcome.status === "failed") {
        return { ok: false, detail: outcome.result.detail ?? "the step did not run" };
      }
      return { ok: false, detail: "the session is no longer live" };
    },

    dismiss(id: unknown): boolean {
      const before = suggestions.length;
      const next = suggestions.filter((s) => s.id !== id);
      if (next.length === before) return false;
      set(next);
      return true;
    },

    current(): SuggestionsPayload {
      return payload();
    },
  };
}

// ── The real bindings ────────────────────────────────────────────────
// Kept at the bottom the way the agent and insights services keep theirs:
// everything above is pure against the deps, and everything the app
// actually wires is visible in one block. check:agent-egress pins the
// redaction wiring and the flag gate by these exact shapes.

import { llmService } from "../llm-service.js";
import { recorderService, onCaptureRecorded } from "../recorder-service.js";
import { refreshSecretSnapshot, redactWithSnapshot } from "../secret-redaction.js";
import { describeStep } from "../script-generator.js";
import { normalizeRawStep } from "../../recorder/types.js";
import { sendToMain } from "../app-window.js";
import { recorderSettingsStore } from "../recorder-settings-store.js";
import { trainerAgentService, PAGE_VALUE_ASSERTS } from "./trainer-agent-service.js";

export const trainerSuggestionService: TrainerSuggestionService = createTrainerSuggestionService({
  completeJson: (params, opts) => llmService.completeJson(params, opts),
  refreshRedaction: () => refreshSecretSnapshot(),
  redact: (text) => redactWithSnapshot(text),
  suggestionsEnabled: () => recorderSettingsStore.get().aiSuggestionsEnabled,
  session: () => {
    const state = recorderService.getState();
    if (!state.recording) return null;
    return { steps: recorderService.getSteps(), liveUrl: state.liveUrl ?? state.url ?? "" };
  },
  agentRunning: () => trainerAgentService.snapshot().running,
  pageSummary: () => recorderService.agentPageSummary(),
  describeStep: (step) => describeStep(step),
  normalizeStep: (raw) => {
    const clean = normalizeRawStep(raw);
    if (!clean) return null;
    // Same refusal the agent's proposal path applies: a page-value assert
    // with no value generates nothing and asserts nothing.
    if (clean.assert && PAGE_VALUE_ASSERTS.has(clean.assert) && !(clean.value ?? "").trim()) return null;
    return { raw: clean, label: describeStep({ id: "", timestamp: 0, ...clean }) };
  },
  tryStep: (input) => recorderService.tryStep(input),
  push: (payload) => sendToMain("suggest:changed", payload),
});

// A capture is the trigger. Registered here rather than inside
// recorder-service so the capture funnel keeps zero knowledge of AI — the
// listener carries no payload, only "the step list moved".
onCaptureRecorded(() => trainerSuggestionService.noteCapture());
