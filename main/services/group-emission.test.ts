// Step groups: comment markers in the spec, sections in the list. The
// properties: markers can NEVER break a spec (they are comments through
// commentSafe, whatever the label holds), they round-trip — including
// through the comment-stripping preprocessor that eats every other comment —
// and a stray half is simply a marker, not a repair case.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
import type { Step } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

const GROUP = (label: string): Step => step({ type: "group", label });
const CLICK = (v = "x"): Step => step({ type: "click", locator: { k: "testid", v } });

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://x.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

describe("emission", () => {
  it("emits both halves as comments and leaves code indentation alone", () => {
    const src = gen([GROUP("Log in"), CLICK("email"), step({ type: "endGroup" })]);
    expect(src).toContain("// ── group: Log in ──");
    expect(src).toContain("// ── end group ──");
    // The click sits at the test body's own indent — group nesting is the
    // step LIST's rendering, never the spec's.
    expect(src).toContain('  await page.getByTestId("email").click();');
  });

  it("a hostile label cannot leave the comment", () => {
    const src = gen([GROUP("x\nrequire('fs')"), step({ type: "endGroup" })]);
    const lines = src.split("\n").filter((l) => l.includes("require"));
    expect(lines.every((l) => l.trim().startsWith("//"))).toBe(true);
  });

  it("a stray half is just a marker — nothing to repair", () => {
    const src = gen([step({ type: "endGroup" }), GROUP("orphan")]);
    expect(src).toContain("// ── end group ──");
    expect(src).toContain("// ── group: orphan ──");
  });
});

describe("round-trip", () => {
  it("survives the comment-stripping preprocessor that eats every other comment", () => {
    const steps = [GROUP("Checkout"), CLICK("pay"), step({ type: "endGroup" })];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("keeps a label containing the separator whole", () => {
    const steps = [GROUP("a ── b"), step({ type: "endGroup" })];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("nests through conditionals and loops", () => {
    const steps = [
      step({ type: "if", cond: "visible", locator: { k: "testid", v: "x" } }),
      GROUP("inner"),
      CLICK(),
      step({ type: "endGroup" }),
      step({ type: "endif" }),
    ];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("regeneration is a fixed point", () => {
    const once = gen([GROUP("G"), CLICK(), step({ type: "endGroup" })]);
    expect(gen(parseSpec(once))).toBe(once);
  });

  it("an ordinary comment is still eaten — only the markers round-trip", () => {
    const src = gen([CLICK()]).replace(
      "  await page",
      "  // a stray human comment\n  await page",
    );
    expect(parseSpec(src).map((s) => s.type)).toEqual(["click"]);
  });
});
