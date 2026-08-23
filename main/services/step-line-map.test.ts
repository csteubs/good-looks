// The runner's fallback line map, for a spec the generator did not just write
// (hand-edited, imported). Tested on text: the file read is one line.

import { describe, expect, it } from "vitest";

import { buildStepLineMapFromSource } from "./playwright-runner.js";

const PLAIN = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("t", async ({ page }) => {',
  '  await page.goto("https://example.com");',
  '  await page.getByTestId("go").click();',
  "  if (true) {",
  '    await expect(page.getByText("ok")).toBeVisible();',
  "  }",
  "});",
  "",
].join("\n");

const WRAPPED = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("t", async ({ page }) => {',
  '  await test.step("goto", async () => {',
  '    await page.goto("https://example.com");',
  "  });",
  '  await test.step("click", async () => {',
  '    await page.getByTestId("go").click();',
  "  });",
  "  if (true) {",
  '    await test.step("assert", async () => {',
  '      await expect(page.getByText("ok")).toBeVisible();',
  "    });",
  "  }",
  "});",
  "",
].join("\n");

describe("buildStepLineMapFromSource", () => {
  it("maps each indented await to the next step index and stops at the body's end", () => {
    expect([...buildStepLineMapFromSource(PLAIN)!.entries()]).toEqual([
      [4, 0],
      [5, 1],
      [7, 2],
    ]);
  });

  it("sees through test.step wrappers: the header is not a step and its closer is not the end", () => {
    expect([...buildStepLineMapFromSource(WRAPPED)!.entries()]).toEqual([
      [5, 0],
      [8, 1],
      [12, 2],
    ]);
  });

  it("answers null for a file with no mappable step", () => {
    expect(buildStepLineMapFromSource('test("t", async () => {\n});\n')).toBeNull();
  });
});
