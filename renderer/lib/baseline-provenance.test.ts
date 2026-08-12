// What a pinned baseline is. REDESIGN §6.6.
//
// The line this builds is the whole feature, so the tests assert the SENTENCE
// rather than walking spans — a test that checked the DOM would pass on a line
// that read correctly to a parser and wrongly to a person.
//
// Two things here would be quietly wrong. A baseline whose run retention has
// pruned must not read like one from an unknown engine, and it must not silently
// lose the field either. And the age has to be relative, because "2026-04-14" is
// a subtraction the reader will not do.

import { describe, expect, it } from "vitest";

import type { BaselineEntry, RunRecord } from "./recorder-types";
import {
  STALE_BASELINE_DAYS,
  ageLabel,
  baselineProvenance,
  isStale,
  provenanceLine,
} from "./baseline-provenance";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function entry(over: Partial<BaselineEntry> = {}): BaselineEntry {
  return { stepId: "s1", runId: "r1", at: NOW, label: "goto", ...over };
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    testId: "t1",
    testName: "Checkout",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: NOW,
    finishedAt: NOW + 1,
    durationMs: 1,
    logFile: "/x.log",
    logBytes: 1,
    ...over,
  };
}

describe("what it can say", () => {
  it("names the engine of the run the baseline came from", () => {
    const p = baselineProvenance(entry(), [run({ runBrowser: "webkit" })], NOW);
    expect(p.browser).toBe("webkit");
    expect(provenanceLine(p)).toBe("Pinned today · webkit");
  });

  it("reads an absent engine on an EXISTING run as chromium", () => {
    // Every run predating the browser picker really did use it — that is
    // history, not a default being chosen.
    expect(baselineProvenance(entry(), [run({})], NOW).browser).toBe("chromium");
  });

  it("says the run is gone rather than dropping the field", () => {
    // Retention prunes run history; a baseline outlives it. A provenance line
    // missing a field reads as a rendering bug, and "the run this came from is
    // gone" is information rather than an absence of it.
    const p = baselineProvenance(entry(), [], NOW);
    expect(p.run).toBeNull();
    expect(p.browser).toBeNull();
    expect(provenanceLine(p)).toBe("Pinned today · run since pruned");
  });

  it("never reports a pruned run's engine as chromium", () => {
    // The two cases must not read alike: for a run that exists, absent means
    // chromium; for a run that is gone, we know nothing at all.
    expect(baselineProvenance(entry(), [], NOW).browser).not.toBe("chromium");
  });

  it("marks a headless run and an element-scoped baseline", () => {
    const p = baselineProvenance(
      entry({ rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }),
      [run({ runHeadless: true })],
      NOW,
    );
    expect(provenanceLine(p)).toBe("Pinned today · chromium · headless · element only");
  });
});

describe("age", () => {
  it("is relative, because a date is a subtraction nobody does", () => {
    expect(ageLabel(0)).toBe("today");
    expect(ageLabel(1)).toBe("yesterday");
    expect(ageLabel(12)).toBe("12 days ago");
  });

  it("counts whole days from the pin", () => {
    expect(baselineProvenance(entry({ at: NOW - 3 * DAY }), [run()], NOW).ageDays).toBe(3);
    // Part of a day is not a day.
    expect(baselineProvenance(entry({ at: NOW - DAY / 2 }), [run()], NOW).ageDays).toBe(0);
  });

  it("never reports a negative age from a clock that moved", () => {
    expect(baselineProvenance(entry({ at: NOW + 5 * DAY }), [run()], NOW).ageDays).toBe(0);
  });

  it("calls a month-old baseline stale — a prompt, not a verdict", () => {
    // Nothing is wrong with an old baseline; a stable page should have one. It
    // is flagged because "pinned 4 months ago" is the most useful thing to
    // notice when a diff appears and nobody changed the page.
    const old = baselineProvenance(entry({ at: NOW - STALE_BASELINE_DAYS * DAY }), [run()], NOW);
    const fresh = baselineProvenance(entry({ at: NOW - DAY }), [run()], NOW);
    expect(isStale(old)).toBe(true);
    expect(isStale(fresh)).toBe(false);
  });
});
