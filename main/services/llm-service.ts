// Client for the app's LLM providers.
//
// Local runtimes (Ollama & LM Studio) share the OpenAI-compatible
// POST /v1/chat/completions endpoint and target loopback (127.0.0.1) so macOS
// never shows a "local network" permission prompt. Claude (Anthropic) uses the
// hosted Messages API over HTTPS with a stored API key. Detection, model
// listing, and chat all branch per provider.

import { randomUUID } from "crypto";

import { logger } from "@glaze/core/backend";

import { anthropicKeyStore } from "./anthropic-key-store.js";
import { sendToMain } from "./app-window.js";
import { llmConfigStore } from "./llm-config-store.js";
import type {
  LlmChatParams,
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

function providerLabel(provider: LlmProvider): string {
  if (provider === "ollama") return "Ollama";
  if (provider === "lmstudio") return "LM Studio";
  return "Claude";
}

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
  return (data.data ?? [])
    .map((m) => (m.id ?? "").trim())
    .filter(Boolean)
    .map((id) => ({ id, label: id }));
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
    sendToMain("llm:error", { requestId, message: "No model selected." });
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
          message: "Add your Anthropic API key in Settings.",
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
      const text = await res.text().catch(() => "");
      const detail = res.status === 401 && provider === "anthropic" ? "Invalid API key." : text;
      throw new Error(`Chat request failed (HTTP ${res.status}). ${detail}`.trim());
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
              throw new Error(msg || "Anthropic streaming error.");
            }
          } else {
            const choice = (
              json as {
                choices?: Array<{
                  delta?: { content?: string; reasoning_content?: string; reasoning?: string };
                }>;
              }
            ).choices?.[0]?.delta;
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
      const message = sawReasoning
        ? "The model spent its whole response thinking and never produced an answer. " +
          "Reasoning models need room for both — raise the model's token limit in your " +
          "local server, or pick a non-reasoning model for this."
        : "The model returned an empty response. It may have hit a token limit, or the " +
          "prompt may have been too long for its context window.";
      sendToMain("llm:error", { requestId, message });
      return;
    }
    sendToMain("llm:done", { requestId });
  } catch (err) {
    if (controller.signal.aborted) {
      sendToMain("llm:done", { requestId, cancelled: true });
    } else {
      const raw = err instanceof Error ? err.message : String(err);
      // Wrap low-level connection failures with a friendly message, so the
      // renderer doesn't show a bare "fetch failed". Local providers get a
      // "make sure it is running" hint; cloud providers get a network hint.
      const isConnError = /abort|timeout|econnrefused|fetch failed|network/i.test(raw);
      const message = isConnError
        ? provider === "anthropic"
          ? `Could not reach Claude (${base}). Check your internet connection and try again.`
          : `Could not reach ${providerLabel(provider)} at ${base}. Make sure it is running.`
        : raw;
      logger.warn("llm", "Chat request failed", { requestId, message });
      sendToMain("llm:error", { requestId, message });
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
};

export type { LlmMessage };
