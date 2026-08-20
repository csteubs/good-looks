// The accessibility GATE step: emission, the generator-side impact allowlist,
// round-trips, and the gate's decision logic — including the parity pin that
// lets gateFailures inline its key spelling for embeddability (see the doc
// comment in shared/a11y-rollup.mjs).

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
import { glazeRuntimeSource } from "./glaze-runtime-source.js";
import { gateFailures, keysOf } from "../../shared/a11y-rollup.mjs";
import { normalizeRawStep } from "../recorder/types.js";
import type { Step } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://x.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

describe("emission", () => {
  it("emits one awaited helper call with the chosen impact", () => {
    const src = gen([step({ type: "a11y", a11yImpact: "critical" })]);
    expect(src).toContain('await glazeA11yGate(page, "critical");');
    expect(src).toContain(`import { glazeA11yGate } from "./glaze-runtime.mjs";`);
  });

  it("defaults the impact to serious", () => {
    const src = gen([step({ type: "a11y" })]);
    expect(src).toContain('await glazeA11yGate(page, "serious");');
  });

  it("imports the runtime only when a gate exists", () => {
    const src = gen([step({ type: "click", locator: { k: "testid", v: "x" } })]);
    expect(src).not.toContain("glazeA11yGate");
  });

  it("never interpolates a forged impact — the generator allowlists independently", () => {
    // A step already on disk can carry a forged string in this field
    // (updateStep copies without re-normalizing). The emitted literal must
    // come from OUR allowlist, not the step.
    const forged = step({ type: "a11y" });
    (forged as unknown as Record<string, unknown>).a11yImpact = '"); require("fs"); ("';
    const src = gen([forged]);
    expect(src).toContain('await glazeA11yGate(page, "serious");');
    expect(src).not.toContain("require(");
  });
});

describe("the boundary", () => {
  it("keeps only a real impact level", () => {
    expect(normalizeRawStep({ type: "a11y", a11yImpact: "moderate" })?.a11yImpact).toBe(
      "moderate",
    );
    expect(
      normalizeRawStep({ type: "a11y", a11yImpact: "catastrophic" })?.a11yImpact,
    ).toBeUndefined();
    expect(normalizeRawStep({ type: "a11y", a11yImpact: 7 })?.a11yImpact).toBeUndefined();
  });
});

describe("round-trip", () => {
  it("reads the gate back, at top level and inside blocks", () => {
    const steps = [
      step({ type: "a11y", a11yImpact: "minor" }),
      step({ type: "if", cond: "visible", locator: { k: "testid", v: "x" } }),
      step({ type: "a11y", a11yImpact: "serious" }),
      step({ type: "endif" }),
    ];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("round-trips disabled and continue-on-failure gates", () => {
    const steps = [
      step({ type: "a11y", a11yImpact: "critical", disabled: true }),
      step({ type: "a11y", a11yImpact: "moderate", continueOnFailure: true }),
    ];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("regeneration is a fixed point", () => {
    const steps = [step({ type: "a11y", a11yImpact: "serious" })];
    const once = gen(steps);
    expect(gen(parseSpec(once))).toBe(once);
  });

  it("counts a hand-written gate with a made-up level as skipped, not half-read", () => {
    const src = gen([step({ type: "a11y" })]).replace('"serious"', '"sorta-bad"');
    expect(parseSpec(src).some((s) => s.type === "a11y")).toBe(false);
  });
});

describe("gateFailures", () => {
  const V = (id: string, impact: string, nodes: string[]) => ({ id, impact, help: "h", nodes });

  it("fails only at or above the floor", () => {
    const vs = [V("a", "minor", ["x"]), V("b", "moderate", ["y"]), V("c", "critical", ["z"])];
    expect(gateFailures(vs, "moderate", []).map((f) => f.id)).toEqual(["b", "c"]);
    expect(gateFailures(vs, "critical", []).map((f) => f.id)).toEqual(["c"]);
    expect(gateFailures(vs, "minor", []).map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("defaults an unknown floor to serious rather than failing open", () => {
    const vs = [V("a", "moderate", ["x"]), V("b", "serious", ["y"])];
    expect(gateFailures(vs, "whatever", []).map((f) => f.id)).toEqual(["b"]);
  });

  it("drops accepted nodes and keeps only the fresh ones", () => {
    const vs = [V("contrast", "serious", ["#a", "#b"])];
    const partial = gateFailures(vs, "serious", ["contrast|#a"]);
    expect(partial).toHaveLength(1);
    expect(partial[0].nodes).toEqual(["#b"]);
    expect(gateFailures(vs, "serious", ["contrast|#a", "contrast|#b"])).toEqual([]);
  });

  it("treats a violation with no nodes as one page-level key", () => {
    const vs = [{ id: "lang", impact: "serious", help: "h", nodes: [] }];
    expect(gateFailures(vs, "serious", []).length).toBe(1);
    expect(gateFailures(vs, "serious", ["lang|"])).toEqual([]);
  });

  it("spells keys exactly as keysOf does — the embedded copy must not drift", () => {
    // gateFailures inlines the key so its source can be embedded into the
    // generated runtime. This is the pin that makes that inlining safe: every
    // key keysOf produces for a violation must be accepted by gateFailures.
    const v = { id: "aria-roles", impact: "critical", help: "h", nodes: ["#x > b", ""] };
    expect(gateFailures([v], "minor", keysOf(v))).toEqual([]);
  });

  it("is embedded in the generated runtime verbatim", () => {
    expect(glazeRuntimeSource).toContain(gateFailures.toString());
  });
});
