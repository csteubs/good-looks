import { describe, expect, it } from "vitest";

import { fimTemplateFor, trimCompletion } from "./fim.js";

describe("fim templates", () => {
  it("spells each family's tokens, and knows none for a chat model", () => {
    expect(fimTemplateFor("qwen2.5-coder:7b")!.prompt("a", "b")).toBe("<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>");
    expect(fimTemplateFor("codellama:13b-code")!.prompt("a", "b")).toBe("<PRE> a <SUF>b <MID>");
    expect(fimTemplateFor("starcoder2:3b")!.prompt("a", "b")).toBe("<fim_prefix>a<fim_suffix>b<fim_middle>");
    expect(fimTemplateFor("deepseek-coder-v2")!.prompt("a", "b")).toContain("fim▁hole");
    expect(fimTemplateFor("llama3.1:8b")).toBeNull();
  });

  it("trims a completion at its stop token and at the first blank line", () => {
    expect(trimCompletion("  await x();\n<|fim_middle|>junk", ["<|fim_middle|>"])).toBe("  await x();");
    expect(trimCompletion("  await x();\n\n  await y();", [])).toBe("  await x();");
    expect(trimCompletion("done   \n", [])).toBe("done");
  });
});
