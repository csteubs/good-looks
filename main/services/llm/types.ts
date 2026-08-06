// Shared types for the LLM integration.
// Local runtimes (Ollama / LM Studio) expose an OpenAI-compatible
// /v1/chat/completions endpoint; Claude uses Anthropic's Messages API.
// Health-check, model-listing, and chat wiring branch per provider.

export type LlmProvider = "ollama" | "lmstudio" | "anthropic";

/** A model available on a provider, normalized across the two APIs. */
export interface LlmModel {
  /** Identifier passed back in chat requests (Ollama: name, LM Studio: id). */
  id: string;
  /** Human-readable label (same as id for now). */
  label: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Result of probing a provider's local server. */
export interface LlmProviderStatus {
  provider: LlmProvider;
  /** Whether the local server responded. */
  reachable: boolean;
  /** Models the server reported (empty when unreachable). */
  models: LlmModel[];
  /** The base URL that was probed. */
  baseUrl: string;
  /** Friendly failure reason when not reachable. */
  error?: string;
  /** For key-based providers (Anthropic): whether an API key is stored. */
  hasKey?: boolean;
}

/** Persisted user selection. */
export interface LlmConfig {
  provider: LlmProvider;
  /** Chosen model id, or null if none picked yet. */
  model: string | null;
  /** Optional per-provider base URL overrides (empty = use defaults). */
  baseUrls: Partial<Record<LlmProvider, string>>;
}

/** Why a chat request failed, decided by the code that KNOWS — not inferred
 *  downstream from the message text.
 *
 *  The renderer appends "and here is where to fix it" hints, and it used to
 *  pick which hint by regex-matching the message. That misfires whenever a
 *  message legitimately contains a trigger word: an empty-response message
 *  saying "this is not a connection or timeout problem" matched /timeout/ and
 *  had "check the connection" appended to it, contradicting itself in the same
 *  paragraph. The kind travels with the error so the two can't disagree. */
export type LlmErrorKind =
  /** No model configured yet. */
  | "no-model"
  /** Missing/rejected credentials. */
  | "auth"
  /** The model could not be loaded or found by the provider. */
  | "model-unavailable"
  /** The provider answered, but with a failure of its own. */
  | "provider"
  /** The stream completed without producing any answer. */
  | "empty-response"
  /** We never got a usable response — server down, DNS, timeout, abort. */
  | "connection";

/** Parameters for a streaming chat completion. */
export interface LlmChatParams {
  messages: LlmMessage[];
  /** Defaults to the configured provider. */
  provider?: LlmProvider;
  /** Defaults to the configured model. */
  model?: string;
  temperature?: number;
}
