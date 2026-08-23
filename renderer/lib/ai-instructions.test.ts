import { describe, it, expect } from "vitest";

import { resolveAiInstructions, hostOfUrl } from "./ai-instructions";

describe("resolveAiInstructions", () => {
  it("is empty with no settings or no text", () => {
    expect(resolveAiInstructions(undefined, "https://a.example")).toBe("");
    expect(resolveAiInstructions({ aiInstructions: "  ", aiInstructionsByHost: {} }, "https://a.example")).toBe("");
  });

  it("joins the global text and the host's, naming the host", () => {
    const out = resolveAiInstructions(
      { aiInstructions: "Prefer roles.", aiInstructionsByHost: { "shop.example.com": "Cart is a dialog." } },
      "https://shop.example.com/checkout",
    );
    expect(out).toBe("Prefer roles.\n\nFor shop.example.com:\nCart is a dialog.");
  });

  it("matches the host exactly, not its subdomains, and ignores a bad URL", () => {
    const s = { aiInstructions: "", aiInstructionsByHost: { "shop.example.com": "x" } };
    expect(resolveAiInstructions(s, "https://staging.shop.example.com/")).toBe("");
    expect(resolveAiInstructions(s, "not a url")).toBe("");
    expect(hostOfUrl("https://Shop.Example.com/a")).toBe("shop.example.com");
  });
});
