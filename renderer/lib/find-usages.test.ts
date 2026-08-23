import { describe, it, expect } from "vitest";

import { findLocatorUsages } from "./find-usages";
import type { Step, TestRecord } from "./recorder-types";

const save = { k: "role", role: "button", name: "Save" } as Step["locator"];
const cancel = { k: "role", role: "button", name: "Cancel" } as Step["locator"];
const step = (id: string, type: Step["type"], locator?: Step["locator"], extra: Partial<Step> = {}): Step =>
  ({ id, type, timestamp: 0, ...(locator ? { locator } : {}), ...extra }) as Step;
const test = (id: string, name: string, steps: Step[]): TestRecord => ({ id, name, url: "https://a.example", steps }) as unknown as TestRecord;

describe("findLocatorUsages", () => {
  it("lists every step in the library spelled the same, including a drag's target", () => {
    const tests = [
      test("t1", "Checkout", [step("a", "click", save), step("b", "click", cancel)]),
      test("t2", "Login", [step("c", "assert", { ...save! }, { assert: "visible" }), step("d", "drag", cancel, { toLocator: { ...save! } })]),
      test("t3", "Empty", []),
    ];
    const hits = findLocatorUsages(tests, save!);
    expect(hits.map((h) => `${h.testName}#${h.stepIndex}`)).toEqual(["Checkout#0", "Login#0", "Login#1"]);
    expect(hits[0].label).toContain("Save");
  });

  it("a locator that differs in its chained context is not the same usage", () => {
    const scoped = { ...save!, nth: 1 } as Step["locator"];
    const tests = [test("t1", "T", [step("a", "click", scoped)])];
    expect(findLocatorUsages(tests, save!)).toEqual([]);
    expect(findLocatorUsages(tests, scoped!)).toHaveLength(1);
  });
});
