// A code step through the generator and back through the parser: the
// wrapper is the fence, the title the label, the body verbatim.

import { describe, it, expect } from "vitest";

import { generateSpec, dedent } from "./script-generator.js";
import { parseSpecDetailed } from "./spec-parser.js";
import type { Step, TestRecord } from "../recorder/types.js";

function record(steps: Step[]): TestRecord {
  return {
    id: "t",
    name: "T",
    url: "https://a.example",
    createdAt: 0,
    updatedAt: 0,
    steps,
  } as unknown as TestRecord;
}

const code = 'const n = await page.locator("li").count();\nif (n > 3) {\n  await page.mouse.wheel(0, 400);\n}';

describe("code step round trip", () => {
  it("emits the body verbatim under a test.step wrapper titled by the label", () => {
    const src = generateSpec(record([{ id: "c1", type: "code", code, label: "scroll when long", timestamp: 0 }]));
    expect(src).toContain('await test.step("scroll when long", async () => {');
    expect(src).toContain('    const n = await page.locator("li").count();\n    if (n > 3) {\n      await page.mouse.wheel(0, 400);\n    }\n  });');
    const parsed = parseSpecDetailed(src);
    expect(parsed.skippedRanges).toEqual([]);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0]).toMatchObject({ type: "code", code, label: "scroll when long" });
    expect(parsed.stepRanges).toHaveLength(1);
    expect(src.slice(parsed.stepRanges[0].from, parsed.stepRanges[0].to)).toContain("await test.step(");
  });

  it("a wrapper mixing a modelled statement with an unmodelled one keeps the old accounting", () => {
    const src = 'import { test, expect } from "@playwright/test";\ntest("t", async ({ page }) => {\n  await test.step("both", async () => {\n    await page.goto("https://a.example");\n    await page.mouse.wheel(0, 1);\n  });\n});\n';
    const parsed = parseSpecDetailed(src);
    expect(parsed.steps.map((s) => s.type)).toEqual(["goto"]);
    // The unmodelled statement is skipped as before — not fenced into code.
    expect(parsed.skippedRanges.length).toBeGreaterThanOrEqual(1);
    expect(parsed.steps.some((s) => s.type === "code")).toBe(false);
  });

  it("a disabled code step is commented out line by line and reads back disabled", () => {
    const src = generateSpec(record([{ id: "c1", type: "code", code: "await page.mouse.wheel(0, 1);", timestamp: 0, disabled: true }]));
    expect(src).toContain("// disabled — skipped: await page.mouse.wheel(0, 1);");
    expect(src).not.toMatch(/^\s*await page\.mouse/m);
  });

  it("dedent strips the shared indentation and nothing else", () => {
    expect(dedent("\n    a\n      b\n    c\n")).toBe("a\n  b\nc");
    expect(dedent("a\n\n  b")).toBe("a\n\n  b");
  });
});
