// What a retry means, for the record and for the maths (R24).
//
// Under `main/services/` rather than beside the module: vitest's node project
// takes `main/**`, `mcp/**` and `renderer/lib/**`, so a test file in `shared/`
// matches NEITHER project and is silently never run.
//
// The property worth guarding here is not arithmetic, it is that the two
// answers stay DIFFERENT. `docs/ROUTINES.md` refused a retry policy because a
// retry stacked on Auto-Heal "makes a flaky test look stable — which is
// precisely the signal the Stability panel exists to give". Collapsing the
// outcome and the signal into one number, either way round, is that bug.

import { describe, expect, it } from "vitest";

import {
  everFailed,
  flakeSignal,
  MAX_RETRIES,
  normalizeRetries,
  retryFields,
} from "../../shared/run-attempts.mjs";

describe("normalizeRetries", () => {
  it("accepts none through the cap", () => {
    for (let n = 0; n <= MAX_RETRIES; n++) expect(normalizeRetries(n)).toBe(n);
  });

  it("answers null for anything unusable, so a caller can refuse by name", () => {
    // Null rather than 0. A caller that cannot tell "not asked for" from
    // "asked for, badly" runs without retries and says nothing — and the
    // person who typed `--retries eight` reads the resulting failure as real.
    for (const bad of [-1, 1.5, NaN, Infinity, "2", null, undefined, {}]) {
      expect(normalizeRetries(bad)).toBeNull();
    }
  });

  it("refuses more than the cap rather than clamping to it", () => {
    expect(normalizeRetries(MAX_RETRIES + 1)).toBeNull();
  });
});

describe("retryFields", () => {
  it("writes nothing at all when the run was never retried", () => {
    // The load-bearing case. `attempt: 0` on every row ever written is
    // indistinguishable from a row that predates the field — and telling those
    // apart is the entire reason the field exists.
    expect(retryFields({ status: "passed", maxAttempt: 0 })).toEqual({});
    expect(retryFields({ status: "failed", maxAttempt: 0 })).toEqual({});
  });

  it("marks a run that failed and then passed", () => {
    expect(retryFields({ status: "passed", maxAttempt: 1 })).toEqual({
      attempt: 1,
      passedOnRetry: true,
    });
  });

  it("records the attempts of a run that retried and still failed, without claiming a recovery", () => {
    // Both facts are worth having: the attempt count is what says the failure
    // was reproduced rather than seen once.
    expect(retryFields({ status: "failed", maxAttempt: 2 })).toEqual({ attempt: 2 });
  });

  it("ignores an attempt count that is not a count", () => {
    for (const bad of [-1, 1.5, NaN, "1", undefined]) {
      expect(retryFields({ status: "passed", maxAttempt: bad as number })).toEqual({});
    }
  });
});

describe("flakeSignal and everFailed", () => {
  const retried = { status: "passed", passedOnRetry: true };
  const plainPass = { status: "passed" };
  const plainFail = { status: "failed" };

  it("reports a retried pass as failed to the transition series", () => {
    expect(flakeSignal(retried)).toBe("failed");
  });

  it("…while it stays a pass as an outcome", () => {
    // The whole design, in one assertion: the same record answers both
    // questions differently, and neither answer is a compromise.
    expect(retried.status).toBe("passed");
    expect(flakeSignal(retried)).toBe("failed");
  });

  it("leaves every other run exactly as it was", () => {
    // A history recorded before R24 has to count identically, or every stored
    // verdict changes the day this ships.
    expect(flakeSignal(plainPass)).toBe("passed");
    expect(flakeSignal(plainFail)).toBe("failed");
    expect(flakeSignal({ status: "passed", passedOnRetry: false })).toBe("passed");
  });

  it("says a retried pass went red, and a plain pass did not", () => {
    expect(everFailed(retried)).toBe(true);
    expect(everFailed(plainFail)).toBe(true);
    expect(everFailed(plainPass)).toBe(false);
  });
});
