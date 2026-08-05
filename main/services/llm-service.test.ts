// Tests for the LLM provider service.
//
// `status()` is the function behind the sidebar's connection dot and the
// Settings provider panel, and it has an explicit contract: NEVER THROW. A
// throw here doesn't surface as a failed probe, it breaks the component that
// awaited it — so "unreachable" and "misconfigured" both have to come back as
// data. Its error strings are also load-bearing: friendlyError (tested
// separately) routes on them to tell the user which setting to fix, so the
// wording is a contract between two modules rather than cosmetic text.
//
// fetch is stubbed rather than hitting a real provider: the point is the
// error-mapping, and a test that needs Ollama running is a test nobody runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { llmService } from "./llm-service.js";
import { anthropicKeyStore } from "./anthropic-key-store.js";

const realFetch = globalThis.fetch;

/** Make fetch fail the way a down local provider does. */
function failFetch(message: string) {
  globalThis.fetch = vi.fn(async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/** Make fetch succeed with a model list. */
function okFetch(body: unknown) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("defaultBaseUrl", () => {
  it("points local providers at localhost", () => {
    expect(llmService.defaultBaseUrl("ollama")).toMatch(/127\.0\.0\.1|localhost/);
    expect(llmService.defaultBaseUrl("lmstudio")).toMatch(/127\.0\.0\.1|localhost/);
  });

  it("points anthropic at the public API", () => {
    expect(llmService.defaultBaseUrl("anthropic")).toContain("api.anthropic.com");
  });
});

describe("status() never throws", () => {
  it("reports a down local provider as unreachable rather than throwing", async () => {
    failFetch("fetch failed");
    const s = await llmService.status("ollama");
    expect(s.reachable).toBe(false);
    expect(s.models).toEqual([]);
  });

  it("survives a provider that throws something that isn't an Error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw "kaboom";
    }) as unknown as typeof fetch;
    const s = await llmService.status("lmstudio");
    expect(s.reachable).toBe(false);
  });

  it("survives malformed JSON from a provider", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new Error("Unexpected token");
      },
      text: async () => "<html>not json</html>",
    })) as unknown as typeof fetch;
    const s = await llmService.status("ollama");
    expect(s.reachable).toBe(false);
  });
});

describe("status() error wording is a contract with friendlyError", () => {
  it("says the local provider isn't running, naming it and its URL", async () => {
    // friendlyError routes on /could not reach|make sure it is running/ to add
    // the Settings hint. Reword this and that routing silently stops matching.
    failFetch("ECONNREFUSED");
    const s = await llmService.status("ollama");
    expect(s.error).toMatch(/could not reach/i);
    expect(s.error).toMatch(/make sure it is running/i);
    expect(s.error).toContain(s.baseUrl);
  });

  it("distinguishes a connection failure from an unexpected error", async () => {
    // A non-connection error must pass through verbatim rather than claiming
    // the provider is down — that would send the user to the wrong fix.
    failFetch("Model index corrupted");
    const s = await llmService.status("ollama");
    expect(s.error).toBe("Model index corrupted");
    expect(s.error).not.toMatch(/make sure it is running/i);
  });
});

describe("status() for Claude", () => {
  it("asks for an API key when none is stored, without any network call", async () => {
    vi.spyOn(anthropicKeyStore, "hasKey").mockResolvedValue(false);
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const s = await llmService.status("anthropic");

    expect(s.hasKey).toBe(false);
    expect(s.reachable).toBe(false);
    expect(s.error).toMatch(/api key/i);
    // No point probing an endpoint we can't authenticate against.
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats an unreadable key as not connected, not as connected-with-no-models", async () => {
    // hasKey() only checks the key FILE exists; getKey() decrypts and returns
    // null on failure. When they disagree — corrupted file, or safeStorage
    // unavailable — the sidebar must not show a green dot for a provider that
    // cannot authenticate.
    vi.spyOn(anthropicKeyStore, "hasKey").mockResolvedValue(true);
    vi.spyOn(anthropicKeyStore, "getKey").mockResolvedValue(null);
    const s = await llmService.status("anthropic");
    expect(s.reachable).toBe(false);
    expect(s.error).toMatch(/api key/i);
  });

  it("reports a connection problem differently from a missing key", async () => {
    vi.spyOn(anthropicKeyStore, "hasKey").mockResolvedValue(true);
    vi.spyOn(anthropicKeyStore, "getKey").mockResolvedValue("sk-test");
    failFetch("fetch failed");

    const s = await llmService.status("anthropic");

    expect(s.hasKey).toBe(true);
    expect(s.reachable).toBe(false);
    expect(s.error).toMatch(/check your internet/i);
  });

  it("passes an auth failure through so the user is told to fix the key", async () => {
    vi.spyOn(anthropicKeyStore, "hasKey").mockResolvedValue(true);
    vi.spyOn(anthropicKeyStore, "getKey").mockResolvedValue("sk-test");
    failFetch("401 invalid api key");

    const s = await llmService.status("anthropic");

    // friendlyError routes /invalid api key|401/ to "update your API key".
    expect(s.error).toMatch(/401|invalid api key/i);
    expect(s.error).not.toMatch(/check your internet/i);
  });

  it("reports reachable with models when the key works", async () => {
    vi.spyOn(anthropicKeyStore, "hasKey").mockResolvedValue(true);
    vi.spyOn(anthropicKeyStore, "getKey").mockResolvedValue("sk-test");
    okFetch({ data: [{ id: "claude-sonnet-5" }, { id: "claude-opus-5" }] });

    const s = await llmService.status("anthropic");

    expect(s.reachable).toBe(true);
    expect(s.hasKey).toBe(true);
    expect(s.models.length).toBeGreaterThan(0);
  });
});

describe("detect()", () => {
  it("probes both local providers and never Claude", async () => {
    // Claude costs an authenticated round trip, so it's probed on demand only.
    failFetch("fetch failed");
    const all = await llmService.detect();
    expect(all.map((s) => s.provider).sort()).toEqual(["lmstudio", "ollama"]);
  });

  it("returns a result per provider even when both are down", async () => {
    failFetch("ECONNREFUSED");
    const all = await llmService.detect();
    expect(all).toHaveLength(2);
    for (const s of all) expect(s.reachable).toBe(false);
  });
});
