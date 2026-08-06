// Appending the right "here is where to fix it" hint to an LLM failure.
//
// This module used to pick the hint by regex-matching the message text, and it
// misfired the moment a message legitimately contained a trigger word. The
// shipped bug: an empty-response message reading "…so this is not a connection
// or timeout problem" matched /timeout/ and had "check the connection"
// appended, so a single paragraph both denied and asserted a connection fault.
//
// The hint is now chosen by the error's KIND, decided by the backend code that
// knows what failed. The text-based guess survives only for errors raised
// before kinds existed (a session restored from disk), so it is tested too —
// including that it refuses to give connection advice to a message that says
// the request completed.

import { describe, it, expect } from "vitest";

import { friendlyError } from "./llm-errors";
import type { LlmErrorKind } from "./llm-types";

// Verbatim from the AI debug window, minus the contradictory tail.
const EMPTY_RESPONSE =
  "prism-ml/bonsai-27b ended its turn without generating any text (finish reason: stop). " +
  "The request completed normally, so this is not a connection or timeout problem. " +
  "The prompt was about 819 tokens. This usually means the model's chat template doesn't " +
  "match how LM Studio is prompting it — try a different model, or re-download this one.";

const MODEL_LOAD_FAILURE =
  'LM Studio couldn\'t load the model "google/gemma-4-e4b". Load it in LM Studio ' +
  "(Developer → select the model), or pick a different model. LM Studio said: " +
  'Failed to load model "google/gemma-4-e4b". Error: LM Link connection closed';

const ALL_KINDS: LlmErrorKind[] = [
  "no-model",
  "auth",
  "model-unavailable",
  "provider",
  "empty-response",
  "connection",
];

describe("friendlyError, routed by kind", () => {
  it("does not contradict an empty-response message with connection advice", () => {
    // THE regression, exactly as shipped. The message contains the word
    // "timeout" while explicitly denying a timeout, and got told to go check
    // the connection anyway.
    const out = friendlyError(EMPTY_RESPONSE, "empty-response");
    expect(out).not.toMatch(/check the connection/i);
    expect(out).not.toMatch(/Open Settings/i);
    // Nothing is misconfigured, so the message stands on its own.
    expect(out).toBe(EMPTY_RESPONSE);
  });

  it("sends a model-load failure to the model picker, not to Settings", () => {
    const out = friendlyError(MODEL_LOAD_FAILURE, "model-unavailable");
    expect(out).toMatch(/change the model from the title/i);
    expect(out).not.toMatch(/check the connection/i);
  });

  it("sends a genuine connection failure to the connection setting", () => {
    const out = friendlyError("Could not reach LM Studio at http://127.0.0.1:1234.", "connection");
    expect(out).toMatch(/check the connection/i);
  });

  it("sends a missing model to the model setting", () => {
    expect(friendlyError("No model selected.", "no-model")).toMatch(/to pick one/i);
  });

  it("sends an auth failure to the API key setting", () => {
    expect(friendlyError("Claude rejected the API key.", "auth")).toMatch(/update your API key/i);
  });

  it("adds nothing to a provider failure that is already self-explanatory", () => {
    const msg = "LM Studio couldn't run this request. context length exceeded";
    expect(friendlyError(msg, "provider")).toBe(msg);
  });

  it("always preserves the backend's own message", () => {
    for (const kind of ALL_KINDS) {
      expect(friendlyError(EMPTY_RESPONSE, kind)).toContain(EMPTY_RESPONSE);
    }
  });

  it("handles every kind without throwing", () => {
    // The mapping is an exhaustive switch, so a new kind is a compile error;
    // this pins the runtime half for a value arriving from disk.
    for (const kind of ALL_KINDS) {
      expect(() => friendlyError("x", kind)).not.toThrow();
    }
  });
});

describe("friendlyError, guessing when no kind travelled with the error", () => {
  it("still refuses connection advice for a message that says it completed", () => {
    // A session persisted before kinds existed replays its message with no
    // kind. The guess must not reintroduce the contradiction.
    const out = friendlyError(EMPTY_RESPONSE);
    expect(out).not.toMatch(/check the connection/i);
    expect(out).toBe(EMPTY_RESPONSE);
  });

  it("recognizes a model-load failure by its wording", () => {
    expect(friendlyError(MODEL_LOAD_FAILURE)).toMatch(/change the model from the title/i);
  });

  it("recognizes a real connection failure by its wording", () => {
    expect(friendlyError("Could not reach Ollama at http://127.0.0.1:11434. Make sure it is running.")).toMatch(
      /check the connection/i,
    );
    expect(friendlyError("fetch failed")).toMatch(/check the connection/i);
  });

  it("recognizes a missing model and a bad key", () => {
    expect(friendlyError("No model selected.")).toMatch(/to pick one/i);
    expect(friendlyError("Claude rejected the API key.")).toMatch(/update your API key/i);
  });

  it("passes an unrecognized message through untouched", () => {
    expect(friendlyError("Something specific went wrong.")).toBe("Something specific went wrong.");
  });

  it("prefers an explicit kind over what the text looks like", () => {
    // The text says "Could not reach", but the backend classified it as an
    // auth failure — the classifier wins, because it knows and the text only
    // suggests.
    const out = friendlyError("Could not reach Claude.", "auth");
    expect(out).toMatch(/update your API key/i);
    expect(out).not.toMatch(/check the connection/i);
  });
});
