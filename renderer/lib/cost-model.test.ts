// The cost model. REDESIGN §6.4.
//
// Every figure this panel shows is derived from two assumptions the user can
// see and edit, so the arithmetic is the feature. What would be silent if wrong:
// a spend that quietly excludes failed runs (flattering), value counted for runs
// that failed (dishonest), a flake definition that disagrees with the one the
// retry panel already shows, or an assumption input that turns the whole panel
// into NaN because someone cleared the field.

import { describe, expect, it } from "vitest";

import type { RunRecord } from "./recorder-types";
import {
  COST_DEFAULTS,
  MIN_RUNS_FOR_NEVER_CAUGHT,
  coerceAssumption,
  computeCost,
  flakeRuns,
  formatHours,
  formatMinutes,
  formatSpend,
  reviewReason,
} from "./cost-model";

const MIN = 60_000;

function run(over: Partial<RunRecord> & { id: string; startedAt: number }): RunRecord {
  return {
    testId: "t1",
    testName: "Checkout",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    finishedAt: over.startedAt + MIN,
    durationMs: MIN,
    logFile: "/x.log",
    logBytes: 1,
    ...over,
  };
}

const A = { costPerCiMinute: 1, minutesPerManualRun: 60 };

describe("the assumptions", () => {
  it("ships conservative defaults, so the panel is a floor not a boast", () => {
    expect(COST_DEFAULTS.costPerCiMinute).toBeGreaterThan(0);
    expect(COST_DEFAULTS.minutesPerManualRun).toBeGreaterThan(0);
  });

  it("survives a cleared field rather than turning every figure into NaN", () => {
    // `Number("")` is 0 and `Number("abc")` is NaN. Either renders as a
    // confident "0.00" or "NaN" instead of as a mistake.
    expect(coerceAssumption("costPerCiMinute", "")).toBe(COST_DEFAULTS.costPerCiMinute);
    expect(coerceAssumption("costPerCiMinute", "abc")).toBe(COST_DEFAULTS.costPerCiMinute);
    expect(coerceAssumption("minutesPerManualRun", "  ")).toBe(COST_DEFAULTS.minutesPerManualRun);
  });

  it("clamps rather than accepting a number that would dwarf every figure", () => {
    expect(coerceAssumption("costPerCiMinute", "-5")).toBe(0);
    expect(coerceAssumption("costPerCiMinute", "1e9")).toBe(100);
    expect(coerceAssumption("minutesPerManualRun", "0")).toBe(0.5);
  });

  it("takes a legitimate edit through unchanged", () => {
    expect(coerceAssumption("costPerCiMinute", "0.016")).toBe(0.016);
    expect(coerceAssumption("minutesPerManualRun", "25")).toBe(25);
  });
});

describe("computeCost", () => {
  it("charges for FAILED runs too", () => {
    // CI bills for them. A spend figure that quietly excluded them would be the
    // flattering kind, which is exactly what this panel must not be.
    const runs = [
      run({ id: "r1", startedAt: 1 }),
      run({ id: "r2", startedAt: 2, status: "failed", exitCode: 1 }),
    ];
    expect(computeCost(runs, A).ciMinutes).toBe(2);
    expect(computeCost(runs, A).spend).toBe(2);
  });

  it("credits manual time only for runs that PASSED", () => {
    // A failed run did not verify the flow, so it stands in for nothing.
    const runs = [
      run({ id: "r1", startedAt: 1 }),
      run({ id: "r2", startedAt: 2, status: "failed", exitCode: 1 }),
    ];
    expect(computeCost(runs, A).manualHoursAvoided).toBe(1);
  });

  it("reports no ratio at all when nothing has been spent", () => {
    // A ratio over zero is not "infinite value", it is no measurement.
    expect(computeCost([], A).hoursPerUnitSpent).toBeNull();
  });

  it("excludes baseline-update rows and tombstoned runs", () => {
    const runs = [
      run({ id: "r1", startedAt: 1 }),
      run({ id: "b1", startedAt: 2, kind: "baseline-update" }),
      run({ id: "d1", startedAt: 3, testDeleted: true }),
    ];
    expect(computeCost(runs, A).runs).toBe(1);
  });

  it("names a test by its most recent record, so a rename is not two rows", () => {
    const runs = [
      run({ id: "r1", startedAt: 1, testName: "Old name" }),
      run({ id: "r2", startedAt: 2, testName: "New name" }),
    ];
    const { byTest } = computeCost(runs, A);
    expect(byTest).toHaveLength(1);
    expect(byTest[0].testName).toBe("New name");
  });

  it("sorts the table by spend, because that is the question it answers", () => {
    const runs = [
      run({ id: "a", startedAt: 1, testId: "cheap", testName: "Cheap", durationMs: MIN }),
      run({ id: "b", startedAt: 2, testId: "dear", testName: "Dear", durationMs: 9 * MIN }),
    ];
    expect(computeCost(runs, A).byTest.map((t) => t.testId)).toEqual(["dear", "cheap"]);
  });
});

describe("flake, defined once", () => {
  const failThenPass = [
    run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 }),
    run({ id: "r2", startedAt: 2 }),
  ];

  it("counts a failure directly followed by a pass with nothing changed", () => {
    // The same rule §6.1's retry panel already shows. Two definitions of flake
    // in one app is how two surfaces end up disagreeing in front of a user.
    expect([...flakeRuns(failThenPass)]).toEqual(["r1"]);
  });

  it("does NOT count it when a run setting changed in between", () => {
    const fixed = [
      run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1, runBrowser: "webkit" }),
      run({ id: "r2", startedAt: 2, runBrowser: "chromium" }),
    ];
    expect(flakeRuns(fixed).size).toBe(0);
  });

  it("does not count a failure nobody followed up", () => {
    const stillFailing = [run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 })];
    expect(flakeRuns(stillFailing).size).toBe(0);
  });

  it("bills the flake back at the same rate as everything else", () => {
    const c = computeCost(failThenPass, A);
    expect(c.flakeRuns).toBe(1);
    expect(c.flakeMinutes).toBe(1);
    expect(c.flakeSpend).toBe(1);
  });

  it("never counts a run from one test against another", () => {
    // Interleaved by time, which is how a batch writes them.
    const runs = [
      run({ id: "a1", startedAt: 1, testId: "A", status: "failed", exitCode: 1 }),
      run({ id: "b1", startedAt: 2, testId: "B" }),
    ];
    expect(computeCost(runs, A).flakeRuns).toBe(0);
  });
});

describe("the verdict", () => {
  it("calls out a test whose failures are mostly flake", () => {
    expect(reviewReason({ runs: 20, failures: 4, flakeRuns: 3 })).toBe("flaky");
  });

  it("does not call one flaky failure a pattern", () => {
    // A ratio over a single sample is not a ratio.
    expect(reviewReason({ runs: 20, failures: 1, flakeRuns: 1 })).toBeNull();
  });

  it("calls out a test that has run a lot and never failed", () => {
    expect(reviewReason({ runs: MIN_RUNS_FOR_NEVER_CAUGHT, failures: 0, flakeRuns: 0 })).toBe(
      "never-caught",
    );
  });

  it("says nothing about a young test that has never failed", () => {
    // Below the threshold that is a fact about the sample, not the test.
    expect(reviewReason({ runs: 3, failures: 0, flakeRuns: 0 })).toBeNull();
  });

  it("reports the fixable half first when a test is both", () => {
    expect(reviewReason({ runs: 30, failures: 3, flakeRuns: 3 })).toBe("flaky");
  });

  it("leaves an ordinary test alone — review is the minority verdict", () => {
    expect(reviewReason({ runs: 20, failures: 5, flakeRuns: 0 })).toBeNull();
    const runs = [
      run({ id: "r1", startedAt: 1 }),
      run({ id: "r2", startedAt: 2, status: "failed", exitCode: 1 }),
      run({ id: "r3", startedAt: 3, runBrowser: "firefox" }),
    ];
    expect(computeCost(runs, A).byTest[0].verdict).toBe("earning");
  });
});

describe("formatting", () => {
  it("never prints a currency symbol", () => {
    // The rate is whatever the user typed, in whatever currency they think in.
    // This app is never told which, and stamping a symbol on it would assert
    // something it does not know.
    expect(formatSpend(12.5)).not.toMatch(/[$£€]/);
    expect(formatSpend(12.5)).toBe("12.50");
  });

  it("says <0.01 rather than rounding a real cost to nothing", () => {
    expect(formatSpend(0.004)).toBe("<0.01");
    expect(formatSpend(0)).toBe("0.00");
  });

  it("keeps a decimal on short CI times, so the column is not all zeroes", () => {
    // A suite of ten-second tests rounded to whole minutes renders as a column
    // of zeroes, which reads as "this measured nothing" rather than "fast".
    expect(formatMinutes(0.17)).toBe("0.2");
    expect(formatMinutes(0.01)).toBe("<0.1");
    expect(formatMinutes(0)).toBe("0");
    expect(formatMinutes(43.6)).toBe("44");
  });

  it("drops to minutes under an hour and to whole hours past ten", () => {
    expect(formatHours(0.5)).toBe("30m");
    expect(formatHours(2.25)).toBe("2.3h");
    expect(formatHours(41.4)).toBe("41h");
  });
});
