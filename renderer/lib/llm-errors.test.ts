// Tests for the LLM error formatter.
//
// Every branch exists to point the user at the ONE setting that fixes their
// problem. A message that falls through to the default is a dead end for
// someone whose AI provider isn't working, so the routing matters.

import { describe, expect, it } from "vitest";

import { friendlyError } from "./llm-errors";

const SETTINGS_HINT = /Open Settings/;

describe("friendlyError", () => {
  it("points a missing model at the provider picker", () => {
    expect(friendlyError("No model selected.")).toMatch(/AI provider to pick one/);
  });

  it("adds a connection hint to a backend-wrapped connection failure", () => {
    const out = friendlyError("Could not reach Ollama. Make sure it is running.");
    expect(out).toMatch(/check the connection/);
  });

  it("adds a connection hint to a raw network error the backend didn't wrap", () => {
    for (const raw of ["fetch failed", "ECONNREFUSED", "The operation was aborted", "network error"]) {
      expect(friendlyError(raw), raw).toMatch(/check the connection/);
    }
  });

  it("points an auth failure at the API key", () => {
    expect(friendlyError("Invalid API key")).toMatch(/update your API key/);
    expect(friendlyError("Request failed with status 401")).toMatch(/update your API key/);
  });

  it("preserves the original message in every branch", () => {
    for (const m of ["No model selected.", "fetch failed", "Invalid API key"]) {
      expect(friendlyError(m).startsWith(m)).toBe(true);
    }
  });

  it("returns an unrecognized message unchanged rather than guessing", () => {
    const odd = "The model produced an unparseable response.";
    expect(friendlyError(odd)).toBe(odd);
    expect(friendlyError(odd)).not.toMatch(SETTINGS_HINT);
  });

  it("handles an empty message", () => {
    expect(() => friendlyError("")).not.toThrow();
  });
});
