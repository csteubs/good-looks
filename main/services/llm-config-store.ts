// Persists the user's local-LLM selection (provider, model, base URL overrides)
// to a small JSON file under userData, mirroring the test-store pattern.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import type { LlmConfig, LlmProvider } from "./llm/types.js";

const DEFAULT_CONFIG: LlmConfig = { provider: "ollama", model: null, baseUrls: {} };

function configFile(): string {
  return path.join(app.getPath("userData"), "recorder", "llm-config.json");
}

function normalizeProvider(v: unknown): LlmProvider {
  if (v === "lmstudio") return "lmstudio";
  if (v === "anthropic") return "anthropic";
  return "ollama";
}

function read(): LlmConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), "utf-8")) as Partial<LlmConfig>;
    return {
      provider: normalizeProvider(parsed.provider),
      model: typeof parsed.model === "string" ? parsed.model : null,
      baseUrls:
        parsed.baseUrls && typeof parsed.baseUrls === "object"
          ? (parsed.baseUrls as LlmConfig["baseUrls"])
          : {},
    };
  } catch {
    return { ...DEFAULT_CONFIG, baseUrls: {} };
  }
}

export const llmConfigStore = {
  get(): LlmConfig {
    return read();
  },

  set(update: Partial<LlmConfig>): LlmConfig {
    const current = read();
    const next: LlmConfig = {
      provider: update.provider ? normalizeProvider(update.provider) : current.provider,
      // model may be explicitly set to null to clear it.
      model: update.model !== undefined ? update.model : current.model,
      baseUrls: { ...current.baseUrls, ...(update.baseUrls ?? {}) },
    };
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), "utf-8");
    logger.info("llm", "Saved LLM config", { provider: next.provider, model: next.model });
    return next;
  },
};
