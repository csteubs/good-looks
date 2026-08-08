// Tests for parsing LLM responses.
//
// This is a trust boundary of the same kind as the IPC layer: the text comes
// from a model, so it is untrusted, frequently malformed, and never guaranteed
// to match the shape the prompt asked for. Both extractors here feed features
// that WRITE to the user's test — "Apply to script" overwrites a spec file, and
// "AI steps" inserts steps into a recording — so accepting garbage is worse
// than returning null and leaving the user's work alone.

import { describe, expect, it } from "vitest";

import {
  extractCorrectedScript,
  extractStepsJson,
  parseResponse,
  stripThinking,
} from "./parse-llm-response";

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

describe("a reasoning model's inline thinking", () => {
  // The `reasoning_content` / `reasoning` SSE fields llm-service splits out are
  // a DIFFERENT channel. These tags arrive inside the answer text itself, and
  // the thinking is prose — prose full of brackets, which is exactly what the
  // widest-span fallback below latches onto.

  it("removes a closed think block", () => {
    expect(stripThinking("<think>hmm</think>answer").trim()).toBe("answer");
  });

  it("removes the <thinking> spelling too", () => {
    expect(stripThinking("<thinking>hmm</thinking>answer").trim()).toBe("answer");
  });

  it("drops an unterminated block rather than keeping the tail", () => {
    // A stream cut mid-thought. Keeping the tail would present half a thought
    // as the answer.
    expect(stripThinking("real answer\n<think>I should also").trim()).toBe("real answer");
  });

  it("removes several blocks and keeps what is between them", () => {
    expect(stripThinking("<think>a</think>one<think>b</think>two")).toBe("onetwo");
  });

  it("leaves a response with no thinking untouched", () => {
    expect(stripThinking("just an answer")).toBe("just an answer");
  });

  it("does not let bracketed thinking poison the step JSON", () => {
    // The failure this exists for: the fallback spans from the `[` inside the
    // thinking to the `]` of the real array, and JSON.parse rejects the lot —
    // reported to the user as "no usable steps", i.e. as the model's fault.
    const text = [
      "<think>",
      "Maybe [click, then fill] would work? Let me reconsider [the order].",
      "</think>",
      '[{"type":"click","locator":{"k":"testid","v":"submit"}}]',
    ].join("\n");
    const steps = extractStepsJson(text);
    expect(steps).toHaveLength(1);
    expect(steps?.[0]).toMatchObject({ type: "click" });
  });

  it("does not let thinking steal the corrected script", () => {
    const text = [
      "<think>",
      "```ts",
      "import { test } from '@playwright/test';",
      "test('a draft I rejected', async () => {});",
      "```",
      "</think>",
      "Here is the fix:",
      "```ts",
      "import { test } from '@playwright/test';",
      "test('the real one', async () => {});",
      "```",
    ].join("\n");
    expect(extractCorrectedScript(text)).toContain("the real one");
    expect(extractCorrectedScript(text)).not.toContain("a draft I rejected");
  });
});

describe("extractStepsJson accepts every step type the app has", () => {
  // Six of the sixteen used to be rejected outright, so the AI could not
  // produce a conditional, a cookie, a capture, a flow call or a pseudo-state
  // step at all. Each `it` below fails against that allowlist.

  const LOC = { k: "testid", v: "submit" };
  const only = (step: unknown) => extractStepsJson(JSON.stringify([step]));

  it("accepts an if/endif pair around an element condition", () => {
    const steps = extractStepsJson(
      JSON.stringify([
        { type: "if", cond: "visible", locator: LOC },
        { type: "click", locator: LOC },
        { type: "endif" },
      ]),
    );
    expect(steps?.map((s) => s.type)).toEqual(["if", "click", "endif"]);
  });

  it("accepts a page-scoped condition that reads value instead of a locator", () => {
    expect(only({ type: "if", cond: "urlContains", value: "/checkout" })).toHaveLength(1);
  });

  it("accepts a cookie step, and clearAll without a cookie", () => {
    expect(only({ type: "cookie", cookieAction: "set", cookie: { name: "sid", value: "1" } })).toHaveLength(1);
    expect(only({ type: "cookie", cookieAction: "clearAll" })).toHaveLength(1);
  });

  it("accepts a capture step", () => {
    const steps = only({ type: "capture", captureVar: "orderId", captureFrom: "text", locator: LOC });
    expect(steps?.[0]).toMatchObject({ type: "capture", captureVar: "orderId", captureFrom: "text" });
  });

  it("accepts a runFlow step with its arguments", () => {
    const steps = only({ type: "runFlow", flowId: "f1", flowArgs: { email: "a@b.test" } });
    expect(steps?.[0]).toMatchObject({ type: "runFlow", flowId: "f1", flowArgs: { email: "a@b.test" } });
  });

  it("accepts a pseudo-state step", () => {
    expect(only({ type: "state", elementState: "hover", locator: LOC })).toHaveLength(1);
  });

  // ── and still drops what it cannot act on ──────────────────────────────

  it("drops an if with no predicate", () => {
    expect(only({ type: "if", locator: LOC })).toBeNull();
  });

  it("drops an element condition with nothing to resolve", () => {
    expect(only({ type: "if", cond: "visible" })).toBeNull();
  });

  it("drops a page condition with no substring to match", () => {
    expect(only({ type: "if", cond: "urlContains" })).toBeNull();
  });

  it("drops a set/delete cookie step carrying no cookie", () => {
    expect(only({ type: "cookie", cookieAction: "set" })).toBeNull();
    expect(only({ type: "cookie", cookieAction: "delete" })).toBeNull();
  });

  it("drops a cookie step whose cookie has no name", () => {
    expect(only({ type: "cookie", cookieAction: "set", cookie: { value: "1" } })).toBeNull();
  });

  it("drops a capture with no variable to write into", () => {
    expect(only({ type: "capture", captureFrom: "text", locator: LOC })).toBeNull();
  });

  it("drops a capture with nothing to read from", () => {
    expect(only({ type: "capture", captureVar: "orderId" })).toBeNull();
  });

  it("drops a runFlow naming no flow", () => {
    expect(only({ type: "runFlow", flowArgs: { a: "b" } })).toBeNull();
  });

  it("drops a state step with no state, or nothing to apply it to", () => {
    expect(only({ type: "state", locator: LOC })).toBeNull();
    expect(only({ type: "state", elementState: "hover" })).toBeNull();
  });

  it("still rejects a type the app does not have", () => {
    expect(only({ type: "teleport", locator: LOC })).toBeNull();
  });

  it("ignores an unknown vocabulary member rather than carrying it through", () => {
    // A model inventing `cond: "sparkles"` must not have it reach the step.
    expect(only({ type: "if", cond: "sparkles", locator: LOC })).toBeNull();
  });
});

describe("the assert vocabulary matches what the prompt promises", () => {
  // These three were absent from the parser's allowlist while the
  // generate-steps prompt already listed urlEndsWith and urlIs as valid. A
  // model following its instructions exactly had the step dropped, silently.

  const only = (step: unknown) => extractStepsJson(JSON.stringify([step]));

  it("accepts urlEndsWith and urlIs, which the prompt tells the model to use", () => {
    expect(only({ type: "assert", assert: "urlEndsWith", value: "/done" })).toHaveLength(1);
    expect(only({ type: "assert", assert: "urlIs", value: "https://x.test/done" })).toHaveLength(1);
  });

  it("accepts a css assertion with its property", () => {
    const steps = only({
      type: "assert",
      assert: "css",
      cssProp: "background-color",
      cssMatch: "is",
      value: "rgb(0, 82, 204)",
      locator: { k: "testid", v: "cta" },
    });
    expect(steps?.[0]).toMatchObject({ assert: "css", cssProp: "background-color", cssMatch: "is" });
  });

  it("drops a css assertion with no property to read", () => {
    expect(
      only({ type: "assert", assert: "css", value: "red", locator: { k: "testid", v: "cta" } }),
    ).toBeNull();
  });

  it("refuses a camelCase css property rather than comparing an empty string", () => {
    // Playwright reads the property through getPropertyValue(), which answers
    // "" for a camelCase name — the assertion would fail for a reason nothing
    // on screen explains.
    const steps = only({
      type: "assert",
      assert: "css",
      cssProp: "backgroundColor",
      value: "red",
      locator: { k: "testid", v: "cta" },
    });
    expect(steps).toBeNull();
  });
});

describe("css custom properties keep their case", () => {
  it("accepts a mixed-case custom property, which IS case-sensitive", () => {
    const steps = extractStepsJson(
      JSON.stringify([
        {
          type: "assert",
          assert: "css",
          cssProp: "--brandBlue",
          value: "#0052cc",
          locator: { k: "testid", v: "cta" },
        },
      ]),
    );
    expect(steps?.[0]).toMatchObject({ cssProp: "--brandBlue" });
  });
});
