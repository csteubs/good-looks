// The decision behind the Batch view's "At once" picker and its headed warning.
//
// Tested here rather than through the view because the SDK's Select is
// native-menu-backed — its options never enter the DOM, so the picker cannot be
// driven in jsdom (CLAUDE.md). If this logic lived in the component, the only
// way to reach it would be the one control a test can't touch.

import { describe, expect, it } from "vitest";

import { HEADED_PARALLEL_WARN, MAX_BATCH_CONCURRENCY } from "./recorder-types";
import {
  BATCH_CONCURRENCY_CHOICES,
  batchConcurrencyLabel,
  choiceFromSetting,
  needsHeadedParallelWarning,
  resolveConcurrency,
  settingFromChoice,
} from "./batch-parallel";

describe("resolveConcurrency", () => {
  it("treats the default as one at a time", () => {
    expect(resolveConcurrency(1, 20)).toBe(1);
  });

  it("uses the picked number when there are enough tests for it", () => {
    expect(resolveConcurrency(4, 20)).toBe(4);
  });

  // The number the user is warned about has to be the number that runs, and the
  // backend clamps to the distinct-test count regardless.
  it("never exceeds the number of tests selected", () => {
    expect(resolveConcurrency(8, 3)).toBe(3);
    expect(resolveConcurrency("all", 3)).toBe(3);
  });

  it("caps 'all at once' at the hard ceiling", () => {
    expect(resolveConcurrency("all", 500)).toBe(MAX_BATCH_CONCURRENCY);
  });

  it("falls back to one at a time for an empty selection", () => {
    expect(resolveConcurrency("all", 0)).toBe(1);
    expect(resolveConcurrency(8, 0)).toBe(1);
  });
});

describe("needsHeadedParallelWarning", () => {
  // The whole point of the threshold: headless runs open nothing, so however
  // many there are, there is nothing to warn about.
  it("never warns for a headless batch, however wide", () => {
    expect(
      needsHeadedParallelWarning({ concurrency: MAX_BATCH_CONCURRENCY, runHeadless: true }),
    ).toBe(false);
  });

  it("does not warn at exactly the threshold", () => {
    expect(
      needsHeadedParallelWarning({ concurrency: HEADED_PARALLEL_WARN, runHeadless: false }),
    ).toBe(false);
  });

  it("warns one past the threshold", () => {
    expect(
      needsHeadedParallelWarning({ concurrency: HEADED_PARALLEL_WARN + 1, runHeadless: false }),
    ).toBe(true);
  });

  it("does not warn for a sequential headed batch", () => {
    expect(needsHeadedParallelWarning({ concurrency: 1, runHeadless: false })).toBe(false);
  });

  // A big SELECTION run a few at a time is the safe case, and nagging about it
  // would train people to click through the dialog that matters.
  it("does not warn for many tests run only a few at a time", () => {
    expect(
      needsHeadedParallelWarning({
        concurrency: resolveConcurrency(4, 40),
        runHeadless: false,
      }),
    ).toBe(false);
  });

  it("warns when 'all at once' really does mean more than ten windows", () => {
    expect(
      needsHeadedParallelWarning({
        concurrency: resolveConcurrency("all", 14),
        runHeadless: false,
      }),
    ).toBe(true);
  });
});

describe("choiceFromSetting / settingFromChoice", () => {
  it("round-trips every offered choice", () => {
    for (const choice of BATCH_CONCURRENCY_CHOICES) {
      expect(choiceFromSetting(settingFromChoice(choice))).toBe(choice);
    }
  });

  it("reads a missing or nonsense stored value as off", () => {
    expect(choiceFromSetting(undefined)).toBe(1);
    expect(choiceFromSetting(Number.NaN)).toBe(1);
    expect(choiceFromSetting(0)).toBe(1);
    expect(choiceFromSetting(-4)).toBe(1);
  });

  // A Select whose value isn't one of its own items renders blank, which reads
  // as "no default set" while a default is very much set.
  it("snaps a hand-edited value DOWN to an offered option", () => {
    expect(choiceFromSetting(3)).toBe(2);
    expect(choiceFromSetting(7)).toBe(4);
    expect(choiceFromSetting(15)).toBe(8);
    expect(BATCH_CONCURRENCY_CHOICES).toContain(choiceFromSetting(3));
  });

  it("reads anything at or above the ceiling as 'all'", () => {
    expect(choiceFromSetting(MAX_BATCH_CONCURRENCY)).toBe("all");
    expect(choiceFromSetting(999)).toBe("all");
  });
});

describe("batchConcurrencyLabel", () => {
  it("calls one-at-a-time 'Off' rather than '1 at once'", () => {
    expect(batchConcurrencyLabel(1)).toBe("Off");
    expect(batchConcurrencyLabel(4)).toBe("4 at once");
    expect(batchConcurrencyLabel("all")).toBe("All at once");
  });

  it("labels every offered choice distinctly", () => {
    const labels = BATCH_CONCURRENCY_CHOICES.map(batchConcurrencyLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
