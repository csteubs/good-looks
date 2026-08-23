// Persists the user's local-LLM selection (provider, model, base URL overrides)
// to a small JSON file under userData, mirroring the test-store pattern.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import type { LlmConfig, LlmProvider, LlmRole, LlmRoleSlot } from "./llm/types.js";

const DEFAULT_CONFIG: LlmConfig = { provider: "ollama", model: null, baseUrls: {} };

function configFile(): string {
  return path.join(app.getPath("userData"), "recorder", "llm-config.json");
}

function normalizeProvider(v: unknown): LlmProvider {
  if (v === "lmstudio") return "lmstudio";
  if (v === "anthropic") return "anthropic";
  return "ollama";
}

/** What `set` accepts: any part of the config, with a role slot set to
 *  `null` meaning "clear it". */
export type LlmConfigPatch = Omit<Partial<LlmConfig>, "roles"> & {
  roles?: Partial<Record<LlmRole, LlmRoleSlot | null>>;
};

/** The role slots, rebuilt. A slot is kept only when it names a provider;
 *  the autocomplete slot is dropped outright when it names Anthropic — a
 *  hosted FIM model would receive a prefix of the script on every keystroke,
 *  and refusing it here (not only in the pane) is what makes that a rule. */
export function normalizeRoles(v: unknown): Partial<Record<LlmRole, LlmRoleSlot>> {
  const out: Partial<Record<LlmRole, LlmRoleSlot>> = {};
  if (!v || typeof v !== "object") return out;
  const raw = v as Record<string, unknown>;
  for (const role of ["chat", "instant", "autocomplete"] as LlmRole[]) {
    const slot = raw[role];
    if (!slot || typeof slot !== "object") continue;
    const { provider, model } = slot as { provider?: unknown; model?: unknown };
    if (provider !== "ollama" && provider !== "lmstudio" && provider !== "anthropic") continue;
    if (role === "autocomplete" && provider === "anthropic") continue;
    out[role] = { provider, model: typeof model === "string" && model ? model : null };
  }
  return out;
}

/** Seed the slots an older file does not have. The chat slot IS the flat
 *  pair; instant follows chat until assigned; autocomplete stays unset. */
function seededRoles(flat: LlmRoleSlot, roles: Partial<Record<LlmRole, LlmRoleSlot>>): Partial<Record<LlmRole, LlmRoleSlot>> {
  // Only chat is seeded. An ABSENT instant slot means "follow chat" — the
  // service's resolveSlot falls back to the flat pair — and that is a state
  // the pane offers by name ("Same as chat"), so it must survive on disk. A
  // seeded copy would look identical until the day chat changes and instant
  // silently stays behind.
  const chat = roles.chat ?? flat;
  return {
    chat,
    ...(roles.instant ? { instant: roles.instant } : {}),
    ...(roles.autocomplete ? { autocomplete: roles.autocomplete } : {}),
  };
}

function read(): LlmConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), "utf-8")) as Partial<LlmConfig>;
    const roles = normalizeRoles(parsed.roles);
    // The chat slot wins over the flat pair when both exist and differ — the
    // slot is what the pane writes; the pair is its mirror for older readers.
    const flat: LlmRoleSlot = roles.chat ?? {
      provider: normalizeProvider(parsed.provider),
      model: typeof parsed.model === "string" ? parsed.model : null,
    };
    return {
      provider: flat.provider,
      model: flat.model,
      baseUrls:
        parsed.baseUrls && typeof parsed.baseUrls === "object"
          ? (parsed.baseUrls as LlmConfig["baseUrls"])
          : {},
      roles: seededRoles(flat, roles),
    };
  } catch {
    const flat = { provider: DEFAULT_CONFIG.provider, model: DEFAULT_CONFIG.model };
    return { ...DEFAULT_CONFIG, baseUrls: {}, roles: seededRoles(flat, {}) };
  }
}

export const llmConfigStore = {
  get(): LlmConfig {
    return read();
  },

  /** Merge a partial config in. `roles` merges PER KEY, like `baseUrls` — a
   *  patch that names one role must not wipe the other two — and a role set
   *  to `null` is cleared (how the pane turns autocomplete off). The flat
   *  pair and the chat slot are kept in step whichever one the caller set. */
  set(update: LlmConfigPatch): LlmConfig {
    const current = read();
    const roles: Partial<Record<LlmRole, LlmRoleSlot>> = { ...(current.roles ?? {}) };
    const incoming = update.roles ?? {};
    for (const role of ["chat", "instant", "autocomplete"] as LlmRole[]) {
      if (!(role in incoming)) continue;
      if (incoming[role] === null) {
        delete roles[role];
        continue;
      }
      const slot = normalizeRoles({ [role]: incoming[role] })[role];
      if (slot) roles[role] = slot;
      else if (role === "autocomplete") delete roles[role];
    }
    let provider = update.provider ? normalizeProvider(update.provider) : current.provider;
    // model may be explicitly set to null to clear it.
    let model = update.model !== undefined ? update.model : current.model;
    if (incoming.chat && roles.chat) {
      provider = roles.chat.provider;
      model = roles.chat.model;
    } else if (update.provider !== undefined || update.model !== undefined) {
      roles.chat = { provider, model };
    }
    const next: LlmConfig = {
      provider,
      model,
      baseUrls: { ...current.baseUrls, ...(update.baseUrls ?? {}) },
      roles: seededRoles({ provider, model }, roles),
    };
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), "utf-8");
    logger.info("llm", "Saved LLM config", {
      provider: next.provider,
      model: next.model,
      roles: Object.keys(next.roles ?? {}).length,
    });
    return next;
  },
};
