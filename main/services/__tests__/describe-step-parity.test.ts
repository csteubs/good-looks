// Parity between the two copies of describeStep.
//
// `main/services/script-generator.ts` and `renderer/lib/describe-step.ts` each
// implement describeStep. They must agree: the backend's version labels steps
// in persisted DebugEntries, replay logs and batch results, while the
// renderer's labels the same steps in the trainer's step list. When they drift,
// the same step is called two different things in two places — nothing throws,
// no test fails, the UI just quietly contradicts itself.
//
// The duplication is deliberate (the renderer can't import backend modules) and
// documented in both files as "keep in sync". This is what makes that comment
// enforceable — and it's live risk, not theoretical: cookie steps were added to
// both copies by hand in this session.
//
// Same reasoning as the app↔MCP batch-summary parity check.

import { describe, expect, it } from "vitest";

import { describeStep as backendDescribe } from "../script-generator.js";
import { describeStep as rendererDescribe } from "../../../renderer/lib/describe-step.js";
import type { Step, StepType } from "../../recorder/types.js";
import type { Step as RendererStep } from "../../../renderer/lib/recorder-types.js";

function step(partial: Partial<Step> & { type: StepType }): Step {
  return { id: "s", timestamp: 0, ...partial } as Step;
}

const LOCATOR = { k: "role", role: "button", name: "Submit" } as const;

/** One case per branch either implementation has. */
const cases: { label: string; step: Step }[] = [
  { label: "goto", step: step({ type: "goto", url: "https://example.com/x" }) },
  { label: "click", step: step({ type: "click", locator: LOCATOR }) },
  { label: "fill", step: step({ type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.c" }) },
  { label: "select", step: step({ type: "select", locator: { k: "testid", v: "s" }, value: "b" }) },
  { label: "check", step: step({ type: "check", locator: { k: "testid", v: "c" } }) },
  { label: "uncheck", step: step({ type: "uncheck", locator: { k: "testid", v: "c" } }) },
  { label: "press with locator", step: step({ type: "press", locator: LOCATOR, value: "Enter" }) },
  { label: "press without locator", step: step({ type: "press", value: "Escape" }) },
  { label: "wait ms", step: step({ type: "wait", waitMs: 500 }) },
  { label: "wait for locator", step: step({ type: "wait", locator: LOCATOR }) },
  { label: "viewport", step: step({ type: "viewport", width: 1024, height: 768 }) },
  { label: "endif", step: step({ type: "endif" }) },
  // Cookie steps — added to both copies by hand this session.
  {
    label: "cookie set",
    step: step({
      type: "cookie",
      cookieAction: "set",
      cookie: { name: "session", value: "abc", domain: "example.com", path: "/" },
    }),
  },
  {
    label: "cookie set without domain",
    step: step({ type: "cookie", cookieAction: "set", cookie: { name: "s", value: "1" } }),
  },
  {
    label: "cookie delete",
    step: step({ type: "cookie", cookieAction: "delete", cookie: { name: "session" } }),
  },
  { label: "cookie clearAll", step: step({ type: "cookie", cookieAction: "clearAll" }) },
  // Malformed on purpose: both sides must degrade the same way rather than one
  // throwing and the other printing "undefined".
  { label: "cookie with no cookie payload", step: step({ type: "cookie", cookieAction: "set" }) },
];

// Every assert kind, since assertLine is the branchiest part of both files.
const ASSERTS = [
  "visible",
  "hidden",
  "text",
  "exactText",
  "enabled",
  "disabled",
  "checked",
  "unchecked",
  "value",
  "attribute",
  "count",
  "url",
  "urlEndsWith",
  "urlIs",
  "title",
] as const;

for (const a of ASSERTS) {
  cases.push({
    label: `assert ${a}`,
    step: step({
      type: "assert",
      assert: a,
      locator: LOCATOR,
      text: "some text",
      value: "expected",
      attr: "data-x",
      count: 2,
    }),
  });
  cases.push({
    label: `assert ${a} (soft)`,
    step: step({
      type: "assert",
      assert: a,
      locator: LOCATOR,
      soft: true,
      text: "some text",
      value: "expected",
      attr: "data-x",
      count: 2,
    }),
  });
}

// Every condition kind, for `if` steps.
const CONDITIONS = [
  "visible",
  "hidden",
  "exists",
  "enabled",
  "disabled",
  "checked",
  "unchecked",
  "urlContains",
  "titleContains",
] as const;

for (const c of CONDITIONS) {
  cases.push({
    label: `if ${c}`,
    step: step({ type: "if", cond: c, locator: LOCATOR, value: "substring" }),
  });
}

describe("describeStep parity (backend ↔ renderer)", () => {
  for (const c of cases) {
    it(`agrees on: ${c.label}`, () => {
      const backend = backendDescribe(c.step);
      const renderer = rendererDescribe(c.step as unknown as RendererStep);
      expect(renderer).toBe(backend);
    });
  }

  it("covers every step type", () => {
    // Guards the check itself: a new StepType added without a case here would
    // otherwise leave the parity untested for it.
    const covered = new Set(cases.map((c) => c.step.type));
    const ALL: StepType[] = [
      "goto",
      "click",
      "fill",
      "press",
      "select",
      "check",
      "uncheck",
      "assert",
      "wait",
      "viewport",
      "if",
      "endif",
      "cookie",
    ];
    expect([...ALL].filter((t) => !covered.has(t))).toEqual([]);
  });
});
