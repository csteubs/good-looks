// What the TRAINER does with the three steps that are about VARIABLES rather
// than about the page: a `variable` assertion, a `variable` condition, and an
// `echo`.
//
// Its own module, and PURE, for the reason recorder-navigation.ts is: every
// branch here is a decision the user sees the consequence of, and none of them
// should need an Electron window to exercise. recorder-service.ts imports it
// and does nothing to the result but mask secrets out of it.
//
// It never injects anything into the page, which is not only convenience. The
// injected replayer runs alongside an arbitrary website, so shipping a
// variable's value in to compare it there would hand that page the value — and
// there is nothing page-side to do anyway, since both operands are strings the
// session already holds.
//
// The comparison itself is `compareValues` from shared/step-semantics.mjs, the
// same function the generated spec's condition helper is built from. A second
// spelling of "starts with" here is exactly how a step comes to be green in the
// trainer and impossible to pass in a run.

import { compareValues, COMPARE_OP_LABEL } from "../../shared/step-semantics.mjs";
import type { Step, DebugLogLine, TestVariable } from "../recorder/types.js";

/** The shape `runStep` reports. Declared here rather than imported so this
 *  module stays free of anything that reaches the shell. */
export interface VariableStepResult {
  ok: boolean;
  error?: string;
  /** for a `variable` condition: whether it held */
  met?: boolean;
  logs?: DebugLogLine[];
}

/**
 * A variable's value as the TRAINER can see it, or the reason it cannot.
 *
 * Two cases are reported as a REASON rather than compared against "", because
 * an empty string is a value and comparing against it would answer a question
 * the user did not ask:
 *
 *  • a `captured` variable has nothing in it until a RUN writes one — the
 *    trainer does not execute a spec, so nothing has captured anything yet;
 *  • a secret's value is deliberately never read back into the trainer's own
 *    output, which is the rule `maskValues` enforces everywhere else.
 */
export function trainerVariableValue(
  name: string | undefined,
  variables: readonly TestVariable[],
): { value: string } | { reason: string } {
  if (!name) return { reason: "no variable was chosen for this step" };
  const v = variables.find((x) => x.name === name);
  if (!v) return { reason: `no variable named "${name}" is declared on this test` };
  if (v.kind === "secret") {
    return {
      reason: `"${name}" is a secret, and the trainer never reads a secret's value back into its own output — this step is checked on a run`,
    };
  }
  if (v.kind === "captured" && (v.value ?? "") === "") {
    return {
      reason: `"${name}" is captured during a run and has no value here yet — this step is checked on a run`,
    };
  }
  return { value: v.value ?? "" };
}

/**
 * Evaluate one variable step.
 *
 * @param step     the step as recorded (for its kind, variable and operator)
 * @param resolved the same step with `${refs}` already substituted, which is
 *                 where the expected value and the echo message are read from
 */
export function runVariableStep(
  step: Step,
  resolved: Step,
  variables: readonly TestVariable[],
): VariableStepResult {
  const line = (level: "info" | "error", m: string): DebugLogLine[] => [
    { i: 0, t: Date.now(), level, m },
  ];

  if (step.type === "echo") {
    return { ok: true, logs: line("info", "[echo] " + (resolved.text ?? resolved.value ?? "")) };
  }

  const found = trainerVariableValue(step.captureVar, variables);
  if ("reason" in found) {
    // A CONDITION that cannot be evaluated must not silently pick a branch.
    // Reporting `met: false` would skip the block and read as "the condition
    // did not hold", which is a different statement from "I could not tell" —
    // and the user would be looking at a preview that took a path the run will
    // not take.
    return { ok: false, error: found.reason, logs: line("error", found.reason) };
  }

  const op = step.compareOp ?? "eq";
  const expected = resolved.value ?? "";
  const held = compareValues(found.value, op, expected);
  // Phrased so it reads correctly for the NEGATED operators too. Folding the
  // verdict into the phrase produces "which does not does not equal"; stating
  // them separately does not.
  const label = COMPARE_OP_LABEL[op] ?? op;
  const detail =
    `"${step.captureVar}" is ${JSON.stringify(found.value)}; the check ` +
    `"${label} ${JSON.stringify(expected)}" ${held ? "held" : "did not hold"}`;

  if (step.type === "if") return { ok: true, met: held, logs: line("info", detail) };
  return held
    ? { ok: true, logs: line("info", detail) }
    : { ok: false, error: detail, logs: line("error", detail) };
}

/** Whether `runStep` should hand this step to `runVariableStep` instead of the
 *  injected replayer. One predicate, so the dispatch and any future caller
 *  cannot disagree about which steps never reach the page. */
export function isVariableStep(step: Step): boolean {
  return (
    step.type === "echo" ||
    (step.type === "assert" && step.assert === "variable") ||
    (step.type === "if" && step.cond === "variable")
  );
}
