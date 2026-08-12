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
  tally,
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
    expect(toneForVerdict("healed", tally(over)).className).toBe("bg-support-green-yellow");
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
    expect(toneForVerdict("failed", tally(batch(3))).className).toBe("bg-support-red");
  });

  it("keeps a single failing run red rather than mixed", () => {
    // A one-browser run that failed is 100% failed. If the ratio rule leaked
    // into this case, every ordinary failure would show as a blend and red
    // would effectively never appear.
    expect(verdictFor([run({ status: "failed" })])).toBe("failed");
  });

  it("names the counts on a mixed verdict and not on a plain one", () => {
    expect(toneForVerdict("mostly-passed", tally(batch(1))).label).toBe("2 of 3 runs passed");
    expect(toneForVerdict("passed", tally([run()])).label).toBe("Last run passed");
    expect(toneForVerdict("failed", tally([run({ status: "failed" })])).label).toBe(
      "Last run failed",
    );
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
    const v = verdictsByTest([...failed, run({ id: "rerun", status: "passed", startedAt: 999 })]);
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
    expect(verdictsByTest(cohort).get("t1")?.className).toBe("bg-support-orange-red");
  });

  it("does not mix an older batch into a newer one's verdict", () => {
    const older = batch(3).map((r) => ({ ...r, id: `old-${r.id}`, batchId: "b0", startedAt: 1 }));
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
