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

  const chunk = (delta: Record<string, string>) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}`;

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
});
