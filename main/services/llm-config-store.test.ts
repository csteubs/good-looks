// The three role slots, and the flat pair every older reader still uses.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-llm-config-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { llmConfigStore, normalizeRoles } = await import("./llm-config-store.js");

const file = path.join(userData, "recorder", "llm-config.json");
function write(obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

describe("llmConfigStore roles", () => {
  beforeEach(() => {
    fs.rmSync(file, { force: true });
  });

  it("seeds chat from an older file's flat pair, and leaves instant and autocomplete unset", () => {
    // An absent instant slot FOLLOWS chat (resolveSlot falls back to the flat
    // pair). Seeding a copy here would look the same until chat changed and
    // instant stayed behind — so the pane's "Same as chat" is spelled by
    // absence, and absence must survive a round trip.
    write({ provider: "lmstudio", model: "qwen", baseUrls: {} });
    expect(llmConfigStore.get()).toEqual({
      provider: "lmstudio",
      model: "qwen",
      baseUrls: {},
      roles: { chat: { provider: "lmstudio", model: "qwen" } },
    });
  });

  it("an instant slot that follows chat keeps following when chat changes", () => {
    write({ provider: "ollama", model: "llama3", baseUrls: {} });
    llmConfigStore.set({ provider: "lmstudio", model: "qwen" });
    expect(llmConfigStore.get().roles).toEqual({ chat: { provider: "lmstudio", model: "qwen" } });
  });

  it("a corrupt file is the defaults, with the chat slot seeded", () => {
    write("not json");
    fs.writeFileSync(file, "{nope");
    expect(llmConfigStore.get().roles).toEqual({
      chat: { provider: "ollama", model: null },
    });
  });

  it("merges roles per key, clears one with null, and keeps the flat pair in step with chat", () => {
    write({ provider: "ollama", model: "llama3", baseUrls: {} });
    llmConfigStore.set({ roles: { autocomplete: { provider: "ollama", model: "qwen2.5-coder:1.5b" } } });
    llmConfigStore.set({ roles: { instant: { provider: "lmstudio", model: "small" } } });
    let cfg = llmConfigStore.get();
    expect(cfg.roles).toEqual({
      chat: { provider: "ollama", model: "llama3" },
      instant: { provider: "lmstudio", model: "small" },
      autocomplete: { provider: "ollama", model: "qwen2.5-coder:1.5b" },
    });
    // The chat slot moves the flat pair…
    llmConfigStore.set({ roles: { chat: { provider: "anthropic", model: "claude-sonnet-5" } } });
    cfg = llmConfigStore.get();
    expect([cfg.provider, cfg.model]).toEqual(["anthropic", "claude-sonnet-5"]);
    // …and the flat pair (an older caller) moves the chat slot.
    llmConfigStore.set({ provider: "ollama", model: "llama3" });
    cfg = llmConfigStore.get();
    expect(cfg.roles?.chat).toEqual({ provider: "ollama", model: "llama3" });
    expect(cfg.roles?.autocomplete).toEqual({ provider: "ollama", model: "qwen2.5-coder:1.5b" });
    llmConfigStore.set({ roles: { autocomplete: null } });
    expect(llmConfigStore.get().roles?.autocomplete).toBeUndefined();
  });

  it("refuses a hosted autocomplete slot, on disk and on the way in", () => {
    expect(normalizeRoles({ autocomplete: { provider: "anthropic", model: "claude-haiku-4-5" } })).toEqual({});
    expect(normalizeRoles({ chat: { provider: "anthropic", model: "x" } })).toEqual({ chat: { provider: "anthropic", model: "x" } });
    write({ provider: "ollama", model: "m", baseUrls: {}, roles: { autocomplete: { provider: "anthropic", model: "x" } } });
    expect(llmConfigStore.get().roles?.autocomplete).toBeUndefined();
    llmConfigStore.set({ roles: { autocomplete: { provider: "anthropic", model: "x" } } });
    expect(llmConfigStore.get().roles?.autocomplete).toBeUndefined();
  });

  it("drops a slot that names no provider, and a garbage roles value", () => {
    expect(normalizeRoles({ chat: { model: "m" }, instant: "nope" })).toEqual({});
    expect(normalizeRoles("x")).toEqual({});
  });
});
