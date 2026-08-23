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
import { lmStudioTokenStore } from "./lm-studio-token-store.js";

// Capture what the backend pushes to the renderer. Mocked at module level
// because ES module exports are read-only — reassigning `sendToMain` on the
// imported namespace throws.
const { sentEvents } = vi.hoisted(() => ({
  sentEvents: [] as { channel: string; payload: Record<string, unknown> }[],
}));
vi.mock("./app-window.js", () => ({
  sendToMain: (channel: string, payload: Record<string, unknown>) => {
    sentEvents.push({ channel, payload });
  },
  getMainWindow: () => null,
  setMainWindow: () => {},
}));

// The send path refreshes the secret snapshot from the stores before it
// scrubs — under the test stub that refresh finds nothing and would wipe a
// planted secret. Refresh is a no-op here; what the redaction test proves
// is the scrub on the send path, which is the part that has no other cover.
vi.mock("./secret-redaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./secret-redaction.js")>()),
  refreshSecretSnapshot: async () => {},
}));

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

// ── Which LM Studio models are in memory ────────────────────────────────────
//
// /v1/models reports every DOWNLOADED model identically, so the picker couldn't
// say which choice answers immediately and which one stalls for however long
// loading weights takes. LM Studio's own /api/v0/models carries a per-model
// `state`, and it's read as a strictly optional enrichment: the load badge is
// worth having, but never at the cost of the model list itself.
//
// The three-state contract is the thing to protect. `undefined` means the
// provider never said, and rendering that as "not loaded" would tell every
// Ollama user their models are cold — wrong, and not fixable from the UI.
describe("LM Studio load state", () => {
  /** Serve a different body per URL, the way two endpoints on one server do. */
  function routeFetch(routes: Record<string, unknown>, missing: "404" | "throw" = "404") {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) {
        if (missing === "throw") throw new Error("fetch failed");
        return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}), text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => routes[key],
        text: async () => JSON.stringify(routes[key]),
      };
    }) as unknown as typeof fetch;
  }

  const V1 = { data: [{ id: "qwen3-8b" }, { id: "gemma-3-27b" }] };

  it("marks a model loaded or not from LM Studio's own model API", async () => {
    routeFetch({
      "/v1/models": V1,
      "/api/v0/models": {
        data: [
          { id: "qwen3-8b", state: "loaded" },
          { id: "gemma-3-27b", state: "not-loaded" },
        ],
      },
    });

    const models = await llmService.listModels("lmstudio");

    expect(models.find((m) => m.id === "qwen3-8b")?.loaded).toBe(true);
    expect(models.find((m) => m.id === "gemma-3-27b")?.loaded).toBe(false);
  });

  it("keeps the full model list when LM Studio is too old to report load state", async () => {
    // /api/v0 arrived in 0.3.6. An older build 404s it, and the cost of that
    // has to be a missing badge — not a picker with nothing in it.
    routeFetch({ "/v1/models": V1 });

    const models = await llmService.listModels("lmstudio");

    expect(models.map((m) => m.id)).toEqual(["qwen3-8b", "gemma-3-27b"]);
    for (const m of models) expect(m.loaded).toBeUndefined();
  });

  it("stays reachable when the load-state probe fails outright", async () => {
    // Some other OpenAI-compatible server on port 1234 answers /v1/models and
    // nothing else. That must not read as "LM Studio is down".
    routeFetch({ "/v1/models": V1 }, "throw");

    const s = await llmService.status("lmstudio");

    expect(s.reachable).toBe(true);
    expect(s.models).toHaveLength(2);
    expect(s.error).toBeUndefined();
  });

  it("leaves an unrecognized state unknown rather than guessing 'not loaded'", async () => {
    routeFetch({
      "/v1/models": V1,
      "/api/v0/models": {
        data: [
          // A state a future LM Studio might grow. Guessing it means "cold"
          // would be a confident lie; no badge is the honest answer.
          { id: "qwen3-8b", state: "loading" },
          { id: "gemma-3-27b", state: "loaded" },
        ],
      },
    });

    const models = await llmService.listModels("lmstudio");

    expect(models.find((m) => m.id === "qwen3-8b")?.loaded).toBeUndefined();
    expect(models.find((m) => m.id === "gemma-3-27b")?.loaded).toBe(true);
  });

  it("never claims load state for a provider that doesn't report it", async () => {
    okFetch({ models: [{ name: "llama3.2" }] });

    const models = await llmService.listModels("ollama");

    expect(models).toHaveLength(1);
    expect(models[0].loaded).toBeUndefined();
  });
});

// ── Streaming a REASONING model ─────────────────────────────────────────────
//
// The regression: `bonsai-27b` (and any DeepSeek/Qwen-style reasoning model)
// streams its thinking in `delta.reasoning_content` and puts only the final
// answer in `delta.content`. The parser read `content` alone, so every thinking
// token was discarded — and because a model can spend its entire budget
// reasoning, the stream could end having emitted NOTHING. The panel showed
// "thinking", received a plain `done`, and collapsed with no output and no
// error, which is indistinguishable from the feature being broken.
//
// These drive the real parser with SSE captured verbatim from LM Studio.
describe("chat() streaming", () => {
  /** Serve a canned SSE body through the same reader the parser uses. */
  function sseFetch(lines: string[]) {
    const body = lines.map((l) => `${l}\n`).join("");
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        // Chunked mid-line on purpose: the parser buffers partial lines, and a
        // test that always delivers whole ones would never exercise that.
        const bytes = new TextEncoder().encode(body);
        for (let i = 0; i < bytes.length; i += 17) {
          yield bytes.slice(i, i + 17);
        }
      })(),
    })) as unknown as typeof fetch;
  }

  /** Run a canned stream through the real parser and return what it pushed. */
  async function collect(lines: string[]) {
    sentEvents.length = 0;
    sseFetch(lines);
    await llmService.chat({
      messages: [{ role: "user", content: "hi" }],
      provider: "lmstudio",
      model: "test-model",
    });
    // chat() returns once the request is registered; the stream is consumed on
    // a background promise, so wait for the terminal event rather than a timer.
    for (let i = 0; i < 200; i++) {
      if (sentEvents.some((e) => e.channel === "llm:done" || e.channel === "llm:error")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return { events: [...sentEvents] };
  }

  /** Last element. This project targets ES2020 — no Array.prototype.at. */
  const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];

  /** Same as `collect`, against the Anthropic branch (a key is stored). */
  async function collectAnthropic(lines: string[]) {
    const { setEncryptionAvailable } = await import("./__tests__/shell-backend-stub.js");
    setEncryptionAvailable(true);
    const { anthropicKeyStore } = await import("./anthropic-key-store.js");
    await anthropicKeyStore.setKey("sk-ant-test");
    sentEvents.length = 0;
    sseFetch(lines);
    await llmService.chat({ messages: [{ role: "user", content: "hi" }], provider: "anthropic", model: "claude-sonnet-5" });
    for (let i = 0; i < 200; i++) {
      if (sentEvents.some((e) => e.channel === "llm:done" || e.channel === "llm:error")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return { events: [...sentEvents] };
  }

  it("resolves a role's slot and reports it, falling back to the chat pair for a role with no slot", async () => {
    const { llmConfigStore } = await import("./llm-config-store.js");
    llmConfigStore.set({ provider: "lmstudio", model: "chat-model", roles: { instant: { provider: "ollama", model: "tiny" } } });
    sseFetch(['data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]"]);
    const instant = llmService.chat({ messages: [{ role: "user", content: "hi" }], role: "instant" });
    expect([instant.provider, instant.model]).toEqual(["ollama", "tiny"]);
    const auto = llmService.chat({ messages: [{ role: "user", content: "hi" }], role: "autocomplete" });
    expect([auto.provider, auto.model]).toEqual(["lmstudio", "chat-model"]);
    const plain = llmService.chat({ messages: [{ role: "user", content: "hi" }] });
    expect([plain.provider, plain.model]).toEqual(["lmstudio", "chat-model"]);
    llmConfigStore.set({ provider: "ollama", model: null, roles: { instant: null } });
  });

  it("reads Claude's thinking deltas and its stop reason", async () => {
    const { events } = await collectAnthropic([
      'data: {"type":"message_start"}',
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      'data: {"type":"message_stop"}',
    ]);
    const chunks = events.filter((e) => e.channel === "llm:chunk").map((e) => e.payload);
    expect(chunks).toEqual([{ requestId: expect.any(String), delta: "hmm", reasoning: true }, { requestId: expect.any(String), delta: "answer" }]);
    expect(last(events)?.channel).toBe("llm:done");
  });

  it("scrubs every stored secret out of the messages before they leave, on a local provider too", async () => {
    // The egress chokepoint: the prompt builders quote scripts, run output
    // and (Phase 3) the user's own text; the one place all of them pass is
    // streamChatOnce, and the snapshot it scrubs with is refreshed first.
    const { setSecretSnapshotForTesting, REDACTED } = await import("./secret-redaction.js");
    setSecretSnapshotForTesting(["hunter2-planted-secret-value"]);
    sentEvents.length = 0;
    sseFetch(['data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]"]);
    await llmService.chat({
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: 'the page said "hunter2-planted-secret-value"' },
      ],
      provider: "lmstudio",
      model: "test-model",
    });
    for (let i = 0; i < 200; i++) {
      if (sentEvents.some((e) => e.channel === "llm:done" || e.channel === "llm:error")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const body = String((calls[calls.length - 1][1] as { body: string }).body);
    expect(body).not.toContain("hunter2-planted-secret-value");
    expect(body).toContain(REDACTED);
    expect(body).toContain("rules");
  });

  const chunk = (delta: Record<string, string>) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}`;

  it("ends an Anthropic stream that answered in llm:done, not empty-response", async () => {
    // The Anthropic branch parses a different SSE shape, and its delta handler
    // has to feed the same `sawContent` flag the OpenAI branch feeds — a
    // successful Claude stream that skips it delivers every chunk and then
    // reports "empty response", which is a stream that plainly wasn't.
    vi.spyOn(anthropicKeyStore, "getKey").mockResolvedValue("sk-test");
    sentEvents.length = 0;
    sseFetch([
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "The selector " } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "is stale." } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ]);
    await llmService.chat({
      messages: [{ role: "user", content: "hi" }],
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    for (let i = 0; i < 200; i++) {
      if (sentEvents.some((e) => e.channel === "llm:done" || e.channel === "llm:error")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const events = [...sentEvents];
    const answer = events.filter((e) => e.channel === "llm:chunk" && !e.payload.reasoning);
    expect(answer.map((c) => c.payload.delta).join("")).toBe("The selector is stale.");
    expect(last(events)?.channel).toBe("llm:done");
  });

  it("streams a reasoning model's thinking instead of discarding it", async () => {
    const { events } = await collect([
      chunk({ reasoning_content: "Let me " }),
      chunk({ reasoning_content: "check the log." }),
      chunk({ content: "The selector is stale." }),
      "data: [DONE]",
    ]);
    const chunks = events.filter((e) => e.channel === "llm:chunk");
    const thinking = chunks.filter((c) => c.payload.reasoning === true);
    const answer = chunks.filter((c) => !c.payload.reasoning);

    expect(thinking.map((c) => c.payload.delta).join("")).toBe("Let me check the log.");
    // Flagged, never merged: a model's scratchpad is not its conclusion, and
    // the Apply-fix path downstream reads the answer as a diff.
    expect(answer.map((c) => c.payload.delta).join("")).toBe("The selector is stale.");
    expect(last(events)?.channel).toBe("llm:done");
  });

  it("also understands the `reasoning` spelling", async () => {
    // LM Studio and vLLM use reasoning_content; OpenRouter and others use
    // reasoning. Guessing wrong produces exactly the silent failure above.
    const { events } = await collect([
      chunk({ reasoning: "hmm" }),
      chunk({ content: "done thinking" }),
      "data: [DONE]",
    ]);
    const thinking = events.filter((e) => e.channel === "llm:chunk" && e.payload.reasoning === true);
    expect(thinking.map((c) => c.payload.delta).join("")).toBe("hmm");
  });

  it("reports an error when the model only ever thinks", async () => {
    // THE regression, exactly: reasoning arrives, an answer never does. Ending
    // on a plain `done` is what made the panel collapse with nothing in it.
    const { events } = await collect([
      chunk({ reasoning_content: "thinking and thinking" }),
      "data: [DONE]",
    ]);
    const final = last(events);
    expect(final?.channel).toBe("llm:error");
    expect(String(final?.payload.message)).toMatch(/never produced an answer/i);
    // And it says what to DO about it, since the fix isn't obvious.
    expect(String(final?.payload.message)).toMatch(/token limit|non-reasoning/i);
    expect(events.some((e) => e.channel === "llm:done")).toBe(false);
  });

  it("reports an error on a completely empty stream", async () => {
    const { events } = await collect(["data: [DONE]"]);
    const final = last(events);
    expect(final?.channel).toBe("llm:error");
    // "Sent no data at all" is a different situation from a stream that
    // delivered events carrying no text, and the fixes differ, so the message
    // distinguishes them rather than calling both "an empty response".
    expect(String(final?.payload.message)).toMatch(/sent no data at all/i);
    expect(String(final?.payload.message)).toMatch(/not a connection problem/i);
  });

  // ── Streams that end with no answer ────────────────────────────────
  // The reported symptom: a job minimized mid-stream came back failed, and the
  // message ("may have hit a token limit, or the prompt may have been too long
  // for its context window") made a clean completion look like a dropped
  // connection. It guessed at two causes and gave no way to tell them apart —
  // for a prompt that measured ~780 tokens, both guesses were wrong.

  it("labels an empty response by KIND, so the UI can't offer connection advice", async () => {
    // The shipped bug this prevents: the renderer picked its fix-it hint by
    // regex-matching the message, and this message contains the word "timeout"
    // while explicitly denying one — so it got "check the connection" appended
    // and contradicted itself in the same paragraph. The kind travels with the
    // error now, and it is NOT "connection".
    const { events } = await collect(["data: [DONE]"]);
    const final = last(events);
    expect(final?.channel).toBe("llm:error");
    expect(final?.payload.kind).toBe("empty-response");
  });

  it("labels a transport failure as a connection error", async () => {
    sentEvents.length = 0;
    failFetch("fetch failed");
    await llmService.chat({
      messages: [{ role: "user", content: "hi" }],
      provider: "lmstudio",
      model: "test-model",
    });
    for (let i = 0; i < 200; i++) {
      if (sentEvents.some((e) => e.channel === "llm:error")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const final = last([...sentEvents]);
    expect(final?.payload.kind).toBe("connection");
  });

  it("labels a missing model selection so the hint points at the model setting", async () => {
    sentEvents.length = 0;
    await llmService.chat({
      messages: [{ role: "user", content: "hi" }],
      provider: "lmstudio",
      model: "",
    });
    const final = last([...sentEvents]);
    expect(final?.channel).toBe("llm:error");
    expect(final?.payload.kind).toBe("no-model");
  });

  it("says a content-less stream completed rather than implying it was cut off", async () => {
    const { events } = await collect([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ]);
    const message = String(last(events)?.payload.message);
    expect(last(events)?.channel).toBe("llm:error");
    expect(message).toMatch(/not a connection or timeout problem/i);
    expect(message).toContain("finish reason: stop");
    // Names the model, so a user running several knows which one misbehaved.
    expect(message).toContain("test-model");
  });

  it("blames the token limit only when the provider reports finish_reason=length", async () => {
    const { events } = await collect([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}`,
      "data: [DONE]",
    ]);
    const message = String(last(events)?.payload.message);
    expect(message).toMatch(/hit its token limit/i);
    expect(message).toMatch(/raise the context length/i);
  });

  it("surfaces an answer streamed into a field it doesn't read as OUR bug", async () => {
    // Otherwise indistinguishable from a model that said nothing — and the
    // user has no way to find it. This is the case worth reporting loudly.
    const { events } = await collect([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { output_text: "the answer" }, finish_reason: null }] })}`,
      "data: [DONE]",
    ]);
    const message = String(last(events)?.payload.message);
    expect(message).toMatch(/fields this app doesn't read/i);
    expect(message).toContain("output_text");
  });

  it("reports the prompt size so a context setting can be compared against it", async () => {
    const { events } = await collect(["data: [DONE]"]);
    // collect() sends a two-character prompt, so this is the floor case; what
    // matters is that a number is reported at all rather than a guess.
    expect(String(last(events)?.payload.message)).toMatch(/sent no data at all/i);
  });

  it("still streams an ordinary non-reasoning model unchanged", async () => {
    const { events } = await collect([
      chunk({ content: "Hello" }),
      chunk({ content: " world" }),
      "data: [DONE]",
    ]);
    const chunks = events.filter((e) => e.channel === "llm:chunk");
    expect(chunks.every((c) => c.payload.reasoning === undefined)).toBe(true);
    expect(chunks.map((c) => c.payload.delta).join("")).toBe("Hello world");
    expect(last(events)?.channel).toBe("llm:done");
  });

  // ── complete(): the awaited path for main-process callers ─────────────────
  //
  // Same parser, different consumption: an unattended caller (the insights
  // report) cannot ride sendToMain, which drops every event when no window
  // exists. These pin the properties that differ from chat(): a promise
  // instead of events, a REAL timeout, and staying out of the interactive
  // request map so cancel()/activeCount() cannot see it.
  describe("complete()", () => {
    const params = { messages: [{ role: "user" as const, content: "hi" }] };

    it("collects the answer and excludes a reasoning model's thinking", async () => {
      sseFetch([
        chunk({ reasoning_content: "Let me think. " }),
        chunk({ content: "Use " }),
        chunk({ content: "getByRole." }),
        "data: [DONE]",
      ]);
      const out = await llmService.complete(
        { ...params, provider: "lmstudio", model: "test-model" },
        { timeoutMs: 5000 },
      );
      expect(out.text).toBe("Use getByRole.");
      expect(out.answerChars).toBe("Use getByRole.".length);
      expect(out.promptChars).toBe(2);
      expect(out.provider).toBe("lmstudio");
      expect(out.model).toBe("test-model");
      // The first token was the REASONING delta — liveness, not answer.
      expect(out.firstTokenMs).not.toBeNull();
    });

    it("rejects a reasoning-only stream as empty-response, not an empty success", async () => {
      sseFetch([chunk({ reasoning_content: "thinking forever" }), "data: [DONE]"]);
      await expect(
        llmService.complete({ ...params, provider: "lmstudio", model: "test-model" }, { timeoutMs: 5000 }),
      ).rejects.toMatchObject({ kind: "empty-response" });
    });

    it("rejects a completely empty stream", async () => {
      sseFetch(["data: [DONE]"]);
      await expect(
        llmService.complete({ ...params, provider: "lmstudio", model: "test-model" }, { timeoutMs: 5000 }),
      ).rejects.toMatchObject({ kind: "empty-response" });
    });

    it("rejects with no-model when no model resolves", async () => {
      await expect(
        llmService.complete({ ...params, provider: "lmstudio", model: "" }, { timeoutMs: 5000 }),
      ).rejects.toMatchObject({ kind: "no-model" });
    });

    it("times out against a provider that never answers", async () => {
      // A fetch that hangs until its signal aborts — the shape of a wedged
      // server. chat() would wait on this forever; complete() must not.
      globalThis.fetch = vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      ) as unknown as typeof fetch;
      const start = Date.now();
      await expect(
        llmService.complete({ ...params, provider: "lmstudio", model: "test-model" }, { timeoutMs: 60 }),
      ).rejects.toMatchObject({ kind: "connection" });
      expect(Date.now() - start).toBeLessThan(3000);
      await expect(
        llmService
          .complete({ ...params, provider: "lmstudio", model: "test-model" }, { timeoutMs: 60 })
          .catch((e: Error) => Promise.reject(e.message)),
      ).rejects.toMatch(/timed out/i);
    });

    it("stays invisible to cancel() and activeCount()", async () => {
      // Hold the stream open behind a gate so the completion is in flight
      // while we probe the interactive bookkeeping.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const body = [chunk({ content: "ok" }), "data: [DONE]"].map((l) => `${l}\n`).join("");
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: (async function* () {
          await gate;
          yield new TextEncoder().encode(body);
        })(),
      })) as unknown as typeof fetch;

      const pending = llmService.complete(
        { ...params, provider: "lmstudio", model: "test-model" },
        { timeoutMs: 5000 },
      );
      // In flight, and the interactive map doesn't know: a renderer llm:cancel
      // has nothing to reach, and a background caller's own busy check reads 0.
      expect(llmService.activeCount()).toBe(0);
      llmService.cancel("any-request-id");
      release();
      const out = await pending;
      expect(out.text).toBe("ok");
    });

    it("counts an interactive chat() in activeCount()", async () => {
      sentEvents.length = 0;
      sseFetch([chunk({ content: "hi" }), "data: [DONE]"]);
      llmService.chat({ ...params, provider: "lmstudio", model: "test-model" });
      // Registered in chat()'s synchronous call frame — pinned here because the
      // hydrate re-adopt path depends on exactly this timing.
      expect(llmService.activeCount()).toBe(1);
      for (let i = 0; i < 200; i++) {
        if (sentEvents.some((e) => e.channel === "llm:done" || e.channel === "llm:error")) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(llmService.activeCount()).toBe(0);
    });
  });
});

// ── LM Studio's API token ───────────────────────────────────────────────────
//
// LM Studio's server can be set to require a bearer token, and with it on EVERY
// route 401s — including GET /v1/models, the probe behind the connection dot.
// That failure was indistinguishable from a misconfiguration: the app sent no
// Authorization header at all, so the provider could not be connected to, and
// the message ("LM Studio returned HTTP 401") named neither the cause nor the
// fix. LM Studio's own log is worse than silent about it — it prints
// "Unexpected endpoint or method. (GET /v1/models). Returning 200 anyway",
// which reads as a wrong URL.
//
// Two properties, pinned separately: the token reaches every LM Studio route,
// and a 401 says what to do about it on both sides.
describe("LM Studio API token", () => {
  /** Reject everything the way an authenticating LM Studio does, recording the
   *  headers each route was called with. */
  function unauthorizedFetch() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({}),
        text: async () =>
          JSON.stringify({
            error: { message: "An LM Studio API token is required to make requests" },
          }),
      };
    }) as unknown as typeof fetch;
    return calls;
  }

  /** Answer every route, recording headers — for the "is it sent?" cases. */
  function recordingFetch(body: unknown) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
        text: async () => JSON.stringify(body),
        body: (async function* () {
          yield new TextEncoder().encode("data: [DONE]\n");
        })(),
      };
    }) as unknown as typeof fetch;
    return calls;
  }

  it("sends the stored token as a bearer on the model list AND the load-state probe", async () => {
    // Both, because LM Studio requires the token on every route: an
    // Authorization header on /v1/models alone still loses the load badge to a
    // 401, silently, since that probe swallows its own failures.
    vi.spyOn(lmStudioTokenStore, "getToken").mockResolvedValue("lms-secret");
    vi.spyOn(lmStudioTokenStore, "hasToken").mockResolvedValue(true);
    const calls = recordingFetch({ data: [{ id: "qwen3-8b", state: "loaded" }] });

    await llmService.status("lmstudio");

    const v1 = calls.find((c) => c.url.includes("/v1/models"));
    const v0 = calls.find((c) => c.url.includes("/api/v0/models"));
    expect(v1?.headers.Authorization).toBe("Bearer lms-secret");
    expect(v0?.headers.Authorization).toBe("Bearer lms-secret");
  });

  it("sends the token on chat requests too", async () => {
    vi.spyOn(lmStudioTokenStore, "getToken").mockResolvedValue("lms-secret");
    const calls = recordingFetch({});

    await llmService.chat({
      messages: [{ role: "user", content: "hi" }],
      provider: "lmstudio",
      model: "test-model",
    });
    for (let i = 0; i < 200; i++) {
      if (calls.some((c) => c.url.includes("/v1/chat/completions"))) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    const chat = calls.find((c) => c.url.includes("/v1/chat/completions"));
    expect(chat?.headers.Authorization).toBe("Bearer lms-secret");
  });

  it("sends NO Authorization header when no token is stored", async () => {
    // The default LM Studio configuration wants no credential. An empty bearer
    // would turn a working server into the very 401 this feature exists for.
    vi.spyOn(lmStudioTokenStore, "getToken").mockResolvedValue(null);
    vi.spyOn(lmStudioTokenStore, "hasToken").mockResolvedValue(false);
    const calls = recordingFetch({ data: [{ id: "qwen3-8b" }] });

    await llmService.status("lmstudio");

    // Assert the probe actually happened first: an empty `calls` would make the
    // loop below pass without proving anything.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.headers.Authorization).toBeUndefined();
  });

  it("tells an unauthenticated user where the token comes from, not that the server is down", async () => {
    vi.spyOn(lmStudioTokenStore, "getToken").mockResolvedValue(null);
    vi.spyOn(lmStudioTokenStore, "hasToken").mockResolvedValue(false);
    unauthorizedFetch();

    const s = await llmService.status("lmstudio");

    expect(s.reachable).toBe(false);
    expect(s.hasToken).toBe(false);
    expect(s.error).toMatch(/requires an API token and none is saved/i);
    expect(s.error).toMatch(/Developer → server settings/);
    // The server ANSWERED. "Make sure it is running" would send the user after
    // the one thing that is already true.
    expect(s.error).not.toMatch(/Make sure it is running/i);
  });

  it("says the SAVED token was rejected when there is one", async () => {
    // Different fix: the token exists but is stale, so re-copy it rather than
    // being told to paste a first one.
    vi.spyOn(lmStudioTokenStore, "getToken").mockResolvedValue("stale-token");
    vi.spyOn(lmStudioTokenStore, "hasToken").mockResolvedValue(true);
    unauthorizedFetch();

    const s = await llmService.status("lmstudio");

    expect(s.reachable).toBe(false);
    expect(s.hasToken).toBe(true);
    expect(s.error).toMatch(/rejected the saved API token/i);
  });

  it("reports a chat 401 as auth with the same actionable sentence", async () => {
    vi.spyOn(lmStudioTokenStore, "getToken").mockResolvedValue(null);
    sentEvents.length = 0;
    unauthorizedFetch();

    await llmService.chat({
      messages: [{ role: "user", content: "hi" }],
      provider: "lmstudio",
      model: "test-model",
    });
    for (let i = 0; i < 200; i++) {
      if (sentEvents.some((e) => e.channel === "llm:error")) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    const final = sentEvents[sentEvents.length - 1];
    expect(final?.payload.kind).toBe("auth");
    expect(String(final?.payload.message)).toMatch(/requires an API token and none is saved/i);
  });

  it("leaves hasToken undefined for providers that don't take one", async () => {
    // `false` would invite a "no token saved" hint in a UI for Ollama, which has
    // nowhere to put one.
    okFetch({ models: [{ name: "llama3" }] });
    const s = await llmService.status("ollama");
    expect(s.hasToken).toBeUndefined();
  });
});

describe("completeJson() and fim()", () => {
  function jsonFetch(reply: (url: string, body: Record<string, unknown>) => unknown) {
    globalThis.fetch = vi.fn(async (url: string, init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => reply(String(url), JSON.parse(init.body) as Record<string, unknown>),
      text: async () => "",
    })) as unknown as typeof fetch;
  }
  const calls = () => (globalThis.fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls;
  const SCHEMA = { type: "object", properties: { statement: { type: "string" } }, required: ["statement"] };

  it("asks Ollama's native chat for the schema and parses the object", async () => {
    const { llmConfigStore } = await import("./llm-config-store.js");
    llmConfigStore.set({ roles: { instant: { provider: "ollama", model: "tiny" } } });
    jsonFetch(() => ({ message: { content: JSON.stringify({ statement: 'await page.goto("x");' }) } }));
    const r = await llmService.completeJson<{ statement: string }>({ messages: [{ role: "user", content: "rewrite" }], schema: SCHEMA }, { timeoutMs: 1000 });
    expect(r.value.statement).toBe('await page.goto("x");');
    expect([r.provider, r.model]).toEqual(["ollama", "tiny"]);
    const [url, init] = calls()[0];
    expect(url).toContain("/api/chat");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.format).toEqual(SCHEMA);
    expect(body.stream).toBe(false);
  });

  it("asks LM Studio with response_format json_schema, and retries once when the answer is prose", async () => {
    const { llmConfigStore } = await import("./llm-config-store.js");
    llmConfigStore.set({ roles: { instant: { provider: "lmstudio", model: "small" } } });
    let n = 0;
    jsonFetch(() => ({ choices: [{ message: { content: n++ === 0 ? "Sure! Here you go." : '```json\n{"statement":"ok"}\n```' } }] }));
    const r = await llmService.completeJson<{ statement: string }>({ messages: [{ role: "user", content: "rewrite" }], schema: SCHEMA }, { timeoutMs: 1000 });
    expect(r.value.statement).toBe("ok");
    expect(calls()).toHaveLength(2);
    const body = JSON.parse(calls()[0][1].body) as { response_format: { type: string; json_schema: { strict: boolean } } };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    const retry = JSON.parse(calls()[1][1].body) as { messages: { role: string; content: string }[] };
    expect(retry.messages[retry.messages.length - 1].content).toMatch(/ONLY the JSON object/);
  });

  it("is an error, not a guess, when both answers are not the object", async () => {
    const { llmConfigStore } = await import("./llm-config-store.js");
    llmConfigStore.set({ roles: { instant: { provider: "lmstudio", model: "small" } } });
    jsonFetch(() => ({ choices: [{ message: { content: "no" } }] }));
    await expect(
      llmService.completeJson({ messages: [{ role: "user", content: "x" }], schema: SCHEMA }, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ kind: "empty-response" });
  });

  it("fim sends Ollama the prefix and suffix natively, and LM Studio the family's template", async () => {
    const { llmConfigStore } = await import("./llm-config-store.js");
    llmConfigStore.set({ roles: { autocomplete: { provider: "ollama", model: "qwen2.5-coder:1.5b" } } });
    jsonFetch(() => ({ response: "  await page.click();\n\n  more" }));
    const r = await llmService.fim({ prefix: "test(", suffix: "});" }, { timeoutMs: 1000 });
    expect(r.text).toBe("  await page.click();");
    const body = JSON.parse(calls()[0][1].body) as Record<string, unknown>;
    expect(calls()[0][0]).toContain("/api/generate");
    expect(body.prompt).toBe("test(");
    expect(body.suffix).toBe("});");
    expect(body.keep_alive).toBe("10m");

    llmConfigStore.set({ roles: { autocomplete: { provider: "lmstudio", model: "qwen2.5-coder-7b" } } });
    jsonFetch(() => ({ choices: [{ text: "  await x();<|fim_middle|>" }] }));
    const r2 = await llmService.fim({ prefix: "P", suffix: "S" }, { timeoutMs: 1000 });
    expect(r2.text).toBe("  await x();");
    const b2 = JSON.parse(calls()[0][1].body) as Record<string, unknown>;
    expect(b2.prompt).toBe("<|fim_prefix|>P<|fim_suffix|>S<|fim_middle|>");
    llmConfigStore.set({ roles: { autocomplete: null } });
  });

  it("fim refuses with no-model when nothing is assigned, and never runs hosted", async () => {
    const { llmConfigStore } = await import("./llm-config-store.js");
    llmConfigStore.set({ roles: { autocomplete: null } });
    await expect(llmService.fim({ prefix: "a", suffix: "" }, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: "no-model" });
    // The store refuses the slot; the service's own refusal is pinned by check:editor-egress.
    llmConfigStore.set({ roles: { autocomplete: { provider: "anthropic", model: "x" } } });
    await expect(llmService.fim({ prefix: "a", suffix: "" }, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: "no-model" });
  });
});
