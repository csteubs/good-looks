// Count as a capture source: V.n = how many elements a locator matches. The
// count assert already existed for FIXED expectations; this is count as a
// VALUE — capture a list's size, act, assert the size moved — and the rule
// that carries it is non-strictness: counting an ambiguous or absent locator
// is the whole point, and 0 is an answer, not a failure.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { glazeRuntimeSource } from "./glaze-runtime-source.js";
import { parseSpec } from "./spec-parser.js";
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

describe("count capture", () => {
  it("emits the capture helper with the count source and imports the runtime", () => {
    const src = gen([
      step({
        type: "capture",
        captureVar: "results",
        captureFrom: "count",
        locator: { k: "css", v: "li.result" },
      }),
    ]);
    expect(src).toContain('await glazeCapture(V, "results", page.locator("li.result"), "count");');
    expect(src).toContain("glaze-runtime");
  });

  it("round-trips through the parser", () => {
    const steps = [
      step({
        type: "capture",
        captureVar: "results",
        captureFrom: "count",
        locator: { k: "css", v: "li.result" },
      }),
    ];
    const back = parseSpec(gen(steps));
    expect(back[0].captureFrom).toBe("count");
    expect(back[0].captureVar).toBe("results");
    expect(gen(parseSpec(gen(steps)))).toBe(gen(steps));
  });

  it("the runtime reads locator.count() and never strict-resolves", async () => {
    // Evaluate the EMITTED runtime source — the string the spec imports — so
    // this pins what runs, not a lookalike.
    const mod = await import(
      "data:text/javascript," + encodeURIComponent(glazeRuntimeSource)
    );
    const vars: Record<string, string> = {};
    const fakeLocator = { count: async () => 7 };
    await mod.glazeCapture(vars, "n", fakeLocator, "count");
    expect(vars.n).toBe("7");
    const empty = { count: async () => 0 };
    await mod.glazeCapture(vars, "none", empty, "count");
    expect(vars.none).toBe("0");
  });
});
