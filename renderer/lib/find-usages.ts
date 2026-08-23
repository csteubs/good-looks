// Find Usages for a locator: every step in the library that points at the
// same element the same way. Equality is the generator's SPELLING of the
// locator (`locatorExpr`), not object identity — two steps recorded on
// different days that emit `getByRole('button', { name: 'Save' })` are the
// same usage, and a step whose locator differs only in chained context is
// not. Pure, so the Script tab's panel and a test can share it.

import { locatorExpr } from "./describe-step";
import { describeStep } from "./describe-step";
import type { Locator, Step, TestRecord } from "./recorder-types";

export interface LocatorUsage {
  testId: string;
  testName: string;
  stepIndex: number;
  /** `describeStep` of the step, for the list. */
  label: string;
}

export function locatorKey(locator: Locator): string {
  return locatorExpr(locator);
}

export function findLocatorUsages(tests: readonly TestRecord[], locator: Locator): LocatorUsage[] {
  const key = locatorKey(locator);
  const out: LocatorUsage[] = [];
  for (const t of tests) {
    (t.steps ?? []).forEach((step: Step, stepIndex) => {
      const candidates = [step.locator, step.toLocator].filter((l): l is Locator => Boolean(l));
      if (candidates.some((l) => locatorKey(l) === key)) {
        out.push({ testId: t.id, testName: t.name, stepIndex, label: describeStep(step) });
      }
    });
  }
  return out;
}
