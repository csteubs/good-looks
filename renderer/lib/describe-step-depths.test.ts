// Indentation depths for block steps. The step list's nesting is the only
// visual statement of which steps a block contains, and loops joined the
// vocabulary on 2026-08-19 — a loop body rendering flat would read as steps
// that run once.

import { describe, expect, it } from "vitest";

import { computeStepDepths } from "./describe-step";
import type { StepType } from "./recorder-types";

const t = (types: StepType[]) => computeStepDepths(types.map((type) => ({ type })));

describe("computeStepDepths", () => {
  it("indents a loop body like a conditional body", () => {
    expect(t(["loop", "click", "endLoop", "click"])).toEqual([0, 1, 0, 0]);
  });

  it("nests loops and conditionals through each other", () => {
    expect(t(["if", "loop", "click", "endLoop", "endif"])).toEqual([0, 1, 2, 1, 0]);
    expect(t(["loop", "if", "click", "endif", "endLoop"])).toEqual([0, 1, 2, 1, 0]);
  });

  it("sits an else at its if's depth, with both bodies one deeper", () => {
    expect(t(["if", "click", "else", "click", "endif"])).toEqual([0, 1, 0, 1, 0]);
    expect(t(["loop", "if", "else", "click", "endif", "endLoop"])).toEqual([0, 1, 1, 2, 1, 0]);
  });

  it("nests group members like a block body", () => {
    expect(t(["group", "click", "endGroup", "click"])).toEqual([0, 1, 0, 0]);
    expect(t(["if", "group", "click", "endGroup", "endif"])).toEqual([0, 1, 2, 1, 0]);
  });

  it("floors at zero on a stray closer", () => {
    expect(t(["endLoop", "click"])).toEqual([0, 0]);
    expect(t(["else", "click"])).toEqual([0, 1]);
  });
});
