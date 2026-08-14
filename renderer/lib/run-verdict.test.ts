// The run-verdict scale, which is the sidebar dot's whole contract.
//
// Same reasoning as ai-debug-icons.test.tsx: a wrong colour here throws
// nothing, fails no build and looks entirely normal on screen — the user reads
// green and walks away from a test that only passed on two browsers of three,
// or reads red and re-runs one that has since been fixed. Nothing else catches
// it, so the mapping is pinned state by state.

import { describe, it, expect } from "vitest";

import type { RunRecord } from "./recorder-types";
import {
  HEAL_TOLERANCE,
  groupVerdictTone,
  tally,
  testVerdicts,
  toneForVerdict,
  verdictFor,
  verdictsByTest,
} from "./run-verdict";

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    testId: "t1",
    testName: "Login",
    url: "https://example.test/login",
    status: "passed",
    exitCode: 0,
    startedAt: 100,
    finishedAt: 200,
    durationMs: 100,
    logFile: "/tmp/r1.log",
    logBytes: 0,
    ...over,
  };
}

/** One batch across the three browsers, `failures` of them failing. */
function batch(failures: number, over: Partial<RunRecord> = {}): RunRecord[] {
  return (["chromium", "firefox", "webkit"] as const).map((b, i) =>
    run({
      id: `r-${b}`,
      runBrowser: b,
      batchId: "b1",
      status: i < failures ? "failed" : "passed",
      startedAt: 100 + i,
      ...over,
    }),
  );
}

describe("verdictFor", () => {
  it("has no verdict without runs", () => {
    expect(verdictFor([])).toBeNull();
  });

  it("is green when everything passed on its own locators", () => {
    expect(verdictFor(batch(0))).toBe("passed");
  });

  it("stays green at the heal tolerance and turns green-yellow past it", () => {
    // The boundary is the whole rule ("more than three"), and an off-by-one
    // here is invisible: both sides are a passing test with a green-ish dot.
    const atLimit = [run({ healedSteps: HEAL_TOLERANCE })];
    const over = [run({ healedSteps: HEAL_TOLERANCE + 1 })];
    expect(verdictFor(atLimit)).toBe("passed");
    expect(verdictFor(over)).toBe("healed");
    expect(toneForVerdict("healed", tally(over)).className).toBe(
      "bg-support-green-yellow",
    );
  });

  it("counts heals across the whole cohort, not per run", () => {
    // Three browsers healing two steps each is six drifting selectors. Judging
    // per-run would call that ordinary because no single run passed three.
    const cohort = batch(0).map((r) => ({ ...r, healedSteps: 2 }));
    expect(verdictFor(cohort)).toBe("healed");
  });

  it("is yellow-orange when one browser of three failed", () => {
    expect(verdictFor(batch(1))).toBe("mostly-passed");
    expect(toneForVerdict("mostly-passed", tally(batch(1))).className).toBe(
      "bg-support-yellow-orange",
    );
  });

  it("is orange-red when two browsers of three failed", () => {
    expect(verdictFor(batch(2))).toBe("mostly-failed");
    expect(toneForVerdict("mostly-failed", tally(batch(2))).className).toBe(
      "bg-support-orange-red",
    );
  });

  it("is red only when every browser failed", () => {
    expect(verdictFor(batch(3))).toBe("failed");
    expect(toneForVerdict("failed", tally(batch(3))).className).toBe(
      "bg-support-red",
    );
  });

  it("keeps a single failing run red rather than mixed", () => {
    // A one-browser run that failed is 100% failed. If the ratio rule leaked
    // into this case, every ordinary failure would show as a blend and red
    // would effectively never appear.
    expect(verdictFor([run({ status: "failed" })])).toBe("failed");
  });

  it("names the counts on a mixed verdict and not on a plain one", () => {
    expect(toneForVerdict("mostly-passed", tally(batch(1))).label).toBe(
      "2 of 3 runs passed",
    );
    expect(toneForVerdict("passed", tally([run()])).label).toBe(
      "Last run passed",
    );
    expect(
      toneForVerdict("failed", tally([run({ status: "failed" })])).label,
    ).toBe("Last run failed");
  });
});

describe("verdictsByTest", () => {
  it("reads the newest run, not list order", () => {
    const v = verdictsByTest([
      run({ id: "old", status: "passed", startedAt: 100 }),
      run({ id: "new", status: "failed", startedAt: 200 }),
    ]);
    expect(v.get("t1")?.label).toBe("Last run failed");
  });

  it("resets to green as soon as a later run passes", () => {
    // The reset is the behaviour the feature promises from anywhere in the
    // app, and the only way it can never get stuck is that nothing is sticky:
    // the newest cohort is the whole answer.
    const failed = [...batch(3)];
    const v = verdictsByTest([
      ...failed,
      run({ id: "rerun", status: "passed", startedAt: 999 }),
    ]);
    expect(v.get("t1")?.className).toBe("bg-support-green");
  });

  it("goes red again on a failing re-run after a green batch", () => {
    const v = verdictsByTest([
      ...batch(0),
      run({ id: "repro", status: "failed", startedAt: 999 }),
    ]);
    expect(v.get("t1")?.className).toBe("bg-support-red");
  });

  it("judges a batch by its whole cohort, not by whichever browser finished last", () => {
    // The newest record in a three-browser batch is one browser's result. Read
    // alone it reports green for a batch that lost two of three.
    const cohort = batch(2); // chromium + firefox failed, webkit (newest) passed
    expect(cohort[2].status).toBe("passed");
    expect(verdictsByTest(cohort).get("t1")?.className).toBe(
      "bg-support-orange-red",
    );
  });

  it("does not mix an older batch into a newer one's verdict", () => {
    const older = batch(3).map((r) => ({
      ...r,
      id: `old-${r.id}`,
      batchId: "b0",
      startedAt: 1,
    }));
    const v = verdictsByTest([...older, ...batch(0)]);
    expect(v.get("t1")?.className).toBe("bg-support-green");
  });

  it("keeps tests apart", () => {
    const v = verdictsByTest([
      run({ id: "a", testId: "t1", status: "passed" }),
      run({ id: "b", testId: "t2", status: "failed" }),
    ]);
    expect(v.get("t1")?.className).toBe("bg-support-green");
    expect(v.get("t2")?.className).toBe("bg-support-red");
    expect(v.get("t3")).toBeUndefined();
  });
});

describe("groupVerdictTone — one dot for a library folder (REDESIGN §7.2)", () => {
  it("counts TESTS, not runs", () => {
    // A folder of two where one failed on three browsers is "1 of 2 tests
    // passed". Counting runs would say "3 of 4", which is arithmetic about a
    // thing nobody grouped.
    expect(groupVerdictTone(["passed", "failed"])?.label).toBe(
      "1 of 2 tests passed",
    );
  });

  it("is green when every member passed, and says how many", () => {
    expect(groupVerdictTone(["passed", "passed"])).toEqual({
      className: "bg-support-green",
      label: "All 2 tests passed",
    });
  });

  it("is red when every member failed", () => {
    expect(groupVerdictTone(["failed", "failed"])).toEqual({
      className: "bg-support-red",
      label: "All 2 tests failed",
    });
  });

  it("counts a member that PASSED WITH HEALS as passed", () => {
    // The heal warning is a per-test early signal about that test's locators.
    // Propagating it would tint a folder yellow and send you to look at five
    // tests to find one.
    expect(groupVerdictTone(["healed", "passed"])?.className).toBe(
      "bg-support-green",
    );
  });

  it("uses the same ratio the run scale does, so a folder and a test agree", () => {
    // A third or less failing is the lighter mix; more than that is the darker
    // one. Same rule as `verdictFor`, so "mostly" means one thing in this app.
    expect(groupVerdictTone(["passed", "passed", "failed"])?.className).toBe(
      "bg-support-yellow-orange",
    );
    expect(groupVerdictTone(["passed", "failed", "failed"])?.className).toBe(
      "bg-support-orange-red",
    );
  });

  it("is null when nothing in the folder has ever run", () => {
    // No dot, rather than a grey one claiming a result. The caller passes only
    // the members that HAVE a verdict, so an empty list means exactly that.
    expect(groupVerdictTone([])).toBeNull();
  });

  it("speaks in the singular for a folder of one", () => {
    expect(groupVerdictTone(["passed"])?.label).toBe("Its test passed");
    expect(groupVerdictTone(["failed"])?.label).toBe("Its test failed");
  });
});

describe("testVerdicts", () => {
  it("reports the verdict as well as the tone, which is what a folder counts", () => {
    const v = testVerdicts([run({ id: "a", testId: "t1", status: "failed" })]);
    expect(v.get("t1")?.verdict).toBe("failed");
    expect(v.get("t1")?.tone.className).toBe("bg-support-red");
    expect(v.get("t1")?.tally.total).toBe(1);
  });

  it("agrees with verdictsByTest, which is its projection", () => {
    // One traversal, not two: if these ever disagreed, two dots for the same
    // test would be drawn from two different readings of the same runs.
    const runs = [
      run({ id: "a", testId: "t1", status: "passed" }),
      run({ id: "b", testId: "t2", status: "failed" }),
    ];
    const tones = verdictsByTest(runs);
    for (const [id, v] of testVerdicts(runs)) {
      expect(tones.get(id)).toEqual(v.tone);
    }
    expect([...tones.keys()].sort()).toEqual(["t1", "t2"]);
  });
});
