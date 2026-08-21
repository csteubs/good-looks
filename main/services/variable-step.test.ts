// The TRAINER's half of the variable steps.
//
// The comparison itself is covered in variable-assertions.test.ts and pinned
// against real Playwright in e2e/assert-parity.spec.ts. What is covered HERE is
// the part that is the trainer's alone: which steps never reach the page, what
// it does when it cannot see a value, and — the one that would be a silent
// product bug — what a condition it cannot evaluate reports.

import { describe, expect, it } from "vitest";

import { isVariableStep, runVariableStep, trainerVariableValue } from "./variable-step.js";
import type { Step, TestVariable } from "../recorder/types.js";

function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: "s", timestamp: 0, ...partial } as Step;
}

const VARS: TestVariable[] = [
  { name: "total", kind: "plain", value: "49.99" },
  { name: "token", kind: "secret" },
  { name: "orderId", kind: "captured" },
  { name: "seeded", kind: "captured", value: "A-1" },
];

describe("which steps never reach the page", () => {
  it("claims the three variable steps and nothing else", () => {
    expect(isVariableStep(step({ type: "echo", text: "hi" }))).toBe(true);
    expect(isVariableStep(step({ type: "assert", assert: "variable" }))).toBe(true);
    expect(isVariableStep(step({ type: "if", cond: "variable" }))).toBe(true);

    expect(isVariableStep(step({ type: "assert", assert: "visible" }))).toBe(false);
    expect(isVariableStep(step({ type: "if", cond: "visible" }))).toBe(false);
    expect(isVariableStep(step({ type: "click" }))).toBe(false);
    expect(isVariableStep(step({ type: "capture", captureVar: "x" }))).toBe(false);
  });
});

describe("what the trainer can see", () => {
  it("reads a plain variable's value", () => {
    expect(trainerVariableValue("total", VARS)).toEqual({ value: "49.99" });
  });

  it("refuses a secret rather than reading it back into its own output", () => {
    const got = trainerVariableValue("token", VARS);
    expect("reason" in got && got.reason).toContain("is a secret");
  });

  it("refuses a captured variable that nothing has captured yet", () => {
    // The trainer does not execute a spec, so nothing has written one. Reading
    // it as "" would compare against a value the user never set.
    const got = trainerVariableValue("orderId", VARS);
    expect("reason" in got && got.reason).toContain("captured during a run");
  });

  it("uses a captured variable's fallback when it HAS one", () => {
    expect(trainerVariableValue("seeded", VARS)).toEqual({ value: "A-1" });
  });

  it("refuses a name the test does not declare, and no name at all", () => {
    expect("reason" in trainerVariableValue("nope", VARS)).toBe(true);
    expect("reason" in trainerVariableValue(undefined, VARS)).toBe(true);
  });
});

describe("evaluating a step", () => {
  const assertOn = (over: Partial<Step>): Step =>
    step({ type: "assert", assert: "variable", captureVar: "total", ...over });

  it("passes an assertion that holds and fails one that does not", () => {
    expect(runVariableStep(assertOn({ value: "49.99" }), assertOn({ value: "49.99" }), VARS).ok).toBe(
      true,
    );
    const bad = assertOn({ value: "50.00" });
    const res = runVariableStep(bad, bad, VARS);
    expect(res.ok).toBe(false);
    // The message names the ACTUAL value, which is the whole reason to run this
    // in the trainer rather than waiting for a run.
    expect(res.error).toContain('"total" is "49.99"');
    expect(res.error).toContain("did not hold");
  });

  it("phrases a negated operator without saying 'does not does not'", () => {
    const s = assertOn({ compareOp: "neq", value: "49.99" });
    const res = runVariableStep(s, s, VARS);
    expect(res.error).toContain('the check "does not equal "49.99"" did not hold');
    expect(res.error).not.toContain("does not does not");
  });

  it("reports a condition as met or not, without failing the step", () => {
    const yes = step({ type: "if", cond: "variable", captureVar: "total", compareOp: "contains", value: "49" });
    expect(runVariableStep(yes, yes, VARS)).toMatchObject({ ok: true, met: true });
    const no = step({ type: "if", cond: "variable", captureVar: "total", compareOp: "contains", value: "zz" });
    expect(runVariableStep(no, no, VARS)).toMatchObject({ ok: true, met: false });
  });

  it("FAILS a condition it cannot evaluate rather than reporting `met: false`", () => {
    // The one that would be a silent product bug. `met: false` skips the block
    // and reads as "the condition did not hold" — a different statement from
    // "I could not tell", and the preview would take a path the run will not.
    const s = step({ type: "if", cond: "variable", captureVar: "orderId", value: "x" });
    const res = runVariableStep(s, s, VARS);
    expect(res.ok).toBe(false);
    expect(res.met).toBeUndefined();
  });

  it("reads the expected value from the RESOLVED step", () => {
    // `${refs}` are substituted before this runs, exactly as they are for an
    // injected step — so a comparison against another variable works.
    const raw = assertOn({ value: "${other}" });
    const resolved = assertOn({ value: "49.99" });
    expect(runVariableStep(raw, resolved, VARS).ok).toBe(true);
  });

  it("defaults to `eq` when no operator was chosen", () => {
    const s = assertOn({ value: "49.99" });
    expect(runVariableStep(s, s, VARS).ok).toBe(true);
    const s2 = assertOn({ value: "49" });
    expect(runVariableStep(s2, s2, VARS).ok).toBe(false);
  });

  it("logs an echo and never fails", () => {
    const raw = step({ type: "echo", text: "total is ${total}" });
    const resolved = step({ type: "echo", text: "total is 49.99" });
    const res = runVariableStep(raw, resolved, VARS);
    expect(res.ok).toBe(true);
    expect(res.logs?.[0]?.m).toBe("[echo] total is 49.99");
  });

  it("logs an echo with nothing to say rather than throwing", () => {
    const s = step({ type: "echo" });
    expect(runVariableStep(s, s, VARS)).toMatchObject({ ok: true });
  });
});
