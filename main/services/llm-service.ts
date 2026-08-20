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
import { lmStudioTokenStore } from "./lm-studio-token-store.js";
// Every provider request goes through appFetch: identical to global fetch
// until Settings → Proxy covers app traffic. Local providers stay direct
// regardless — loopback never proxies.
import { appFetch } from "./proxy-service.js";
import {
  ProviderError,
  describeEmptyResponse,
  describeHttpFailure,
  describeLmStudioAuthFailure,
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

/**
 * Auth headers for a local provider, if it needs any.
 *
 * LM Studio's server can require a bearer token, and when it does it requires
 * one on EVERY route — the model list and the load-state probe as much as chat.
 * So this is applied at all three call sites rather than only where a
 * credential feels like it belongs. No token stored = no header, which is the
 * correct request for the default (unauthenticated) configuration; sending an
 * empty bearer instead would turn a working server into a 401.
 */
async function localAuthHeaders(provider: LlmProvider): Promise<Record<string, string>> {
  if (provider !== "lmstudio") return {};
  const token = await lmStudioTokenStore.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function baseUrlFor(provider: LlmProvider): string {
  const override = llmConfigStore.get().baseUrls?.[provider];
  return (override && override.trim()) || DEFAULT_BASE_URLS[provider];
}

/** The active provider and the URL its requests go to — what the proxy
 *  validator's "Verify app connectivity" checks, so the verification exercises
 *  the endpoint the app actually talks to rather than one invented for it. */
export function activeProviderEndpoint(): { provider: LlmProvider; url: string } {
  const provider = llmConfigStore.get().provider;
  return { provider, url: baseUrlFor(provider) };
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
    const res = await appFetch(`${base}/v1/models`, {
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
    const res = await appFetch(`${base}/api/tags`, {
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
  const headers = await localAuthHeaders(provider);
  const res = await appFetch(`${base}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  // A 401 here is authentication, not absence: the server is up and answering.
  // Reported as a ProviderError so status() keeps this sentence instead of
  // replacing it with "make sure it is running", which is already true.
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(
      describeLmStudioAuthFailure(Boolean(headers.Authorization)),
      "auth",
    );
  }
  if (!res.ok) throw new Error(`LM Studio returned HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (data.data ?? []).map((m) => (m.id ?? "").trim()).filter(Boolean);
  const loaded = await fetchLmStudioLoadState(base, headers);
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
async function fetchLmStudioLoadState(
  base: string,
  headers: Record<string, string>,
): Promise<Map<string, boolean>> {
  const states = new Map<string, boolean>();
  try {
    const res = await appFetch(`${base}/api/v0/models`, {
      headers,
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

// In-flight INTERACTIVE chat requests keyed by requestId, so llm:cancel can
// abort them. `complete()` deliberately never enters this map — see its doc.
const activeRequests = new Map<string, AbortController>();

/** One streamed delta, answer or reasoning. The provider round trip reports
 *  through this rather than pushing to a window, so the streaming `chat()`
 *  path and the awaited `complete()` path share one parser. */
interface ChatSink {
  chunk(delta: string, reasoning: boolean): void;
}

/** What a cleanly-ended stream can testify about itself. The caller applies
 *  the empty-response rule from these — the rule is policy, the facts are not. */
interface StreamFacts {
  sawContent: boolean;
  sawReasoning: boolean;
  eventCount: number;
  finishReason: string | null;
  deltaFields: string[];
  promptChars: number;
}

/**
 * The provider round trip: auth, fetch, SSE parse. THROWS on failure
 * (ProviderError for decoded failures, the transport error otherwise) and
 * returns facts on a cleanly-ended stream. It never touches sendToMain,
 * activeRequests or the logger — the wrappers own those, which is what keeps
 * the streaming path's observable behavior byte-identical.
 */
async function streamChatOnce(
  provider: LlmProvider,
  model: string,
  base: string,
  params: LlmChatParams,
  controller: AbortController,
  sink: ChatSink,
): Promise<StreamFacts> {
  let res: Response;
  // Kept so the 401 branch can say whether a token was actually sent, rather
  // than re-reading the store and possibly answering about a different one.
  let authHeaders: Record<string, string> = {};
  if (provider === "anthropic") {
    const key = await anthropicKeyStore.getKey();
    if (!key) {
      throw new ProviderError("Add your Anthropic API key.", "auth");
    }
    const { system, messages } = toAnthropicPayload(params.messages);
    res = await appFetch(`${base}/v1/messages`, {
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
    authHeaders = await localAuthHeaders(provider);
    res = await appFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
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
    const failure = describeHttpFailure({
      status: res.status,
      body: text,
      provider,
      model,
      hasToken: Boolean(authHeaders.Authorization),
    });
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
            if (delta) {
              // Feeds the same flag the OpenAI branch feeds. It didn't until
              // 2026-08-18, and the miss was silent in the worst way: a
              // successful Claude stream delivered every chunk and then ended
              // in "empty response" instead of done — the answer on screen,
              // an error under it.
              sawContent = true;
              sink.chunk(delta, false);
            }
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
            sink.chunk(delta, false);
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
            sink.chunk(thinking, true);
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
  return {
    sawContent,
    sawReasoning,
    eventCount,
    finishReason,
    deltaFields: [...deltaFields],
    promptChars: params.messages.reduce((n, m) => n + m.content.length, 0),
  };
}

/**
 * Classify a chat failure into the sentence and kind the renderer routes on.
 * Extracted so the streaming and awaited paths cannot drift in how they decode
 * the same failure.
 *
 * The instanceof check matters rather than matching on text, because a
 * decoded message quotes the provider verbatim: a body mentioning e.g. a
 * "network error while fetching weights" would match the patterns below
 * and replace a correct, actionable message with "Make sure LM Studio is
 * running" — sending the user after a server that is up and answering.
 */
function decodeChatFailure(
  err: unknown,
  provider: LlmProvider,
  base: string,
): { message: string; kind: LlmErrorKind } {
  const raw = err instanceof Error ? err.message : String(err);
  const decoded = err instanceof ProviderError ? err : null;
  const isConnError = !decoded && /abort|timeout|econnrefused|fetch failed|network/i.test(raw);
  const message = isConnError
    ? provider === "anthropic"
      ? `Could not reach Claude (${base}). Check your internet connection and try again.`
      : `Could not reach ${providerLabel(provider)} at ${base}. Make sure it is running.`
    : raw;
  // A decoded provider failure keeps its own kind; anything else is either
  // a recognized transport failure or genuinely unclassified.
  const kind: LlmErrorKind = decoded ? decoded.kind : isConnError ? "connection" : "provider";
  return { message, kind };
}

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
  // Everything up to the first `await` inside streamChatOnce runs in chat()'s
  // synchronous call frame, and two of its effects are load-bearing there: the
  // no-model error above is on the wire before chat() returns, and the request
  // is registered below before it returns — the AI debug store's hydrate
  // re-adopt asks isActive() immediately.
  const base = baseUrlFor(provider);
  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  try {
    const facts = await streamChatOnce(provider, model, base, params, controller, {
      chunk(delta, reasoning) {
        sendToMain("llm:chunk", reasoning ? { requestId, delta, reasoning: true } : { requestId, delta });
      },
    });
    if (!facts.sawContent) {
      // The stream finished without a single token of ANSWER. Ending on a plain
      // `done` here is what made this look like the feature was broken: the
      // panel collapsed with nothing in it and nothing to explain why.
      //
      // The reasoning case is worth naming separately, because the fix is
      // different: the model was working, it just never stopped thinking.
      const message = describeEmptyResponse({
        provider,
        model,
        promptChars: facts.promptChars,
        eventCount: facts.eventCount,
        finishReason: facts.finishReason,
        deltaFields: facts.deltaFields,
        sawReasoning: facts.sawReasoning,
      });
      logger.warn("llm", "Chat stream produced no answer", {
        requestId,
        model,
        eventCount: facts.eventCount,
        finishReason: facts.finishReason,
        deltaFields: facts.deltaFields,
        sawReasoning: facts.sawReasoning,
      });
      sendToMain("llm:error", { requestId, message, kind: "empty-response" satisfies LlmErrorKind });
      return;
    }
    sendToMain("llm:done", { requestId });
  } catch (err) {
    if (controller.signal.aborted) {
      sendToMain("llm:done", { requestId, cancelled: true });
    } else {
      const { message, kind } = decodeChatFailure(err, provider, base);
      logger.warn("llm", "Chat request failed", { requestId, message, kind });
      sendToMain("llm:error", { requestId, message, kind });
    }
  } finally {
    activeRequests.delete(requestId);
  }
}

/** What `complete()` resolves with. Character counts, not tokens — a token
 *  count is a guess dressed as a measurement (it depends on the tokenizer,
 *  which depends on the provider), the same rule the AI debug history follows. */
export interface LlmCompletion {
  /** Answer deltas only — a reasoning model's thinking is excluded, for the
   *  same reason the streaming path flags rather than merges it. */
  text: string;
  provider: LlmProvider;
  model: string;
  promptChars: number;
  answerChars: number;
  /** ms until the first delta of EITHER kind — liveness, matching the AI
   *  debug history's "first token proves alive" reading. Null: none arrived. */
  firstTokenMs: number | null;
  durationMs: number;
}

/** A `complete()` failure, carrying the same kind vocabulary the streaming
 *  path's `llm:error` events use so callers store one vocabulary. */
export class LlmCompletionError extends Error {
  readonly kind: LlmErrorKind;
  constructor(message: string, kind: LlmErrorKind) {
    super(message);
    this.name = "LlmCompletionError";
    this.kind = kind;
  }
}


/**
 * One NON-streaming vision call: a claim about a screenshot, answered as a
 * strict verdict. Serves the post-run AI-check pipeline, which wants a small
 * JSON answer per screenshot rather than an interactive stream.
 *
 * Throws with the provider's own sentence when the call cannot be made (no
 * key, model without vision, server down) — the caller records the check as
 * UNEVALUATED with that reason, which is the honest degradation.
 */
export async function visionVerdict(params: {
  claim: string;
  pngBase64: string;
}): Promise<{ pass: boolean; reason: string }> {
  const cfg = llmConfigStore.get();
  const provider = cfg.provider;
  const model = cfg.model;
  if (!model) throw new Error("No model selected — pick one in Settings → AI.");
  const base = baseUrlFor(provider);
  const prompt =
    "You are verifying a UI screenshot against a claim from an automated test.\n" +
    'Claim: "' + params.claim.replace(/"/g, "'") + '"\n' +
    "Look only at what is visible in the screenshot. Answer with STRICT JSON, nothing else: " +
    '{"pass": true|false, "reason": "<one short sentence>"}';

  let text: string;
  if (provider === "anthropic") {
    const key = await anthropicKeyStore.getKey();
    if (!key) throw new Error("Add your Anthropic API key.");
    const res = await appFetch(`${base}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(key),
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: params.pngBase64 },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const failure = describeHttpFailure({ status: res.status, body, provider, model, hasToken: false });
      throw new Error(failure.message);
    }
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    text = (data.content ?? []).map((c) => c.text ?? "").join("");
  } else if (provider === "ollama") {
    // Ollama's NATIVE chat route: `images` on the message is the documented
    // vision shape, and it works for every llava-family model without the
    // OpenAI-compat layer's data-URI variance.
    const res = await appFetch(`${base}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: prompt, images: [params.pngBase64] }],
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status} — the selected model may not support images.`);
    const data = (await res.json()) as { message?: { content?: string } };
    text = data.message?.content ?? "";
  } else {
    const headers = await localAuthHeaders(provider);
    const res = await appFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64," + params.pngBase64 } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const failure = describeHttpFailure({ status: res.status, body, provider, model, hasToken: Boolean(headers.Authorization) });
      throw new Error(failure.message);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    text = data.choices?.[0]?.message?.content ?? "";
  }

  // Strict-JSON was requested; models decorate anyway. Take the first object
  // and refuse anything unparseable rather than guessing a verdict.
  const m = /\{[\s\S]*?\}/.exec(text);
  if (!m) throw new Error("The model's answer was not the requested JSON verdict.");
  let parsed: { pass?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(m[0]) as { pass?: unknown; reason?: unknown };
  } catch {
    throw new Error("The model's answer was not the requested JSON verdict.");
  }
  if (typeof parsed.pass !== "boolean") {
    throw new Error("The model's answer was not the requested JSON verdict.");
  }
  return { pass: parsed.pass, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : "" };
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
    // Only LM Studio has a token in this app; reported so Settings can show
    // whether one is stored without a second round trip.
    const hasToken = provider === "lmstudio" ? await lmStudioTokenStore.hasToken() : undefined;
    try {
      const models = await fetchModels(provider, base);
      return { provider, reachable: true, models, baseUrl: base, hasToken };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // A ProviderError has already been decoded into the actionable sentence —
      // same reasoning as in runChat: an authentication failure means the server
      // IS running, so it must not be overwritten with "make sure it is
      // running", and matching on text would let the provider's own wording
      // trigger that.
      const decoded = err instanceof ProviderError ? err : null;
      const unreachable =
        !decoded && /abort|timeout|ECONNREFUSED|fetch failed|network/i.test(raw);
      const error = unreachable
        ? `Could not reach ${providerLabel(provider)} at ${base}. Make sure it is running.`
        : raw;
      return { provider, reachable: false, models: [], baseUrl: base, error, hasToken };
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
   *
   * IT REPORTS WHICH PROVIDER AND MODEL IT RESOLVED TO, and that is not
   * cosmetic. The caller passes neither most of the time — both fall back to
   * the configured values, which are read HERE — so the renderer asking the
   * settings afterwards would be asking a different question ("what is selected
   * now") and would answer it wrongly for any session that outlived a settings
   * change. The AI debug history's local-versus-hosted split is exactly the
   * figure that would be corrupted by that guess.
   */
  chat(params: LlmChatParams): { requestId: string; provider: LlmProvider; model: string } {
    const requestId = randomUUID();
    const config = llmConfigStore.get();
    const provider = params.provider ?? config.provider;
    const model = params.model ?? config.model ?? "";
    void runChat(requestId, provider, model, params);
    return { requestId, provider, model };
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

  /** How many INTERACTIVE requests are in flight.
   *
   *  `complete()` calls are deliberately not counted: they never enter the
   *  request map, so this is exactly "is a user waiting on an answer right
   *  now" with no filtering. A background caller (the insights report) defers
   *  while this is non-zero, because the local runtimes serve one request at a
   *  time and a scheduled job must never starve an interactive one. */
  activeCount(): number {
    return activeRequests.size;
  },

  /**
   * One awaited chat completion, for MAIN-PROCESS callers.
   *
   * The streaming path reports exclusively through `sendToMain`, which drops
   * every event silently when no window exists — exactly the situation an
   * unattended background job runs in. This collects the same stream in
   * process instead. Three deliberate differences from `chat()`:
   *
   * - It never enters `activeRequests`: `llm:cancel` keeps meaning "cancel an
   *   interactive stream" and can't reach a background job, `isActive()`
   *   semantics are unchanged, and `activeCount()` stays an interactive count.
   *   The only aborts are the timeout here and the caller's own signal.
   * - It has a REAL timeout, which chat() has never had — an unattended call
   *   against a wedged provider would otherwise hang forever.
   * - Failure is a rejection (`LlmCompletionError` carrying the same kind
   *   vocabulary as `llm:error`), not an event.
   *
   * Provider/model resolve exactly as chat() resolves them, and for the same
   * reason: the configured values are read here, so the caller records what
   * was actually used rather than what is selected later.
   */
  async complete(
    params: LlmChatParams,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<LlmCompletion> {
    const config = llmConfigStore.get();
    const provider = params.provider ?? config.provider;
    const model = params.model ?? config.model ?? "";
    if (!model) throw new LlmCompletionError("No model selected.", "no-model");
    const base = baseUrlFor(provider);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
    timer.unref?.();
    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const startedAt = Date.now();
    let text = "";
    let firstTokenMs: number | null = null;
    try {
      const facts = await streamChatOnce(provider, model, base, params, controller, {
        chunk(delta, reasoning) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
          if (!reasoning) text += delta;
        },
      });
      if (!facts.sawContent) {
        // Same rule as the streaming path, or a reasoning-only stream would
        // "succeed" here with an empty string.
        throw new LlmCompletionError(
          describeEmptyResponse({
            provider,
            model,
            promptChars: facts.promptChars,
            eventCount: facts.eventCount,
            finishReason: facts.finishReason,
            deltaFields: facts.deltaFields,
            sawReasoning: facts.sawReasoning,
          }),
          "empty-response",
        );
      }
      return {
        text,
        provider,
        model,
        promptChars: facts.promptChars,
        answerChars: text.length,
        firstTokenMs,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (timedOut) {
        throw new LlmCompletionError(
          `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ${providerLabel(provider)}.`,
          "connection",
        );
      }
      if (opts.signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      if (err instanceof LlmCompletionError) throw err;
      const { message, kind } = decodeChatFailure(err, provider, base);
      throw new LlmCompletionError(message, kind);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternalAbort);
    }
  },
};

export type { LlmMessage };
