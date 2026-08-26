import { describe, it, expect } from "vitest";

import {
  batchOutcome,
  batchOutcomeLabel,
  batchOutcomeTitle,
  batchOutcomeTone,
} from "./batch-outcome";

/** A summary with only the two counts the rule reads. */
const sum = (passed: number, failed: number) => ({ summary: { passed, failed } });

describe("batchOutcome", () => {
  it("is passed when nothing failed", () => {
    expect(batchOutcome(sum(3, 0))).toBe("passed");
  });

  it("is mixed when some failed AND some passed", () => {
    // The case this module exists for: 2 of 3 failed, 1 passed.
    expect(batchOutcome(sum(1, 2))).toBe("mixed");
  });

  it("is failed when something failed and NOTHING passed", () => {
    expect(batchOutcome(sum(0, 3))).toBe("failed");
  });

  it("separates one bad test from a suite that never ran", () => {
    // The whole point of the split — these two used to be the same colour, and
    // they are the difference between a broken test and a broken base URL.
    expect(batchOutcome(sum(9, 1))).not.toBe(batchOutcome(sum(0, 10)));
  });

  it("reports stopped ahead of any verdict, even when tests had already failed", () => {
    // A halted batch has no verdict: the tests after the stop never ran, so
    // both the tone and the word must decline to claim one.
    expect(batchOutcome({ stopped: true, summary: { passed: 1, failed: 2 } })).toBe("stopped");
    expect(batchOutcome({ stopped: true, summary: { passed: 3, failed: 0 } })).toBe("stopped");
  });

  it("ignores skipped tests entirely — they cannot make a batch mixed", () => {
    // A skipped test reported nothing. Were it counted as a non-pass, a clean
    // run with one skip would go amber and cry wolf on every filtered suite.
    expect(batchOutcome(sum(2, 0))).toBe("passed");
  });
});

describe("batchOutcomeTone", () => {
  it("gives mixed the amber the design reserves for caution", () => {
    expect(batchOutcomeTone("mixed")).toBe("amber");
  });

  it("keeps red for a total failure and phosphor for a clean one", () => {
    expect(batchOutcomeTone("failed")).toBe("red");
    expect(batchOutcomeTone("passed")).toBe("phos");
  });

  it("leaves a stopped batch untinted, because it is not a result", () => {
    expect(batchOutcomeTone("stopped")).toBeNull();
  });
});

describe("batchOutcomeTitle", () => {
  it("names all four states distinctly", () => {
    const titles = (["stopped", "passed", "mixed", "failed"] as const).map(batchOutcomeTitle);
    expect(new Set(titles).size).toBe(4);
  });

  it("does not call a partly-passing batch a failure outright", () => {
    expect(batchOutcomeTitle("mixed")).toBe("Routine finished with failures");
    expect(batchOutcomeTitle("failed")).toBe("Routine failed");
  });
});

describe("batchOutcomeLabel", () => {
  it("leads with the count that needs attention", () => {
    expect(batchOutcomeLabel(sum(1, 2))).toBe("2 failed");
    expect(batchOutcomeLabel(sum(0, 3))).toBe("3 failed");
  });

  it("reports the passes when there is nothing to answer for", () => {
    expect(batchOutcomeLabel(sum(3, 0))).toBe("3 passed");
  });

  it("says Stopped rather than a count", () => {
    expect(batchOutcomeLabel({ stopped: true, summary: { passed: 1, failed: 2 } })).toBe("Stopped");
  });

  it("stays two tokens, because the chip is fixed-width and CLIPS", () => {
    // The chip is `--gl-status-w` wide and does not grow: a longer label is not
    // a wider chip, it is a truncated one, and jsdom cannot see that (no layout
    // engine). Bounding the word count is the part that can be asserted here.
    for (const input of [sum(1, 2), sum(3, 0), sum(0, 3)]) {
      expect(batchOutcomeLabel(input).split(" ")).toHaveLength(2);
    }
  });
});
