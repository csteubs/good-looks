// Loop steps: what a repeat block compiles to, and that every emitted shape
// reads back. Two properties carry the feature:
//
// BALANCE. A `for {` without its `}` — or a `}` without its `for` — is not a
// worse spec, it is a spec that cannot run at all (SyntaxError on load). The
// halves are insertable and deletable independently in the trainer, so the
// generator repairs rather than trusts: a stray endLoop becomes a comment, an
// unclosed loop is closed at the end, and the close is a plain `}` so the
// next parse restores the endLoop step instead of losing it.
//
// NAMES. Nested loops each need their own variable — a second `let i` inside
// the first is itself a SyntaxError — so the generator names by nesting depth
// (`i`, `i2`, …) and the parser accepts exactly that vocabulary and nothing
// else: a foreign for-loop is skipped whole, like a foreign `if`.

import { describe, expect, it } from "vitest";

import { generateSpec, generateSpecDetailed, describeStep } from "./script-generator.js";
import { parseSpec, parseSpecDetailed } from "./spec-parser.js";
import type { Step } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

const CLICK = () => step({ type: "click", locator: { k: "testid", v: "add" } });

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://x.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

/** Strip ids/timestamps so parsed steps compare on content. */
function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

describe("emission", () => {
  it("compiles a repeat block to a real for-loop around its body", () => {
    const src = gen([step({ type: "loop", loopCount: 3 }), CLICK(), step({ type: "endLoop" })]);
    expect(src).toContain("for (let i = 0; i < 3; i++) {");
    // The body is inside and indented one level deeper than the loop line.
    const lines = src.split("\n");
    const forAt = lines.findIndex((l) => l.includes("for (let i"));
    expect(lines[forAt + 1]).toMatch(/^ {4}await page\.getByTestId\("add"\)\.click\(\);/);
    expect(lines[forAt + 2]).toMatch(/^ {2}\}/);
  });

  it("names nested loops by depth so nothing shadows", () => {
    const src = gen([
      step({ type: "loop", loopCount: 2 }),
      step({ type: "loop", loopCount: 3 }),
      CLICK(),
      step({ type: "endLoop" }),
      step({ type: "endLoop" }),
    ]);
    expect(src).toContain("for (let i = 0; i < 2; i++) {");
    expect(src).toContain("for (let i2 = 0; i2 < 3; i2++) {");
  });

  it("clamps the count independently of the boundary", () => {
    // A forged count can arrive through updateStep's raw copy; the generator
    // guards on its own — the same doctrine as every numeral in the spec.
    const over = gen([step({ type: "loop", loopCount: 9999 }), step({ type: "endLoop" })]);
    expect(over).toContain("< 500;");
    const junk = gen([
      { id: "x", timestamp: 0, type: "loop", loopCount: "3); evil(); (" } as unknown as Step,
      step({ type: "endLoop" }),
    ]);
    expect(junk).toContain("< 1;");
    expect(junk).not.toContain("evil(");
  });

  it("turns a stray endLoop into a comment, never an unbalanced brace", () => {
    const src = gen([CLICK(), step({ type: "endLoop" })]);
    expect(src).toContain("// end repeat without an open loop");
    const opens = (src.match(/\{/g) ?? []).length;
    const closes = (src.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("closes an unclosed loop so the spec stays runnable, and the pair round-trips back", () => {
    const src = gen([step({ type: "loop", loopCount: 2 }), CLICK()]);
    const opens = (src.match(/\{/g) ?? []).length;
    const closes = (src.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
    // The repair is a plain `}`: the parser reads it back as endLoop, so the
    // next round-trip has BOTH halves again instead of losing the loop.
    expect(shape(parseSpec(src))).toEqual([
      { type: "loop", loopCount: 2 },
      { type: "click", locator: { k: "testid", v: "add" } },
      { type: "endLoop" },
    ]);
  });

  it("attributes the loop lines to their steps in the line map", () => {
    const steps = [step({ type: "loop", loopCount: 2 }), CLICK(), step({ type: "endLoop" })];
    const { source, lineMap } = generateSpecDetailed({
      name: "t",
      url: "https://x.test",
      steps,
    } as Parameters<typeof generateSpecDetailed>[0]);
    const lines = source.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
    expect(lineMap[at("for (let i")]).toBe(0);
    expect(lineMap[at(".click()")]).toBe(1);
  });

  it("describes the halves as words, not source", () => {
    expect(describeStep(step({ type: "loop", loopCount: 4 }))).toBe("repeat 4 times");
    expect(describeStep(step({ type: "endLoop" }))).toBe("end repeat");
  });
});

describe("round-trip", () => {
  it("reads its own emission back, nested and mixed with conditionals", () => {
    const steps = [
      step({ type: "loop", loopCount: 2 }),
      step({ type: "if", cond: "visible", locator: { k: "testid", v: "banner" } }),
      CLICK(),
      step({ type: "endif" }),
      step({ type: "loop", loopCount: 5 }),
      CLICK(),
      step({ type: "endLoop" }),
      step({ type: "endLoop" }),
    ];
    const parsed = parseSpec(gen(steps));
    expect(shape(parsed)).toEqual(shape(steps));
  });

  it("a `}` closes the block that opened it — endif for if, endLoop for for", () => {
    // The old parser held one counter, which cannot tell `if { for {` apart
    // from `for { if {`. The stack can, and this is the case that proves it.
    const steps = [
      step({ type: "if", cond: "visible", locator: { k: "testid", v: "x" } }),
      step({ type: "loop", loopCount: 2 }),
      CLICK(),
      step({ type: "endLoop" }),
      step({ type: "endif" }),
    ];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("never half-reads a foreign for-loop into a loop step", () => {
    // A `for (const row of rows)` is not the generator's vocabulary. The
    // parser's standing philosophy for foreign wrappers (a `while`, a
    // `.forEach`, custom helpers) is to pass over the unknown text and still
    // harvest the known calls inside — so the inner click parses as a flat
    // step, exactly as it did before loops existed. What this pins is the
    // half of the contract loops add: NO `loop`/`endLoop` step may appear,
    // because a half-read loop would regenerate as a repeat the original
    // never was.
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      "  for (const row of rows) {",
      '    await page.getByTestId("x").click();',
      "  }",
      '  await page.getByTestId("after").click();',
      "});",
    ].join("\n");
    const { steps } = parseSpecDetailed(src);
    expect(steps.every((s) => s.type !== "loop" && s.type !== "endLoop")).toBe(true);
    expect(shape(steps)).toEqual([
      { type: "click", locator: { k: "testid", v: "x" } },
      { type: "click", locator: { k: "testid", v: "after" } },
    ]);
  });

  it("skips a near-miss for-loop whole — right shape, wrong variables", () => {
    // The dangerous neighbour: `for (let i = 0; j < 3; i++)` LOOKS like ours.
    // Half-reading it into `loop 3×` would regenerate code the original never
    // was, so mismatched variables skip the entire block, inner calls
    // included, and count as skipped so `stepsDiverged` can say so.
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      "  for (let i = 0; j < 3; i++) {",
      '    await page.getByTestId("x").click();',
      "  }",
      '  await page.getByTestId("after").click();',
      "});",
    ].join("\n");
    const { steps, skipped } = parseSpecDetailed(src);
    expect(skipped).toBeGreaterThan(0);
    expect(shape(steps)).toEqual([{ type: "click", locator: { k: "testid", v: "after" } }]);
  });
});
