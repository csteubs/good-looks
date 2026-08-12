// "How was this week?" — the weekly read. REDESIGN §6.5.
//
// The sentences ARE the feature, so these assert them rather than the numbers
// behind them — the same rule §6.1's run summary and §6.6's provenance, drift
// and region lines follow.
//
// The readings that would be quietly wrong, none of which throws:
//
//   • A week with no runs reported as "0 failed" or "all passed". Both are true
//     of an empty set and read as good news, and a suite nobody is running is
//     the failure this whole app exists against.
//   • Failures counted per RUN rather than per TEST. "3 failures" says the same
//     thing about one test failing three times and three tests failing once,
//     which want completely different reactions.
//   • A first week compared against zero, which reads as explosive growth and
//     is really a statement about the app being new.

import { describe, expect, it } from "vitest";

import type { RunRecord } from "./recorder-types";
import { WEEK_MS, weeklyDigest } from "./weekly-digest";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `r${Math.random()}`,
    testId: "t1",
    testName: "Checkout",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: NOW - HOUR,
    finishedAt: NOW - HOUR + 1_000,
    durationMs: 1_000,
    logFile: "/x.log",
    logBytes: 1,
    ...over,
  } as RunRecord;
}

/** N runs inside this week. */
function thisWeek(n: number, over: Partial<RunRecord> = {}): RunRecord[] {
  return Array.from({ length: n }, (_, i) => run({ id: `w${i}`, startedAt: NOW - HOUR * (i + 1), ...over }));
}

/** N runs inside the week BEFORE this one. */
function lastWeek(n: number, over: Partial<RunRecord> = {}): RunRecord[] {
  return Array.from({ length: n }, (_, i) =>
    run({ id: `p${i}`, startedAt: NOW - WEEK_MS - HOUR * (i + 1), ...over }),
  );
}

const read = (runs: RunRecord[]) => weeklyDigest(runs, NOW).lines.join(" ");

describe("a quiet week", () => {
  it("says nothing ran, rather than reporting a perfect record", () => {
    // THE ONE THAT MATTERS MOST. "0 failures" and "all passed" are true of an
    // empty set and read as good news; a suite nobody runs is the failure mode
    // the whole app exists against.
    const digest = weeklyDigest([], NOW);
    expect(digest.lines).toEqual(["Nothing ran this week."]);
    expect(read([])).not.toContain("passed");
  });

  it("says how much ran the week before, when something did", () => {
    // Which is the whole reading: not "quiet", but "quieter than it was".
    expect(read(lastWeek(12))).toBe("Nothing ran this week. 12 runs the week before.");
  });

  it("does not count runs from before the window", () => {
    expect(weeklyDigest([run({ startedAt: NOW - 30 * DAY })], NOW).runs).toBe(0);
  });
});

describe("volume and outcome", () => {
  it("leads with the count and how many failed", () => {
    const runs = [...thisWeek(3), ...thisWeek(1).map((r) => ({ ...r, id: "f", status: "failed" as const }))];
    expect(read(runs)).toContain("4 runs, 1 failed.");
  });

  it("says all passed when none did", () => {
    expect(read(thisWeek(5))).toContain("5 runs, all passed.");
  });

  it("gets the singular right", () => {
    expect(read(thisWeek(1))).toContain("1 run, all passed.");
  });

  it("ignores baseline updates, which are not runs", () => {
    // They live in the same history and the Stats header already separates
    // them; counting them here would inflate a quiet week with work nobody did.
    const rows = [...thisWeek(2), run({ id: "b", status: "baseline-update" as never })];
    expect(weeklyDigest(rows, NOW).runs).toBe(2);
  });
});

describe("the week-on-week comparison", () => {
  it("is what makes this weekly rather than a total", () => {
    expect(read([...thisWeek(10), ...lastWeek(4)])).toContain("Up 6 on the week before (4).");
    expect(read([...thisWeek(4), ...lastWeek(10)])).toContain("Down 6 on the week before (10).");
  });

  it("says so when nothing changed", () => {
    expect(read([...thisWeek(5), ...lastWeek(5)])).toContain("Same as the week before.");
  });

  it("is OMITTED for a first week, rather than compared against zero", () => {
    // "Up 10 on the week before (0)" reads as explosive growth and is really a
    // statement about the app being new.
    const line = read(thisWeek(10));
    expect(line).not.toContain("Up");
    expect(line).not.toContain("week before");
  });

  it("does not count the week before last", () => {
    const older = [run({ id: "o", startedAt: NOW - 3 * WEEK_MS })];
    expect(weeklyDigest([...thisWeek(2), ...older], NOW).previousRuns).toBe(0);
  });
});

describe("what broke", () => {
  const fail = (testId: string, testName: string, i: number) =>
    run({ id: `${testId}-${i}`, testId, testName, status: "failed", exitCode: 1, startedAt: NOW - HOUR * (i + 1) });

  it("counts per TEST, not per run", () => {
    // One test failing three times is one problem; three tests failing once is
    // three, and a bare "3 failures" says the same thing about both.
    const digest = weeklyDigest([fail("t1", "Checkout", 0), fail("t1", "Checkout", 1), fail("t1", "Checkout", 2)], NOW);
    expect(digest.offenders).toHaveLength(1);
    expect(digest.offenders[0].failures).toBe(3);
    expect(digest.lines.join(" ")).toContain("Checkout failed 3 times.");
  });

  it("names the worst first", () => {
    const runs = [
      fail("t1", "Checkout", 0),
      fail("t1", "Checkout", 1),
      fail("t2", "Login", 2),
    ];
    expect(read(runs)).toContain("Worst: Checkout (2×), Login (1×).");
  });

  it("counts the rest rather than listing them", () => {
    // A list of five test names is a table written in prose, and there is a
    // real table further down the screen.
    const runs = ["a", "b", "c", "d"].map((t, i) => fail(t, `Test ${t}`, i));
    const line = read(runs);
    expect(line).toContain("and 2 others.");
    expect(line).not.toContain("Test c");
  });

  it("says nothing about offenders on a clean week", () => {
    expect(read(thisWeek(6))).not.toContain("Worst");
  });
});

describe("flake", () => {
  /** A failure then a pass with every recorded setting identical — §6.4's
   *  definition, which this reuses rather than restating. */
  function flakePair(testId: string): RunRecord[] {
    return [
      run({ id: `${testId}-pass`, testId, status: "passed", startedAt: NOW - HOUR }),
      run({ id: `${testId}-fail`, testId, status: "failed", exitCode: 1, startedAt: NOW - 2 * HOUR }),
    ];
  }

  it("qualifies the failures above rather than standing alone", () => {
    const line = read(flakePair("t1"));
    expect(line).toContain("1 failure passed again with nothing changed");
    // After the failure count, not instead of it — flake is a qualifier on what
    // broke, not a separate finding.
    expect(line.indexOf("failed.")).toBeLessThan(line.indexOf("possible flake"));
  });

  it("stays grammatical when more than one was flaky", () => {
    // The first wording was "N of those failures", which reads "1 of those
    // failure" at one and claims a set that does not exist when the week had a
    // single failure in it.
    const runs = [...flakePair("t1"), ...flakePair("t2")];
    expect(read(runs)).toContain("2 failures passed again");
  });

  it("says nothing at all on a week with no flake", () => {
    expect(read(thisWeek(4))).not.toContain("flake");
  });

  it("does not compare unrelated tests to each other", () => {
    // `flakeRuns` reads ONE test's history in order. Handed a mixed list it
    // would compare a failure of one test to a pass of another and call the
    // result flake — which is a finding invented out of interleaving.
    const runs = [
      run({ id: "a-fail", testId: "a", status: "failed", exitCode: 1, startedAt: NOW - 2 * HOUR }),
      run({ id: "b-pass", testId: "b", status: "passed", startedAt: NOW - HOUR }),
    ];
    expect(weeklyDigest(runs, NOW).flaky).toBe(0);
  });
});
