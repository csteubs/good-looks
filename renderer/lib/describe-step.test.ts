// The step list's rendering of a locator IS a promise about the generated
// script — the file's own header says it mirrors the backend generator. These
// pin the one case where the two recently learned to differ from getByTestId:
// a testid recorded off an attribute getByTestId cannot resolve.
//
// VERIFIED TO FAIL with the mirror's testid case left as a bare
// `getByTestId(...)`: the first test then reports the call the run would NOT
// contain.

import { describe, expect, it } from "vitest";

import { describeStep } from "./describe-step";
import type { Step } from "./recorder-types";

function step(partial: Partial<Step>): Step {
  return { id: "s1", timestamp: 0, type: "click", ...partial } as Step;
}

describe("a testid locator in the step list", () => {
  it("shows the attribute selector the generator actually emits for data-test", () => {
    const s = step({ locator: { k: "testid", attr: "data-test", v: "quick-save" } });
    expect(describeStep(s)).toContain('locator("[data-test=\\"quick-save\\"]")');
  });

  it("still shows getByTestId when no attribute is recorded", () => {
    const s = step({ locator: { k: "testid", v: "submit" } });
    expect(describeStep(s)).toContain('getByTestId("submit")');
  });

  it("ignores an attribute outside the allowlist, like the generator does", () => {
    const s = step({
      locator: { k: "testid", v: "x", attr: "onclick" } as unknown as Step["locator"],
    });
    expect(describeStep(s)).toContain('getByTestId("x")');
  });
});
