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
  assumptionsFromSettings,
  computeCost,
  flakeRuns,
  formatHours,
  formatMinutes,
  formatRate,
  formatSpend,
  reviewReason,
} from "./cost-model";
import {
  CI_RUNNER_PRESETS,
  COST_CURRENCIES,
  clampCostPerCiMinute,
  clampMinutesPerManualRun,
  currencySymbol,
  rateForRunner,
  runnerForRate,
} from "../../shared/cost-units.mjs";

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

  it("survives a missing or corrupt setting rather than turning every figure into NaN", () => {
    // Both now arrive from a settings object, which can be empty (the query
    // has not resolved) or hand-edited on disk. A NaN renders as a confident
    // "$NaN" and a null as "$0.00" — neither reads as a mistake.
    expect(assumptionsFromSettings({})).toEqual(COST_DEFAULTS);
    expect(
      assumptionsFromSettings({ costPerCiMinute: NaN, costMinutesPerManualRun: NaN }),
    ).toEqual(COST_DEFAULTS);
    expect(
      assumptionsFromSettings({
        costPerCiMinute: undefined as unknown as number,
        costMinutesPerManualRun: undefined as unknown as number,
      }),
    ).toEqual(COST_DEFAULTS);
  });

  it("clamps rather than accepting a number that would dwarf every figure", () => {
    expect(clampCostPerCiMinute(-5)).toBe(0);
    expect(clampCostPerCiMinute(1e9)).toBe(100);
    expect(clampMinutesPerManualRun(0)).toBe(0.5);
    expect(clampMinutesPerManualRun(1e9)).toBe(480);
  });

  it("takes a legitimate value through unchanged, decimals and all", () => {
    // The rounding the other settings clamps do would destroy this one: 0.008
    // is a real CI price and `Math.round` makes it free.
    expect(clampCostPerCiMinute(0.016)).toBe(0.016);
    expect(clampCostPerCiMinute(0.008)).toBe(0.008);
    expect(clampMinutesPerManualRun(25)).toBe(25);
    expect(assumptionsFromSettings({ costPerCiMinute: 0.062 }).costPerCiMinute).toBe(0.062);
  });

  it("keeps a price of zero, because a self-hosted runner is free", () => {
    // The `Number(raw) || fallback` idiom every other settings clamp uses would
    // silently replace this with the app's 0.008 guess.
    expect(clampCostPerCiMinute(0)).toBe(0);
    expect(assumptionsFromSettings({ costPerCiMinute: 0 }).costPerCiMinute).toBe(0);
  });
});

describe("the runner presets", () => {
  it("round-trips every published rate back to the runner that has it", () => {
    // The pane DERIVES the selected runner from the stored price rather than
    // storing it, so a preset that does not come back out is a pane that reads
    // "Custom" over a price it just wrote.
    for (const preset of CI_RUNNER_PRESETS) {
      if (preset.rate === null) continue;
      expect(runnerForRate(preset.rate), preset.id).toBe(preset.id);
      expect(rateForRunner(preset.id)).toBe(preset.rate);
    }
  });

  it("reports the app's own shipped guess as Custom", () => {
    // 0.008 deliberately matches no published runner — see COST_DEFAULTS.
    expect(runnerForRate(COST_DEFAULTS.costPerCiMinute)).toBe("custom");
    expect(runnerForRate(0.0071)).toBe("custom");
    expect(runnerForRate(NaN)).toBe("custom");
    expect(runnerForRate(undefined)).toBe("custom");
  });

  it("gives every published rate a distinct runner", () => {
    // `runnerForRate` can only be unambiguous while this holds. A second runner
    // priced at 0.006 would make the dropdown report the wrong hardware.
    const rates = CI_RUNNER_PRESETS.map((p) => p.rate).filter((r) => r !== null);
    expect(new Set(rates).size).toBe(rates.length);
  });

  it("survives a price the number input's own stepper produced", () => {
    // These are not invented: the price field steps by 0.001, and repeatedly
    // stepping up lands on 0.010000000000000002 and 0.06200000000000005 rather
    // than on the published rates. Under a strict `===` the dropdown would read
    // "Custom" over a price the user reached with its own spinner.
    let stepped = 0;
    const steps: number[] = [];
    for (let i = 0; i < 62; i++) {
      stepped += 0.001;
      steps.push(stepped);
    }
    const windowsRate = steps.filter((n) => Math.abs(n - 0.01) < 1e-9)[0];
    const macRate = steps.filter((n) => Math.abs(n - 0.062) < 1e-9)[0];
    expect(windowsRate).not.toBe(0.01);
    expect(macRate).not.toBe(0.062);
    expect(runnerForRate(windowsRate)).toBe("windows-2");
    expect(runnerForRate(macRate)).toBe("macos-3-4");
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
  it("prints the symbol of the currency the user picked", () => {
    expect(formatSpend(12.5, "usd")).toBe("$12.50");
    expect(formatSpend(12.5, "eur")).toBe("€12.50");
    expect(formatSpend(12.5, "gbp")).toBe("£12.50");
  });

  it("keeps the three dollar currencies apart", () => {
    // The app never converts, so all three rendering as a bare "$" would let a
    // US figure be read as a Canadian one with nothing on screen to catch it.
    expect(formatSpend(12.5, "cad")).toBe("CA$12.50");
    expect(formatSpend(12.5, "aud")).toBe("A$12.50");
    expect(formatSpend(12.5, "usd")).toBe("$12.50");
  });

  it("prints no symbol at all under `none`", () => {
    // The original contract, still reachable: the panel claims nothing about
    // currency for a user whose currency is not on the list.
    expect(formatSpend(12.5, "none")).not.toMatch(/[$£€¥]/);
    expect(formatSpend(12.5, "none")).toBe("12.50");
    expect(formatSpend(0.004, "none")).toBe("<0.01");
    expect(currencySymbol("none")).toBe("");
  });

  it("says <0.01 rather than rounding a real cost to nothing, symbol inside", () => {
    // "<$0.01" is "less than a cent"; "$<0.01" reads as a typo.
    expect(formatSpend(0.004, "usd")).toBe("<$0.01");
    expect(formatSpend(0, "usd")).toBe("$0.00");
  });

  it("states a RATE without rounding it away", () => {
    // The shipped 0.008 through `formatSpend` is "<$0.01" — a sentence whose
    // whole job is to make the figures checkable, withholding the number.
    expect(formatRate(0.008, "usd")).toBe("$0.008");
    expect(formatRate(0.062, "usd")).toBe("$0.062");
    expect(formatRate(0.008, "none")).toBe("0.008");
    expect(formatRate(1, "usd")).toBe("$1");
  });

  it("gives every currency on the picker a symbol the formatter can use", () => {
    // A currency added to the list with no symbol renders as a bare number and
    // nothing throws — the same silent class of bug as a missing CSS class.
    for (const c of COST_CURRENCIES) {
      const out = formatSpend(1, c.id);
      expect(out, c.id).toBe(`${c.symbol}1.00`);
      if (c.id !== "none") expect(c.symbol.length, c.id).toBeGreaterThan(0);
    }
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
