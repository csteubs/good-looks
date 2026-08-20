// The actionability escape. What matters: `force` reaches the spec only as
// the exact options literal, only when the stored value is the boolean true
// (a stored step predates the boundary knowing the field), and the whole
// thing round-trips — a force click that regenerated bare would silently
// reinstate the check the user turned off.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
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

describe("force clicks", () => {
  it("emits the options literal only when asked", () => {
    const forced = gen([step({ type: "click", locator: { k: "testid", v: "x" }, force: true })]);
    expect(forced).toContain('.click({ force: true });');
    const plain = gen([step({ type: "click", locator: { k: "testid", v: "x" } })]);
    expect(plain).toContain(".click();");
  });

  it("treats a forged truthy as absent — the generator wants the boolean", () => {
    const src = gen([
      { id: "s", timestamp: 0, type: "click", locator: { k: "testid", v: "x" }, force: "yes" } as unknown as Step,
    ]);
    expect(src).toContain(".click();");
    expect(src).not.toContain("force");
  });

  it("is dropped at the boundary unless it is literally true", () => {
    expect(
      normalizeRawStep({ type: "click", locator: { k: "testid", v: "x" }, force: "yes" })?.force,
    ).toBeUndefined();
    expect(
      normalizeRawStep({ type: "click", locator: { k: "testid", v: "x" }, force: true })?.force,
    ).toBe(true);
  });

  it("round-trips in both directions", () => {
    const steps = [step({ type: "click", locator: { k: "testid", v: "x" }, force: true })];
    const back = parseSpec(gen(steps));
    expect(back[0].force).toBe(true);
    expect(gen(parseSpec(gen(steps)))).toBe(gen(steps));
    // The unfixed direction: a foreign click option must not read as ours.
    const foreign = gen(steps).replace("{ force: true }", "{ timeout: 99 }");
    const reparsed = parseSpec(foreign);
    expect(reparsed[0]?.force).toBeUndefined();
  });
});
