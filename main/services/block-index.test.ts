// The replay cursor's jump table for elsed conditionals. Which index these
// scans return decides which HALF of an if the recorder replays — an
// off-by-one lands the cursor inside the wrong branch and the session then
// executes the steps the condition said to skip.

import { describe, expect, it } from "vitest";

import { matchingBlockIndex, matchingElseIndex } from "./recorder-service.js";
import type { Step } from "../recorder/types.js";

const s = (types: string[]): Step[] =>
  types.map((type, i) => ({ id: `s${i}`, type, timestamp: 0 }) as Step);

describe("matchingElseIndex", () => {
  it("finds the else of a plain if", () => {
    expect(matchingElseIndex(s(["if", "click", "else", "click", "endif"]), 0)).toBe(2);
  });

  it("returns -1 when the if has no else", () => {
    expect(matchingElseIndex(s(["if", "click", "endif"]), 0)).toBe(-1);
  });

  it("does not read an inner if's else as the outer one's", () => {
    const steps = s(["if", "if", "else", "endif", "else", "endif"]);
    expect(matchingElseIndex(steps, 0)).toBe(4);
    expect(matchingElseIndex(steps, 1)).toBe(2);
  });

  it("stops at the if's own endif — a later sibling's else is out of reach", () => {
    const steps = s(["if", "endif", "if", "else", "endif"]);
    expect(matchingElseIndex(steps, 0)).toBe(-1);
  });

  it("answers only from an if", () => {
    expect(matchingElseIndex(s(["click", "else"]), 0)).toBe(-1);
  });
});

describe("matchingBlockIndex from an else", () => {
  it("returns the owning if's endif", () => {
    expect(matchingBlockIndex(s(["if", "else", "click", "endif"]), 1)).toBe(3);
  });

  it("skips a whole nested if while scanning", () => {
    expect(matchingBlockIndex(s(["if", "else", "if", "else", "endif", "endif"]), 1)).toBe(5);
  });
});
