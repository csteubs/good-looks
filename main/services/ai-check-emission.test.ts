// AI visual checks: the emitted helper line and its ordinal numbering, the
// round-trip, and the post-run evaluator — including the PAIRING rule, which
// is two counters over one list (the generator numbers screenshots, the
// evaluator pairs them back) and is pinned against itself here.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
import { evaluateAiChecks } from "./ai-check.js";
import { visionVerdict } from "./llm-service.js";
import type { Step } from "../recorder/types.js";

vi.mock("./llm-service.js", () => ({ visionVerdict: vi.fn() }));
const verdictMock = vi.mocked(visionVerdict);

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

const CHECK = (text: string, extra: Partial<Step> = {}): Step =>
  step({ type: "aiCheck", text, ...extra });

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://x.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

afterEach(() => {
  verdictMock.mockReset();
});

describe("emission", () => {
  it("numbers checks 1..N in order, skipping disabled ones", () => {
    const src = gen([CHECK("first"), CHECK("skipped", { disabled: true }), CHECK("third")]);
    expect(src).toContain('await glazeAiCheck(page, "first", 1);');
    expect(src).toContain('await glazeAiCheck(page, "third", 2);');
    expect(src).toContain("// disabled — skipped:");
    expect(src).toContain('import { glazeAiCheck } from "./glaze-runtime.mjs";');
  });

  it("q()s the claim — an injection-shaped claim stays a string", () => {
    const src = gen([CHECK('"); require("fs"); ("')]);
    expect(src).toContain('await glazeAiCheck(page, "\\"); require(\\"fs\\"); (\\"", 1);');
  });

  it("imports nothing when no check exists", () => {
    const src = gen([step({ type: "click", locator: { k: "testid", v: "x" } })]);
    expect(src).not.toContain("glazeAiCheck");
  });
});

describe("round-trip", () => {
  it("reads the claim back, ordinal re-derived", () => {
    const steps = [CHECK("cart badge shows 3"), CHECK("banner is gone")];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("regeneration is a fixed point", () => {
    const once = gen([CHECK("a"), CHECK("b")]);
    expect(gen(parseSpec(once))).toBe(once);
  });

  it("round-trips a disabled check", () => {
    const steps = [CHECK("a", { disabled: true })];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });
});

describe("the evaluator", () => {
  function dirWithShots(ns: number[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-ai-"));
    for (const n of ns) fs.writeFileSync(path.join(dir, `ai-check-${n}.png`), "png");
    return dir;
  }
  const noEmit = () => {};

  it("pairs screenshots by the generator's numbering — disabled checks skip", async () => {
    // The generator numbered "first"→1 and "third"→2 above; the evaluator
    // must count the SAME way over the same list, or verdicts attach to the
    // wrong claims.
    verdictMock.mockResolvedValueOnce({ pass: true, reason: "ok" });
    verdictMock.mockResolvedValueOnce({ pass: false, reason: "no badge" });
    const dir = dirWithShots([1, 2]);
    const results = await evaluateAiChecks({
      steps: [CHECK("first"), CHECK("skipped", { disabled: true }), CHECK("third")],
      dir,
      emit: noEmit,
    });
    expect(results.map((r) => [r.claim, r.verdict])).toEqual([
      ["first", "pass"],
      ["third", "fail"],
    ]);
    expect(results.map((r) => r.stepIndex)).toEqual([0, 2]);
  });

  it("records a missing screenshot as unevaluated with a pointer, not a fail", async () => {
    const dir = dirWithShots([]);
    const results = await evaluateAiChecks({ steps: [CHECK("a")], dir, emit: noEmit });
    expect(results[0].verdict).toBe("unevaluated");
    expect(results[0].reason).toMatch(/no screenshot/i);
    expect(verdictMock).not.toHaveBeenCalled();
  });

  it("stops calling a dead provider after two consecutive failures", async () => {
    verdictMock.mockRejectedValue(new Error("Could not reach Claude."));
    const dir = dirWithShots([1, 2, 3, 4]);
    const results = await evaluateAiChecks({
      steps: [CHECK("a"), CHECK("b"), CHECK("c"), CHECK("d")],
      dir,
      emit: noEmit,
    });
    expect(results.every((r) => r.verdict === "unevaluated")).toBe(true);
    expect(results.every((r) => /could not reach/i.test(r.reason))).toBe(true);
    // a + b called; c and d inherit the reason without another round trip.
    expect(verdictMock).toHaveBeenCalledTimes(2);
  });

  it("says the summary and each non-pass out loud", async () => {
    verdictMock.mockResolvedValueOnce({ pass: true, reason: "ok" });
    verdictMock.mockResolvedValueOnce({ pass: false, reason: "badge shows 2" });
    const dir = dirWithShots([1, 2]);
    const lines: string[] = [];
    await evaluateAiChecks({
      steps: [CHECK("a"), CHECK("badge shows 3")],
      dir,
      emit: (l) => lines.push(l),
    });
    const all = lines.join("");
    expect(all).toMatch(/AI checks: 1 passed, 1 FAILED/);
    expect(all).toMatch(/badge shows 3.*badge shows 2/);
  });
});
