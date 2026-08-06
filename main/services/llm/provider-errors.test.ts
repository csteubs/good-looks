// Decoding a provider's HTTP error into something a user can act on.
//
// The case that motivated this: LM Studio failed to load a model and the panel
// showed the status code with the raw JSON body pasted after it — the one
// sentence that mattered buried in machine formatting, with nothing about what
// to do next. The other failure mode covered here is misreading a provider
// error as the server being unreachable, which sends the user to check a
// connection that is working.

import { describe, it, expect } from "vitest";

import {
  ProviderError,
  approxTokens,
  describeEmptyResponse,
  describeHttpFailure,
  extractProviderMessage,
  isModelUnavailable,
  providerLabel,
} from "./provider-errors.js";

// Verbatim from LM Studio's server log for a model that would not load.
const LM_STUDIO_LOAD_FAILURE = JSON.stringify({
  error: 'Failed to load model "google/gemma-4-e4b". Error: LM Link connection closed',
});

describe("extractProviderMessage", () => {
  it("reads Ollama and LM Studio's `{error: string}` shape", () => {
    expect(extractProviderMessage('{"error":"model is loading"}')).toBe("model is loading");
  });

  it("reads the OpenAI-compatible `{error: {message}}` shape", () => {
    expect(extractProviderMessage('{"error":{"message":"context length exceeded","code":"x"}}')).toBe(
      "context length exceeded",
    );
  });

  it("reads `{message}` and `{detail}`", () => {
    expect(extractProviderMessage('{"message":"boom"}')).toBe("boom");
    expect(extractProviderMessage('{"detail":"nope"}')).toBe("nope");
  });

  it("passes plain text through", () => {
    expect(extractProviderMessage("Service Unavailable")).toBe("Service Unavailable");
  });

  it("is null for an empty body, so the caller can fall back to the status", () => {
    expect(extractProviderMessage("")).toBeNull();
    expect(extractProviderMessage("   ")).toBeNull();
  });

  it("is null for JSON with no message field rather than dumping the object", () => {
    // Showing `{"ok":false,"code":17}` is worse than showing the status code.
    expect(extractProviderMessage('{"ok":false,"code":17}')).toBeNull();
  });

  it("collapses whitespace and clamps an error page instead of pasting it whole", () => {
    const html = `<html>\n  <body>\n    ${"x".repeat(500)}\n  </body>\n</html>`;
    const out = extractProviderMessage(html) ?? "";
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("\n");
  });
});

describe("isModelUnavailable", () => {
  it("recognizes each provider's phrasing", () => {
    expect(isModelUnavailable('Failed to load model "google/gemma-4-e4b".')).toBe(true);
    expect(isModelUnavailable("model 'llama3' not found, try pulling it first")).toBe(true);
    expect(isModelUnavailable("model_not_found")).toBe(true);
    expect(isModelUnavailable("no such model")).toBe(true);
  });

  it("does not fire on unrelated failures", () => {
    expect(isModelUnavailable("context length exceeded")).toBe(false);
    expect(isModelUnavailable("Service Unavailable")).toBe(false);
  });
});

describe("describeHttpFailure", () => {
  it("turns the LM Studio model-load failure into one actionable sentence", () => {
    const message = describeHttpFailure({
      status: 400,
      body: LM_STUDIO_LOAD_FAILURE,
      provider: "lmstudio",
      model: "google/gemma-4-e4b",
    });

    // Names the problem, the model, and what to do — in that order.
    expect(message).toContain("LM Studio couldn't load the model");
    expect(message).toContain("google/gemma-4-e4b");
    expect(message).toMatch(/Load it in LM Studio/i);
    // Keeps the provider's own reason, which is what makes it diagnosable.
    expect(message).toContain("LM Link connection closed");

    // And none of the machine formatting that made the original unreadable.
    expect(message).not.toContain("HTTP 400");
    expect(message).not.toContain('{"error"');
    expect(message).not.toContain('\\"');
  });

  it("tells an Ollama user to pull the model", () => {
    const message = describeHttpFailure({
      status: 404,
      body: '{"error":"model \'llama3\' not found, try pulling it first"}',
      provider: "ollama",
      model: "llama3",
    });
    expect(message).toContain("ollama pull llama3");
    // The model branch wins over the generic 404 "check the server URL" advice,
    // which would point at a setting that is perfectly correct.
    expect(message).not.toMatch(/no endpoint at that address/i);
  });

  it("points at the URL setting for a genuine 404", () => {
    const message = describeHttpFailure({
      status: 404,
      body: "Not Found",
      provider: "lmstudio",
      model: "any",
    });
    expect(message).toMatch(/no endpoint at that address/i);
    expect(message).toMatch(/Settings/);
  });

  it("names a bad API key without echoing the body", () => {
    const message = describeHttpFailure({
      status: 401,
      body: '{"error":{"message":"invalid x-api-key"}}',
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(message).toMatch(/rejected the API key/i);
    expect(message).toMatch(/Settings/);
  });

  it("still says something useful when the body is empty", () => {
    const message = describeHttpFailure({
      status: 500,
      body: "",
      provider: "lmstudio",
      model: "m",
    });
    expect(message).toBe("LM Studio couldn't run this request (HTTP 500).");
  });

  it("uses the provider's own words for anything it doesn't recognize", () => {
    const message = describeHttpFailure({
      status: 400,
      body: '{"error":"context length exceeded"}',
      provider: "lmstudio",
      model: "m",
    });
    expect(message).toBe("LM Studio couldn't run this request. context length exceeded");
  });

  it("labels each provider by the name the user chose in Settings", () => {
    expect(providerLabel("lmstudio")).toBe("LM Studio");
    expect(providerLabel("ollama")).toBe("Ollama");
    expect(providerLabel("anthropic")).toBe("Claude");
  });
});

describe("ProviderError", () => {
  it("is distinguishable from a transport failure by type, not by text", () => {
    // Why the class exists. A decoded message quotes the provider verbatim, so
    // its wording is outside our control — this body puts "network" in it, and
    // llm-service's transport patterns would match, replacing an accurate
    // model-load message with "Make sure LM Studio is running".
    const decoded = new ProviderError(
      describeHttpFailure({
        status: 400,
        body: JSON.stringify({
          error: 'Failed to load model "m". network error while fetching weights',
        }),
        provider: "lmstudio",
        model: "m",
      }),
    );
    const TRANSPORT_PATTERNS = /abort|timeout|econnrefused|fetch failed|network/i;

    expect(TRANSPORT_PATTERNS.test(decoded.message)).toBe(true);
    expect(decoded).toBeInstanceOf(ProviderError);
    expect(new Error("fetch failed")).not.toBeInstanceOf(ProviderError);
  });
});

describe("describeEmptyResponse", () => {
  const base = {
    provider: "lmstudio" as const,
    model: "prism-ml/bonsai-27b",
    promptChars: 3134,
    eventCount: 12,
    finishReason: "stop" as string | null,
    deltaFields: ["role", "content"],
    sawReasoning: false,
  };

  it("rules out a connection problem when the model just ends its turn", () => {
    // The reported symptom that led here: a job minimized mid-stream came back
    // failed, and the message's vague "may have hit a token limit, or the
    // prompt may have been too long" made a clean completion look like a
    // dropped connection.
    const message = describeEmptyResponse({ ...base, deltaFields: ["role"] });
    expect(message).toMatch(/not a connection or timeout problem/i);
    expect(message).toContain("finish reason: stop");
    expect(message).toMatch(/chat template/i);
  });

  it("reports the prompt size so a context-length setting can be judged", () => {
    // 3134 chars ≈ 784 tokens — nowhere near a context limit, which is exactly
    // why the old message's "prompt may have been too long" was misleading.
    const message = describeEmptyResponse({ ...base, deltaFields: ["role"] });
    expect(message).toContain("784");
    expect(approxTokens(3134)).toBe(784);
  });

  it("blames the token limit only when the provider says so", () => {
    const message = describeEmptyResponse({
      ...base,
      finishReason: "length",
      deltaFields: ["role"],
    });
    expect(message).toMatch(/hit its token limit/i);
    expect(message).toMatch(/Raise the context length/i);
    // And the generic template advice must not also appear — two competing
    // explanations is how a user ends up changing the wrong setting.
    expect(message).not.toMatch(/chat template/i);
  });

  it("names our own bug when the answer arrived in a field we don't read", () => {
    // The one cause the user cannot possibly diagnose and we can: from the
    // outside it is indistinguishable from a model that said nothing.
    const message = describeEmptyResponse({
      ...base,
      deltaFields: ["role", "text", "output_text"],
    });
    expect(message).toMatch(/fields this app doesn't read/i);
    expect(message).toContain("text, output_text");
    expect(message).toMatch(/please report it/i);
  });

  it("does not cry bug over the fields we do read", () => {
    const message = describeEmptyResponse({
      ...base,
      deltaFields: ["role", "content", "reasoning_content", "reasoning"],
    });
    expect(message).not.toMatch(/fields this app doesn't read/i);
  });

  it("keeps the reasoning-model explanation, now with the prompt size", () => {
    const message = describeEmptyResponse({ ...base, sawReasoning: true });
    expect(message).toMatch(/spent its whole response thinking/i);
    expect(message).toContain("784");
  });

  it("separates 'sent nothing at all' from 'sent events with no text'", () => {
    const silent = describeEmptyResponse({ ...base, eventCount: 0, deltaFields: [] });
    expect(silent).toMatch(/sent no data at all/i);
    expect(silent).toMatch(/not a connection problem/i);
  });

  it("names the model and provider the user chose, not a generic 'local server'", () => {
    const message = describeEmptyResponse({ ...base, deltaFields: ["role"] });
    expect(message).toContain("prism-ml/bonsai-27b");
    expect(message).toContain("LM Studio");
  });
});
