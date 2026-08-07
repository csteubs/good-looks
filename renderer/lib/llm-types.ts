// Renderer-side mirror of the backend LLM types (main/services/llm/types.ts).

export type LlmProvider = "ollama" | "lmstudio" | "anthropic";

export interface LlmModel {
  id: string;
  label: string;
  /** Loaded in the provider's memory. `undefined` = the provider doesn't say —
   *  see main/services/llm/types.ts for why that isn't the same as `false`. */
  loaded?: boolean;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmProviderStatus {
  provider: LlmProvider;
  reachable: boolean;
  models: LlmModel[];
  baseUrl: string;
  error?: string;
  hasKey?: boolean;
}

export interface LlmConfig {
  provider: LlmProvider;
  model: string | null;
  baseUrls: Partial<Record<LlmProvider, string>>;
}

/** Mirror of main/services/llm/types.ts — see there for why this exists. */
export type LlmErrorKind =
  | "no-model"
  | "auth"
  | "model-unavailable"
  | "provider"
  | "empty-response"
  | "connection";

export interface LlmChatParams {
  messages: LlmMessage[];
  provider?: LlmProvider;
  model?: string;
  temperature?: number;
}
