// Where the parser read each step from, and where it gave up.
//
// `parseSpecDetailed` has always answered WHAT it parsed and HOW MANY
// statements it could not; the Script IDE's parse-coverage gutter needs
// WHERE. The ranges are derived from the scan's own progress, so the
// property that matters is agreement with the generator's line map: the
// statement the generator attributes to step k is the one the parser says
// it read step k from.

import { describe, expect, it } from "vitest";

import type { Step } from "../recorder/types.js";
import { generateSpecDetailed } from "./script-generator.js";
import { parseSpecDetailed } from "./spec-parser.js";

let seq = 0;
function step(partial: Partial<Step> & { type: Step["type"] }): Step {
  seq += 1;
  return { id: `s${seq}`, timestamp: seq, ...partial } as Step;
}

/** 1-based line of a character offset. */
function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

const BTN = { k: "testid", v: "go" } as const;

describe("parseSpecDetailed ranges", () => {
  it("reads each step from the line the generator attributed to it", () => {
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: { ...BTN } }),
      step({ type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.c" }),
      step({ type: "assert", assert: "visible", locator: { ...BTN } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "https://example.com", steps });
    const parsed = parseSpecDetailed(source);
    expect(parsed.steps).toHaveLength(steps.length);
    expect(parsed.stepRanges).toHaveLength(steps.length);
    expect(parsed.skippedRanges).toEqual([]);
    const byIndex = new Map<number, number>();
    for (const [line, index] of Object.entries(lineMap)) byIndex.set(index, Number(line));
    parsed.stepRanges.forEach((r, k) => {
      expect(lineOf(source, r.from), `step ${k} starts on its own line`).toBe(byIndex.get(k));
      expect(r.to).toBeGreaterThan(r.from);
      // A range never starts on the previous statement's trailing `;` or on
      // the indentation before it.
      expect(source[r.from]).toMatch(/\S/);
      expect(source[r.from]).not.toBe(";");
    });
  });

  it("places a statement it cannot classify, and nothing else, in skippedRanges", () => {
    const source = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      '  await page.goto("https://example.com");',
      "  await page.mouse.move(1, 2);",
      '  await page.getByTestId("go").click();',
      "});",
      "",
    ].join("\n");
    const parsed = parseSpecDetailed(source);
    expect(parsed.steps.map((s) => s.type)).toEqual(["goto", "click"]);
    expect(parsed.skipped).toBe(1);
    expect(parsed.skippedRanges).toHaveLength(1);
    expect(lineOf(source, parsed.skippedRanges[0].from)).toBe(5);
    expect(source.slice(parsed.skippedRanges[0].from, parsed.skippedRanges[0].to)).toMatch(
      /^await page\.mouse\.move\(1, 2\);?$/,
    );
    expect(parsed.stepRanges.map((r) => lineOf(source, r.from))).toEqual([4, 6]);
  });

  it("keeps offsets honest through comments — stripping preserves every index", () => {
    const source = [
      'import { test, expect } from "@playwright/test";',
      "/* a block comment",
      "   spanning lines */",
      'test("t", async ({ page }) => {',
      "  // a line comment with a https://url.example in it",
      '  await page.goto("https://example.com"); // trailing',
      '  await page.getByTestId("go").click();',
      "});",
    ].join("\n");
    const parsed = parseSpecDetailed(source);
    expect(parsed.steps.map((s) => s.type)).toEqual(["goto", "click"]);
    expect(parsed.stepRanges.map((r) => lineOf(source, r.from))).toEqual([6, 7]);
    expect(source.slice(parsed.stepRanges[0].from, parsed.stepRanges[0].to)).toBe(
      'await page.goto("https://example.com")',
    );
  });

  it("ranges a disabled step and a continue-on-failure step inside their wrappers", () => {
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: { ...BTN }, disabled: true }),
      step({ type: "click", locator: { k: "testid", v: "next" }, continueOnFailure: true }),
    ];
    const { source } = generateSpecDetailed({ name: "t", url: "https://example.com", steps });
    const parsed = parseSpecDetailed(source);
    expect(parsed.steps.map((s) => [s.type, s.disabled ?? false, s.continueOnFailure ?? false])).toEqual([
      ["goto", false, false],
      ["click", true, false],
      ["click", false, true],
    ]);
    const lines = source.split("\n");
    const disabledLine = lines.findIndex((l) => l.includes("disabled") && l.includes('getByTestId("go")')) + 1;
    const tryLine = lines.findIndex((l) => l.includes('getByTestId("next")')) + 1;
    expect(lineOf(source, parsed.stepRanges[1].from)).toBe(disabledLine);
    expect(lineOf(source, parsed.stepRanges[2].from)).toBe(tryLine);
    // The inner statement, not the `try {` — the range is the user's line.
    expect(source.slice(parsed.stepRanges[2].from, parsed.stepRanges[2].to)).toMatch(/^await page\.getByTestId\("next"\)\.click\(\)/);
  });

  it("puts a block's closer on its own brace line", () => {
    const steps = [
      step({ type: "loop", loopCount: 2 }),
      step({ type: "click", locator: { ...BTN } }),
      step({ type: "endLoop" }),
    ];
    const { source } = generateSpecDetailed({ name: "t", url: "https://example.com", steps });
    const parsed = parseSpecDetailed(source);
    expect(parsed.steps.map((s) => s.type)).toEqual(["loop", "click", "endLoop"]);
    const lines = source.split("\n");
    const forLine = lines.findIndex((l) => /^\s*for \(let i = 0; i < 2; i\+\+\) \{/.test(l)) + 1;
    expect(lineOf(source, parsed.stepRanges[0].from)).toBe(forLine);
    // The click sits inside its test.step wrapper (one line below the
    // header), and the loop's own closer comes after the wrapper's.
    expect(lineOf(source, parsed.stepRanges[1].from)).toBe(forLine + 2);
    expect(lineOf(source, parsed.stepRanges[2].from)).toBe(forLine + 4);
    expect(source.slice(parsed.stepRanges[2].from, parsed.stepRanges[2].to)).toBe("}");
  });

  it("answers empty ranges for a file with no test body", () => {
    expect(parseSpecDetailed("export const x = 1;\n")).toEqual({
      steps: [],
      skipped: 0,
      stepRanges: [],
      skippedRanges: [],
    });
  });
});
