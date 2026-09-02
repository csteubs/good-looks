// What the LLM stack BELIEVES about this app, checked against what the app does.
//
// The prompts and the step validator are the app's conventions written out a
// second and third time, in prose and in a hand-copied `Set`. Nothing bound
// either to the code, and both had drifted — in the direction that produces
// confident wrong output rather than an error:
//
//  • The prompt told the model to emit `urlEndsWith`; the validator's copy of
//    the assert kinds omitted it, so `validateStep` dropped the step. No error,
//    no count — the user simply got fewer steps than the model wrote.
//  • The prompt never said `title` is an EXACT whole-title match, and offered no
//    `titleContains`, so "check the title mentions Checkout" had exactly one
//    expressible answer and it was the one that fails on "Checkout | Acme".
//  • `locatorToPrompt` dropped `.nth(k)` — and, found later, the whole `ctx`
//    chain — so the model was shown a locator that could not produce the
//    failure it was being asked to diagnose.
//
// These are the same class of bug as the trainer/generator divergence this
// branch fixed, one layer out: a second copy of a rule, with nothing comparing
// the copies.

import { describe, expect, it } from "vitest";

import {
  buildDebugMessages,
  buildGenerateStepsMessages,
  buildStepDebugMessages,
  describeSending,
  locatorToPrompt,
} from "./llm-prompts";
import { extractStepsJson } from "./parse-llm-response";
import { ASSERT_KINDS } from "./recorder-types";
import { ASSERT_SEMANTICS } from "../../shared/step-semantics.mjs";

function stepsSystemPrompt(): string {
  return buildGenerateStepsMessages({ prompt: "x", url: "https://x.test" })[0].content;
}

describe("the model can express every assert kind the app has", () => {
  it("the schema lists every kind, so none is unreachable", () => {
    const sys = stepsSystemPrompt();
    for (const kind of ASSERT_KINDS) {
      expect(sys, `${kind} is missing from the prompt's schema`).toContain(`"${kind}"`);
    }
  });

  it("every kind the prompt offers survives the validator", () => {
    // THE BUG, stated directly. The prompt is the contract; the validator is
    // what enforces it. A kind in one and not the other is a step that vanishes.
    const emitted = ASSERT_KINDS.map((kind) => ({
      type: "assert",
      assert: kind,
      value: "x",
      text: "x",
      attr: "data-x",
      count: 1,
      cssProp: "color",
      locator: { k: "testid", v: "t" },
    }));
    const parsed = extractStepsJson("```json\n" + JSON.stringify(emitted) + "\n```");
    expect(parsed, "the response should parse").not.toBeNull();
    expect(parsed!.map((s) => s.assert)).toEqual(ASSERT_KINDS);
  });

  it("states the match rule for each page-level kind, from the shared table", () => {
    const sys = stepsSystemPrompt();
    // `title` exact vs `titleContains` substring is the distinction the whole
    // branch turns on; a prompt that omits it recreates the original bug.
    expect(sys).toMatch(/"title":[^\n]*exactly/);
    expect(sys).toMatch(/"titleContains":[^\n]*ANYWHERE/);
    expect(sys).toMatch(/"url":[^\n]*ANYWHERE/);
    expect(sys).toMatch(/"urlEndsWith":[^\n]*END/);
    // And the case rules come from the table rather than being asserted here.
    expect(sys).toContain(ASSERT_SEMANTICS.url!.caseSensitive ? "case-sensitive" : "ignoring case");
  });

  it("warns that an empty expected value is refused", () => {
    expect(stepsSystemPrompt()).toMatch(/EMPTY expected value is refused/i);
  });
});

describe("the model can name which test-id attribute it means", () => {
  it("the prompt offers attr and the validator carries it through", () => {
    // The prompt gained "a testid locator may add attr" with the test-id
    // attribute work; the validator did not, so an attr the model emitted was
    // silently stripped and the step resolved by data-testid — the wrong
    // element or none, with nothing saying why.
    const sys = stepsSystemPrompt();
    expect(sys).toContain('"attr"');
    const parsed = extractStepsJson(
      '```json\n[{"type":"click","locator":{"k":"testid","v":"save","attr":"data-test-id"}}]\n```',
    );
    expect(parsed, "the response should parse").not.toBeNull();
    expect(parsed![0].locator?.attr).toBe("data-test-id");
  });
});

describe("the model can express element context", () => {
  it("the prompt describes ctx and the validator carries it through", () => {
    // Same drift rule as the assert kinds: the prompt is the contract, the
    // validator is what enforces it. `ctx` lived in the Locator model, the
    // generator and normalizeLocator, but in neither the prompt nor the
    // validator — so "the Save button inside the Billing dialog" had no
    // expressible answer, and a ctx the model emitted anyway vanished silently.
    const sys = stepsSystemPrompt();
    for (const field of ['"ctx"', '"within"', '"withinHasText"', '"and"']) {
      expect(sys, `${field} is missing from the prompt's schema`).toContain(field);
    }
    const emitted = [
      {
        type: "click",
        locator: {
          k: "role",
          role: "button",
          name: "Save",
          ctx: {
            within: { k: "role", role: "dialog", name: "Billing" },
            withinHasText: "Pro plan",
            and: [{ k: "css", v: ".primary" }],
          },
        },
      },
    ];
    const parsed = extractStepsJson("```json\n" + JSON.stringify(emitted) + "\n```");
    expect(parsed, "the response should parse").not.toBeNull();
    expect(parsed![0].locator?.ctx).toEqual({
      within: { k: "role", role: "dialog", name: "Billing" },
      withinHasText: "Pro plan",
      and: [{ k: "css", v: ".primary" }],
    });
  });
});

describe("the model is shown the locator that actually ran", () => {
  it("renders .nth(k), which the generated spec contains", () => {
    expect(locatorToPrompt({ k: "text", v: "Save", nth: 3 })).toBe('getByText("Save").nth(3)');
  });

  it("keeps .nth(0) — index zero is a real index", () => {
    expect(locatorToPrompt({ k: "testid", v: "t", nth: 0 })).toBe('getByTestId("t").nth(0)');
  });

  it("omits it when there is none", () => {
    expect(locatorToPrompt({ k: "text", v: "Save" })).toBe('getByText("Save")');
  });

  // The pinned-context chain is the other half of the same bug: a step whose
  // spec line is a chained locator was shown to the model as the bare target —
  // a locator that matches MORE than the one that ran, and that hides the
  // clauses (the container, its hasText) whose failure is the commonest reason
  // such a step fails. Expected strings here are stated independently; the
  // exhaustive agreement with the generator is pinned by
  // main/services/__tests__/locator-prompt-parity.test.ts.
  it("renders the pinned container and its hasText filter, in emission order", () => {
    expect(
      locatorToPrompt({
        k: "role",
        role: "button",
        name: "Edit",
        ctx: { within: { k: "testid", v: "billing" }, withinHasText: "Billing" },
      }),
    ).toBe('getByTestId("billing").filter({ hasText: "Billing" }).getByRole("button", { name: "Edit" })');
  });

  it("renders .and() predicates with their page. prefix, as the spec spells them", () => {
    expect(
      locatorToPrompt({ k: "text", v: "Edit", ctx: { and: [{ k: "css", v: "[data-qa='edit']" }] } }),
    ).toBe('getByText("Edit").and(page.locator("[data-qa=\'edit\']"))');
  });

  it("keeps .nth(k) LAST, after the context chain — it indexes the narrowed set", () => {
    expect(
      locatorToPrompt({ k: "text", v: "Edit", nth: 1, ctx: { within: { k: "testid", v: "card" } } }),
    ).toBe('getByTestId("card").getByText("Edit").nth(1)');
  });

  it("ignores withinHasText with no container, as the generator does", () => {
    expect(locatorToPrompt({ k: "text", v: "Edit", ctx: { withinHasText: "Billing" } })).toBe(
      'getByText("Edit")',
    );
  });
});

describe("the trainer's own failure modes are in its prompt", () => {
  const sys = buildStepDebugMessages({
    testName: "t",
    url: "https://x.test",
    stepLabel: "Click Save",
    error: "Locator matched 2 elements (strict mode violation)",
    logs: [],
  })[0].content;

  it("knows an ambiguous locator matches too MUCH, not too little", () => {
    // Without this the only fitting cause is "the locator no longer matches the
    // page", whose fix — propose a different locator — is the inversion of the
    // truth. The trainer could not produce this error before this branch.
    expect(sys).toMatch(/strict mode violation/i);
    expect(sys).toMatch(/ambiguous/i);
  });

  it("says this error has no Playwright 'aka' alternatives to read", () => {
    // The run-level prompt tells the model to read the disambiguated locators
    // Playwright prints. The TRAINER's error has none, so copying that guidance
    // here would send the model looking for something that is not there.
    expect(sys).toMatch(/does NOT list|no.*aka|not from Playwright/i);
  });

  it("knows occlusion is not a race and not a locator problem", () => {
    expect(sys).toMatch(/covered by|on top of/i);
    expect(sys).toMatch(/intercepts pointer events/i);
    // The trap: toBeVisible() passes against a covered element.
    expect(sys).toMatch(/toBeVisible\(\) will PASS/i);
  });

  it("sends a covering banner to Handle pop-ups rather than to a new step", () => {
    // The prompt used to say "the fix is a step that dismisses ... it" — the
    // approach DECISIONS 2026-08-22 measured and rejected: a consent banner is
    // re-injected on every document and a marketing modal arrives mid-test, so
    // a click placed at one point in the step list is right until the next
    // navigation. The app's own advice must not steer the model there.
    expect(sys).toMatch(/Handle pop-ups/);
    expect(sys).not.toMatch(/a step that dismisses/i);
  });

  it("explains a zero match count on an indexed locator", () => {
    expect(sys).toMatch(/\.nth\(k\)/);
    expect(sys).toMatch(/fewer than/i);
  });
});

describe("the app tells the truth about what it can supply", () => {
  const ctx = {
    testName: "t",
    testUrl: "https://x.test",
    script: "s",
    output: "o",
    imported: false,
  };

  it("names page structure in the privacy strip when it is offered", () => {
    // The strip is a privacy affordance, and it never mentioned the payload
    // that carries page-authored DOM: ids, class names, aria-labels, text.
    const labels = describeSending({ ...ctx, structureAvailable: true }).map((i) => i.label);
    expect(labels.join(" ")).toMatch(/page structure/i);
  });

  it("does not name it when it is not offered", () => {
    const labels = describeSending({ ...ctx, structureAvailable: false }).map((i) => i.label);
    expect(labels.join(" ")).not.toMatch(/page structure/i);
  });

  it("tells the model the trace path in the output is already gone", () => {
    // `trace: retain-on-failure` is set for hand-runs, and the app deletes its
    // own scratch dir — so Playwright's "Error Context: …trace.zip" line points
    // at a file that no longer exists by the time the model reads it.
    const sys = buildDebugMessages(ctx)[0].content;
    expect(sys).toMatch(/trace\.zip/);
    expect(sys).toMatch(/no longer exists|already gone/i);
  });

  it("states the toHaveURL argument-shape convention", () => {
    // The one convention this branch changed, and the commonest mistake made
    // against this app's specs.
    const sys = buildDebugMessages(ctx)[0].content;
    expect(sys).toMatch(/toHaveURL\("\/cart"\) is an EXACT/);
    expect(sys).toMatch(/unanchored RegExp/i);
  });
});
