// Renderer-side mirror of the backend LLM types (main/services/llm/types.ts).

export type LlmProvider = "ollama" | "lmstudio" | "anthropic";

export interface LlmModel {
  id: string;
  label: string;
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

export interface LlmChatParams {
  messages: LlmMessage[];
  provider?: LlmProvider;
  model?: string;
  temperature?: number;
}
