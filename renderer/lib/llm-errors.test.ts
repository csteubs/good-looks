// The renderer's hint layer on top of a backend error message.
//
// Its only job is to add "and here is where to fix it". Getting the branch
// order wrong is the failure mode: the backend quotes the provider verbatim,
// so a model-load message can contain words that match the connection
// patterns and send the user to check a connection that is working perfectly.

import { describe, it, expect } from "vitest";

import { friendlyError } from "./llm-errors";

const MODEL_LOAD_FAILURE =
  'LM Studio couldn\'t load the model "google/gemma-4-e4b". Load it in LM Studio ' +
  "(Developer → select the model), or pick a different model. LM Studio said: " +
  "Failed to load model \"google/gemma-4-e4b\". Error: LM Link connection closed";

describe("friendlyError", () => {
  it("points a model-load failure at the model picker, not the connection", () => {
    const out = friendlyError(MODEL_LOAD_FAILURE);
    expect(out).toMatch(/change the model/i);
    expect(out).not.toMatch(/check the connection/i);
  });

  it("keeps model advice even when the provider's own words mention the network", () => {
    // Branch ORDER is the contract: the model branch has to win, or a server
    // that is up and answering gets reported as unreachable.
    const out = friendlyError(
      'LM Studio couldn\'t load the model "m". Load it in LM Studio (Developer → select ' +
        "the model), or pick a different model. LM Studio said: network error while fetching weights",
    );
    expect(out).toMatch(/change the model/i);
    expect(out).not.toMatch(/check the connection/i);
  });

  it("keeps the backend's own explanation intact", () => {
    expect(friendlyError(MODEL_LOAD_FAILURE)).toContain(MODEL_LOAD_FAILURE);
  });

  it("still adds connection advice for a genuinely unreachable server", () => {
    const out = friendlyError("Could not reach LM Studio at http://127.0.0.1:1234. Make sure it is running.");
    expect(out).toMatch(/check the connection/i);
  });

  it("sends a missing model selection to Settings", () => {
    expect(friendlyError("No model selected.")).toMatch(/AI provider to pick one/i);
  });

  it("sends an auth failure to the API key setting", () => {
    expect(friendlyError("Claude rejected the API key. Check it in Settings → AI provider.")).toMatch(
      /update your API key/i,
    );
  });

  it("passes an unrecognized message through unchanged", () => {
    expect(friendlyError("Something specific went wrong.")).toBe("Something specific went wrong.");
  });
});
