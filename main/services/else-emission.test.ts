// Else branches: the if block's second half. The properties that carry it are
// the same two the loop halves live by — BALANCE (an else emitted anywhere
// but directly inside an un-elsed if is a SyntaxError, so strays and doubles
// become comments) and ROUND-TRIP (a `} else {` reads back as the else of the
// if that owns it, at any nesting).

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
import type { Step } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

const IF = () => step({ type: "if", cond: "visible", locator: { k: "testid", v: "banner" } });
const CLICK = (v = "x") => step({ type: "click", locator: { k: "testid", v } });

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://x.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

function balanced(src: string): boolean {
  return (src.match(/\{/g) ?? []).length === (src.match(/\}/g) ?? []).length;
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

describe("emission", () => {
  it("splits the block at the if's own indent", () => {
    const src = gen([IF(), CLICK("then"), step({ type: "else" }), CLICK("other"), step({ type: "endif" })]);
    const lines = src.split("\n");
    const ifLine = lines.find((l) => l.trimStart().startsWith("if ("))!;
    const elseLine = lines.find((l) => l.includes("} else {"))!;
    expect(elseLine.match(/^ */)![0].length).toBe(ifLine.match(/^ */)![0].length);
    // Both bodies sit one level deeper.
    const thenLine = lines.find((l) => l.includes('"then"'))!;
    const otherLine = lines.find((l) => l.includes('"other"'))!;
    expect(thenLine.match(/^ */)![0].length).toBe(ifLine.match(/^ */)![0].length + 2);
    expect(otherLine.match(/^ */)![0].length).toBe(ifLine.match(/^ */)![0].length + 2);
    expect(balanced(src)).toBe(true);
  });

  it("comments a stray else instead of emitting an unbalanced brace", () => {
    const src = gen([CLICK(), step({ type: "else" })]);
    expect(src).toContain("// else without an open if — skipped");
    expect(src).not.toContain("} else {");
    expect(balanced(src)).toBe(true);
  });

  it("comments a second else in one if", () => {
    const src = gen([IF(), step({ type: "else" }), step({ type: "else" }), step({ type: "endif" })]);
    expect((src.match(/\} else \{/g) ?? []).length).toBe(1);
    expect(src).toContain("// second else in one if — skipped");
    expect(balanced(src)).toBe(true);
  });

  it("refuses an else whose innermost block is a loop", () => {
    // `for { } else {` is a SyntaxError; the else belongs to an if that isn't
    // the innermost open block, and guessing which one would silently change
    // what runs. A comment says so instead.
    const src = gen([IF(), step({ type: "loop", loopCount: 2 }), step({ type: "else" }), step({ type: "endLoop" }), step({ type: "endif" })]);
    expect(src).toContain("// else without an open if — skipped");
    expect(balanced(src)).toBe(true);
  });
});

describe("round-trip", () => {
  it("reads back plain, nested, and loop-carrying else blocks", () => {
    const steps = [
      IF(),
      CLICK("a"),
      step({ type: "else" }),
      step({ type: "loop", loopCount: 2 }),
      CLICK("b"),
      step({ type: "endLoop" }),
      step({ type: "if", cond: "hidden", locator: { k: "testid", v: "x" } }),
      CLICK("c"),
      step({ type: "endif" }),
      step({ type: "endif" }),
    ];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("attaches an inner if's else to the inner if", () => {
    const steps = [
      IF(),
      step({ type: "if", cond: "hidden", locator: { k: "testid", v: "y" } }),
      CLICK("inner-then"),
      step({ type: "else" }),
      CLICK("inner-else"),
      step({ type: "endif" }),
      step({ type: "endif" }),
    ];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("regeneration is a fixed point", () => {
    const steps = [IF(), CLICK("a"), step({ type: "else" }), CLICK("b"), step({ type: "endif" })];
    const once = gen(steps);
    expect(gen(parseSpec(once))).toBe(once);
  });

  it("never reads a foreign if's else as one of ours", () => {
    // A hand-written `if (helper()) { … } else { … }`: the foreign condition
    // is skipped whole (standing philosophy — the then-branch goes with it,
    // counted), and the bare `else {` that follows matches no recognizer, so
    // its body's known calls are harvested flat. What must NOT happen is an
    // `else` step with no if to belong to — that is the parser guard's job.
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      '  await page.goto("https://x.test/");',
      "  if (someForeignHelper()) {",
      '    await page.getByTestId("a").click();',
      "  } else {",
      '    await page.getByTestId("b").click();',
      "  }",
      "});",
      "",
    ].join("\n");
    const parsed = parseSpec(src);
    expect(parsed.some((p) => p.type === "else" || p.type === "if" || p.type === "endif")).toBe(false);
    expect(parsed.map((p) => p.type)).toEqual(["goto", "click"]);
  });

  it("refuses a `} else {` whose open block is a loop", () => {
    // Invalid JS, but the parser accepts arbitrary text and must not half-read
    // it: the closer pops the loop as usual and the bare else is skipped, so
    // no else step lands inside a block that cannot own one.
    const src = [
      'import { test } from "@playwright/test";',
      'test("t", async ({ page }) => {',
      "  for (let i = 0; i < 2; i++) {",
      '    await page.getByTestId("a").click();',
      "  } else {",
      '    await page.getByTestId("b").click();',
      "  }",
      "});",
    ].join("\n");
    const types = parseSpec(src).map((p) => p.type);
    expect(types).not.toContain("else");
    expect(types.slice(0, 3)).toEqual(["loop", "click", "endLoop"]);
  });

  it("survives a stray top-level `} else {` without throwing", () => {
    // With nothing open, the guard's `top` is undefined — the recognizer must
    // decline rather than dereference it.
    const src = [
      'import { test } from "@playwright/test";',
      'test("t", async ({ page }) => {',
      "  } else {",
      '  await page.getByTestId("a").click();',
      "});",
    ].join("\n");
    expect(() => parseSpec(src)).not.toThrow();
    expect(parseSpec(src).map((p) => p.type)).not.toContain("else");
  });
});
