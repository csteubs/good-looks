// Provider-agnostic client for local LLM runtimes (Ollama & LM Studio).
//
// Detection + model listing differ per provider; chat is unified behind the
// OpenAI-compatible POST /v1/chat/completions endpoint that both expose.
// All requests target loopback (127.0.0.1) so macOS never shows a
// "local network" permission prompt.

import { randomUUID } from "crypto";

import { logger } from "@glaze/core/backend";

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
};

const STATUS_TIMEOUT_MS = 4000;

function providerLabel(provider: LlmProvider): string {
  return provider === "ollama" ? "Ollama" : "LM Studio";
}

function baseUrlFor(provider: LlmProvider): string {
  const override = llmConfigStore.get().baseUrls?.[provider];
  return (override && override.trim()) || DEFAULT_BASE_URLS[provider];
}

async function fetchModels(provider: LlmProvider, base: string): Promise<LlmModel[]> {
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
    const res = await fetch(`${base}/v1/chat/completions`, {
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
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Chat request failed (HTTP ${res.status}). ${text}`.trim());
    }

    // Parse the OpenAI-style SSE stream: lines of `data: {json}` ending in `data: [DONE]`.
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) sendToMain("llm:chunk", { requestId, delta });
        } catch {
          // Ignore keep-alive lines / partial JSON between chunks.
        }
      }
    }
    sendToMain("llm:done", { requestId });
  } catch (err) {
    if (controller.signal.aborted) {
      sendToMain("llm:done", { requestId, cancelled: true });
    } else {
      const message = err instanceof Error ? err.message : String(err);
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

  /** Probe a provider's local server: reachable + available models. Never throws. */
  async status(provider: LlmProvider): Promise<LlmProviderStatus> {
    const base = baseUrlFor(provider);
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

  /** Probe both providers at once. */
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
