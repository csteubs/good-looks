// Client for the app's LLM providers.
//
// Local runtimes (Ollama & LM Studio) share the OpenAI-compatible
// POST /v1/chat/completions endpoint and target loopback (127.0.0.1) so macOS
// never shows a "local network" permission prompt. Claude (Anthropic) uses the
// hosted Messages API over HTTPS with a stored API key. Detection, model
// listing, and chat all branch per provider.

import { randomUUID } from "crypto";

import { logger } from "@shell/backend";

import { anthropicKeyStore } from "./anthropic-key-store.js";
import { sendToMain } from "./app-window.js";
import { llmConfigStore } from "./llm-config-store.js";
import {
  ProviderError,
  describeEmptyResponse,
  describeHttpFailure,
  providerLabel,
} from "./llm/provider-errors.js";
import type {
  LlmChatParams,
  LlmErrorKind,
  LlmMessage,
  LlmModel,
  LlmProvider,
  LlmProviderStatus,
} from "./llm/types.js";

const DEFAULT_BASE_URLS: Record<LlmProvider, string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
  anthropic: "https://api.anthropic.com",
};

const STATUS_TIMEOUT_MS = 4000;
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 4096;

function anthropicHeaders(key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

/**
 * Split app messages into Anthropic's shape: system prompts become a single
 * top-level `system` string, the rest map to alternating user/assistant turns.
 */
function toAnthropicPayload(messages: LlmMessage[]): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  return { system, messages: rest };
}

function baseUrlFor(provider: LlmProvider): string {
  const override = llmConfigStore.get().baseUrls?.[provider];
  return (override && override.trim()) || DEFAULT_BASE_URLS[provider];
}

async function fetchModels(provider: LlmProvider, base: string): Promise<LlmModel[]> {
  if (provider === "anthropic") {
    const key = await anthropicKeyStore.getKey();
    // Throw rather than return []. hasKey() only checks that the key FILE
    // exists, while getKey() decrypts and returns null on failure — so the two
    // disagree whenever the file is present but undecryptable (corrupted, or
    // safeStorage unavailable after a keychain/machine change). Returning an
    // empty list there made status() report reachable:true with no models and
    // no error: a green "connected" dot for a provider that cannot
    // authenticate, followed by every chat failing with a confusing message.
    if (!key) throw new Error("Add an Anthropic API key to connect to Claude.");
    const res = await fetch(`${base}/v1/models`, {
      headers: anthropicHeaders(key),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error("Invalid API key.");
    if (!res.ok) throw new Error(`Anthropic returned HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: Array<{ id?: string; display_name?: string }>;
    };
    // Anthropic returns models newest-first. Bias a balanced Sonnet to the top
    // so the auto-selected default (models[0]) is a sensible general-purpose
    // model for test work; a stable sort keeps newest-first within each family.
    const familyRank = (id: string): number =>
      /sonnet/i.test(id) ? 0 : /opus/i.test(id) ? 1 : /haiku/i.test(id) ? 2 : 3;
    return (data.data ?? [])
      .map((m) => ({ id: (m.id ?? "").trim(), label: (m.display_name ?? m.id ?? "").trim() }))
      .filter((m) => m.id)
      .sort((a, b) => familyRank(a.id) - familyRank(b.id));
  }
  if (provider === "ollama") {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    return (data.models ?? [])
      .map((m) => (m.name ?? m.model ?? "").trim())
      .filter(Boolean)
      .map((name) => ({ id: name, label: name }));
  }
  // LM Studio (OpenAI-compatible)
  const res = await fetch(`${base}/v1/models`, {
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`LM Studio returned HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (data.data ?? []).map((m) => (m.id ?? "").trim()).filter(Boolean);
  const loaded = await fetchLmStudioLoadState(base);
  return ids.map((id) => (loaded.has(id) ? { id, label: id, loaded: loaded.get(id) } : { id, label: id }));
}

/**
 * Which LM Studio models are currently held in memory, keyed by model id.
 *
 * The OpenAI-compatible /v1/models list can't answer this — it reports every
 * downloaded model identically, so the picker had no way to say which one
 * answers immediately and which one costs a multi-second load first. LM
 * Studio's own REST API (/api/v0, 0.3.6+) carries a per-model `state`.
 *
 * Deliberately a SEPARATE, failure-tolerant call rather than a replacement for
 * /v1/models: /v1 is the endpoint chat actually posts to, so it stays the
 * source of truth for which models exist and for whether the provider is
 * reachable. An older LM Studio (404), or some other OpenAI-compatible server
 * sitting on the port, then costs a missing badge — never an empty model list
 * or a false "not connected".
 */
async function fetchLmStudioLoadState(base: string): Promise<Map<string, boolean>> {
  const states = new Map<string, boolean>();
  try {
    const res = await fetch(`${base}/api/v0/models`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return states;
    const data = (await res.json()) as { data?: Array<{ id?: unknown; state?: unknown }> };
    if (!Array.isArray(data?.data)) return states;
    for (const m of data.data) {
      const id = typeof m?.id === "string" ? m.id.trim() : "";
      // Only a state we recognize counts. An unknown string means a newer
      // LM Studio grew a third state, and guessing "not loaded" for it would
      // be a confident lie; leaving it unset shows no badge instead.
      if (!id || (m?.state !== "loaded" && m?.state !== "not-loaded")) continue;
      states.set(id, m.state === "loaded");
    }
  } catch {
    // Unreachable, timed out, or not JSON — unknown load state, no badge.
  }
  return states;
}

// In-flight chat requests keyed by requestId, so llm:cancel can abort them.
const activeRequests = new Map<string, AbortController>();

async function runChat(
  requestId: string,
  provider: LlmProvider,
  model: string,
  params: LlmChatParams,
): Promise<void> {
  if (!model) {
    sendToMain("llm:error", { requestId, message: "No model selected.", kind: "no-model" });
    return;
  }
  const base = baseUrlFor(provider);
  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  try {
    let res: Response;
    if (provider === "anthropic") {
      const key = await anthropicKeyStore.getKey();
      if (!key) {
        sendToMain("llm:error", {
          requestId,
          message: "Add your Anthropic API key.",
          kind: "auth" satisfies LlmErrorKind,
        });
        return;
      }
      const { system, messages } = toAnthropicPayload(params.messages);
      res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(key),
        body: JSON.stringify({
          model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          ...(system ? { system } : {}),
          messages,
          temperature: params.temperature ?? 0.2,
          stream: true,
        }),
        signal: controller.signal,
      });
    } else {
      res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: params.messages,
          temperature: params.temperature ?? 0.2,
          stream: true,
        }),
        signal: controller.signal,
      });
    }
    if (!res.ok || !res.body) {
      // The provider's own body is JSON meant for a client, not a person —
      // decode it into one actionable sentence rather than pasting it through.
      const text = await res.text().catch(() => "");
      const failure = describeHttpFailure({ status: res.status, body: text, provider, model });
      throw new ProviderError(failure.message, failure.kind);
    }

    // Both providers stream Server-Sent Events as `data: {json}` lines; only the
    // JSON shape differs (OpenAI: choices[].delta.content ending in [DONE];
    // Anthropic: content_block_delta / error events), so we share the line
    // reader and branch on extraction.
    const decoder = new TextDecoder();
    let buffer = "";
    // Whether the stream produced anything at all, so an empty one can be
    // reported rather than ending as a silent, indistinguishable success.
    let sawContent = false;
    let sawReasoning = false;
    // Evidence for diagnosing a stream that ends with no answer. Without it the
    // only honest thing we could say was "something returned nothing", which is
    // where the misleading "prompt may have been too long" guess came from.
    let eventCount = 0;
    let finishReason: string | null = null;
    const deltaFields = new Set<string>();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as Record<string, unknown>;
          if (provider === "anthropic") {
            const type = json.type as string | undefined;
            if (type === "content_block_delta") {
              const delta = (json.delta as { text?: string } | undefined)?.text;
              if (delta) sendToMain("llm:chunk", { requestId, delta });
            } else if (type === "error") {
              const msg = (json.error as { message?: string } | undefined)?.message;
              throw new ProviderError(msg || "Anthropic streaming error.", "provider");
            }
          } else {
            eventCount++;
            const first = (
              json as {
                choices?: Array<{
                  finish_reason?: string | null;
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                    reasoning?: string;
                    [key: string]: unknown;
                  };
                }>;
              }
            ).choices?.[0];
            if (first?.finish_reason) finishReason = first.finish_reason;
            const choice = first?.delta;
            // Record every field that actually carried something. A model
            // streaming its answer under a name we don't read looks exactly
            // like a model that said nothing — this is what tells them apart.
            if (choice) {
              for (const [k, v] of Object.entries(choice)) {
                if (typeof v === "string" ? v.length > 0 : v != null) deltaFields.add(k);
              }
            }
            const delta = choice?.content;
            if (delta) {
              sawContent = true;
              sendToMain("llm:chunk", { requestId, delta });
            }
            // A REASONING model streams its thinking in a separate field and
            // puts only the final answer in `content`. Reading content alone
            // meant every thinking token was silently discarded — and since a
            // model can spend its whole budget reasoning, the stream could end
            // having emitted nothing at all. The UI then showed "thinking",
            // received `done`, and collapsed with no output and no error.
            //
            // Two spellings in the wild: `reasoning_content` (DeepSeek's, which
            // LM Studio and vLLM follow) and `reasoning` (OpenRouter and
            // others). Both are handled because the cost of guessing wrong is
            // this exact silent failure.
            const thinking = choice?.reasoning_content ?? choice?.reasoning;
            if (thinking) {
              sawReasoning = true;
              // Flagged, not merged: thinking is not the answer, and appending
              // it to the answer would present a model's scratchpad as its
              // conclusion.
              sendToMain("llm:chunk", { requestId, delta: thinking, reasoning: true });
            }
          }
        } catch (parseErr) {
          // Re-throw genuine Anthropic error events; ignore keep-alive lines /
          // partial JSON split across chunks (which fail as SyntaxError).
          if (parseErr instanceof Error && !(parseErr instanceof SyntaxError)) {
            throw parseErr;
          }
        }
      }
    }
    if (!sawContent) {
      // The stream finished without a single token of ANSWER. Ending on a plain
      // `done` here is what made this look like the feature was broken: the
      // panel collapsed with nothing in it and nothing to explain why.
      //
      // The reasoning case is worth naming separately, because the fix is
      // different: the model was working, it just never stopped thinking.
      const message = describeEmptyResponse({
        provider,
        model,
        promptChars: params.messages.reduce((n, m) => n + m.content.length, 0),
        eventCount,
        finishReason,
        deltaFields: [...deltaFields],
        sawReasoning,
      });
      logger.warn("llm", "Chat stream produced no answer", {
        requestId,
        model,
        eventCount,
        finishReason,
        deltaFields: [...deltaFields],
        sawReasoning,
      });
      sendToMain("llm:error", { requestId, message, kind: "empty-response" satisfies LlmErrorKind });
      return;
    }
    sendToMain("llm:done", { requestId });
  } catch (err) {
    if (controller.signal.aborted) {
      sendToMain("llm:done", { requestId, cancelled: true });
    } else {
      const raw = err instanceof Error ? err.message : String(err);
      // A ProviderError has already been decoded into an actionable sentence;
      // anything else is a low-level transport failure that would otherwise
      // reach the renderer as a bare "fetch failed", so it gets the "is it
      // running?" hint (local) or a network hint (cloud).
      //
      // The instanceof check matters rather than matching on text, because a
      // decoded message quotes the provider verbatim: a body mentioning e.g. a
      // "network error while fetching weights" would match the patterns below
      // and replace a correct, actionable message with "Make sure LM Studio is
      // running" — sending the user after a server that is up and answering.
      const decoded = err instanceof ProviderError ? err : null;
      const isConnError =
        !decoded && /abort|timeout|econnrefused|fetch failed|network/i.test(raw);
      const message = isConnError
        ? provider === "anthropic"
          ? `Could not reach Claude (${base}). Check your internet connection and try again.`
          : `Could not reach ${providerLabel(provider)} at ${base}. Make sure it is running.`
        : raw;
      // A decoded provider failure keeps its own kind; anything else is either
      // a recognized transport failure or genuinely unclassified.
      const kind: LlmErrorKind = decoded ? decoded.kind : isConnError ? "connection" : "provider";
      logger.warn("llm", "Chat request failed", { requestId, message, kind });
      sendToMain("llm:error", { requestId, message, kind });
    }
  } finally {
    activeRequests.delete(requestId);
  }
}

export const llmService = {
  defaultBaseUrl(provider: LlmProvider): string {
    return DEFAULT_BASE_URLS[provider];
  },

  /** Probe a provider: reachable + available models. Never throws. */
  async status(provider: LlmProvider): Promise<LlmProviderStatus> {
    const base = baseUrlFor(provider);
    if (provider === "anthropic") {
      const hasKey = await anthropicKeyStore.hasKey();
      if (!hasKey) {
        return {
          provider,
          reachable: false,
          models: [],
          baseUrl: base,
          hasKey: false,
          error: "Add an Anthropic API key to connect to Claude.",
        };
      }
      try {
        const models = await fetchModels(provider, base);
        return { provider, reachable: true, models, baseUrl: base, hasKey: true };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const unreachable = /abort|timeout|econnrefused|fetch failed|network/i.test(raw);
        const error = unreachable
          ? `Could not reach Claude (${base}). Check your internet connection and try again.`
          : raw;
        return { provider, reachable: false, models: [], baseUrl: base, hasKey: true, error };
      }
    }
    try {
      const models = await fetchModels(provider, base);
      return { provider, reachable: true, models, baseUrl: base };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const unreachable = /abort|timeout|ECONNREFUSED|fetch failed|network/i.test(raw);
      const error = unreachable
        ? `Could not reach ${providerLabel(provider)} at ${base}. Make sure it is running.`
        : raw;
      return { provider, reachable: false, models: [], baseUrl: base, error };
    }
  },

  /** Probe local providers at once (Claude is probed on demand via status). */
  async detect(): Promise<LlmProviderStatus[]> {
    return Promise.all([this.status("ollama"), this.status("lmstudio")]);
  },

  async listModels(provider: LlmProvider): Promise<LlmModel[]> {
    return fetchModels(provider, baseUrlFor(provider));
  },

  /**
   * Start a streaming chat completion. Returns immediately with a requestId;
   * deltas arrive via the `llm:chunk` push event, ending in `llm:done` or
   * `llm:error`. Consumed by later-phase UI (debug run output, step generation).
   */
  chat(params: LlmChatParams): string {
    const requestId = randomUUID();
    const config = llmConfigStore.get();
    const provider = params.provider ?? config.provider;
    const model = params.model ?? config.model ?? "";
    void runChat(requestId, provider, model, params);
    return requestId;
  },

  cancel(requestId: string): void {
    activeRequests.get(requestId)?.abort();
  },

  /** Whether a request is still in flight.
   *
   *  A renderer reload (dev HMR, window reload) drops the llm:chunk listeners
   *  while the backend request keeps going. The AI debug store re-adopts such a
   *  request on hydrate, and needs to distinguish "still answering" from
   *  "finished while nobody was listening" — otherwise the second case shows a
   *  permanently-thinking icon for a request that ended. */
  isActive(requestId: string): boolean {
    return activeRequests.has(requestId);
  },
};

export type { LlmMessage };
