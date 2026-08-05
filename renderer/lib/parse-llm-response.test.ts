// Tests for parsing LLM responses.
//
// This is a trust boundary of the same kind as the IPC layer: the text comes
// from a model, so it is untrusted, frequently malformed, and never guaranteed
// to match the shape the prompt asked for. Both extractors here feed features
// that WRITE to the user's test — "Apply to script" overwrites a spec file, and
// "AI steps" inserts steps into a recording — so accepting garbage is worse
// than returning null and leaving the user's work alone.

import { describe, expect, it } from "vitest";

import { extractCorrectedScript, extractStepsJson, parseResponse } from "./parse-llm-response";

describe("parseResponse", () => {
  it("splits prose from fenced code", () => {
    const segs = parseResponse("Here is the fix:\n```ts\nconst a = 1;\n```\nDone.");
    expect(segs.map((s) => s.type)).toEqual(["text", "code", "text"]);
    expect(segs[1]).toMatchObject({ type: "code", closed: true });
  });

  it("marks an unterminated block as not closed", () => {
    // Streaming responses arrive mid-block constantly; treating an open fence
    // as complete would apply a truncated file.
    const segs = parseResponse("Working on it:\n```ts\nconst a = 1;");
    const code = segs.find((s) => s.type === "code");
    expect(code).toMatchObject({ closed: false });
  });

  it("handles text with no code at all", () => {
    const segs = parseResponse("I could not find the problem.");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("text");
  });

  it("handles an empty response", () => {
    expect(() => parseResponse("")).not.toThrow();
  });
});

describe("extractCorrectedScript", () => {
  const fullSpec = `import { test, expect } from "@playwright/test";

test("checkout", async ({ page }) => {
  await page.goto("https://example.com");
});`;

  it("returns a complete spec from a fenced block", () => {
    const out = extractCorrectedScript("Try this:\n```ts\n" + fullSpec + "\n```");
    expect(out).toContain('test("checkout"');
    expect(out).toContain("@playwright/test");
    expect(out?.endsWith("\n")).toBe(true);
  });

  it("returns null when there is no code block", () => {
    expect(extractCorrectedScript("The selector looks wrong to me.")).toBeNull();
  });

  it("returns null for an UNCLOSED block", () => {
    // Applying a half-streamed file would corrupt the user's spec.
    expect(extractCorrectedScript("```ts\n" + fullSpec)).toBeNull();
  });

  it("ignores a snippet that isn't a whole file", () => {
    // A fragment lacks imports/test(...); applying it would produce a spec that
    // doesn't run at all.
    expect(extractCorrectedScript("```ts\nawait page.click('#go');\n```")).toBeNull();
  });

  it("prefers the largest complete block when several are offered", () => {
    const small = `import { test } from "@playwright/test";\ntest("a", async () => {});`;
    const text = "```ts\n" + small + "\n```\nor the full version:\n```ts\n" + fullSpec + "\n```";
    expect(extractCorrectedScript(text)).toContain('test("checkout"');
  });
});

describe("extractStepsJson", () => {
  it("reads a fenced JSON array of steps", () => {
    const text = '```json\n[{"type":"goto","url":"https://x.test"}]\n```';
    const steps = extractStepsJson(text);
    expect(steps).toHaveLength(1);
    expect(steps![0]).toMatchObject({ type: "goto", url: "https://x.test" });
  });

  it("finds an array embedded in prose without a fence", () => {
    const steps = extractStepsJson('Sure! [{"type":"click","locator":{"k":"testid","v":"go"}}] done');
    expect(steps).toHaveLength(1);
    expect(steps![0].type).toBe("click");
  });

  it("drops entries with an unknown step type", () => {
    // A hallucinated step type would otherwise be inserted into the user's test
    // and generate a spec line that doesn't compile.
    const steps = extractStepsJson('[{"type":"teleport"},{"type":"click","locator":{"k":"css","v":"#a"}}]');
    expect(steps).toHaveLength(1);
    expect(steps![0].type).toBe("click");
  });

  it("drops entries with an unknown locator kind", () => {
    const steps = extractStepsJson('[{"type":"click","locator":{"k":"vibes","v":"the button"}}]');
    expect(steps).toBeNull();
  });

  it("drops an assert with an unknown assert kind", () => {
    const steps = extractStepsJson('[{"type":"assert","assert":"looksRight","locator":{"k":"css","v":"#a"}}]');
    expect(steps).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractStepsJson("```json\n[{oops}]\n```")).toBeNull();
  });

  it("returns null when there is no array at all", () => {
    expect(extractStepsJson("I do not know how to do that.")).toBeNull();
  });

  it("returns null for an empty array rather than inserting nothing", () => {
    expect(extractStepsJson("[]")).toBeNull();
  });

  it("does not throw on deeply nonsense input", () => {
    for (const t of ["[[[[", "null", '"a string"', "[1,2,3]", '[{"type":null}]']) {
      expect(() => extractStepsJson(t)).not.toThrow();
    }
  });
});
