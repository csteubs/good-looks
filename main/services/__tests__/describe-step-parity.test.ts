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
import { ASSERT_KINDS, ELEMENT_STATES, STEP_TYPES } from "../../recorder/types.js";
import { COMPARE_OPS } from "../../../shared/step-semantics.mjs";
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
  { label: "reload", step: step({ type: "reload" }) },
  { label: "echo", step: step({ type: "echo", text: "order is ${orderId}" }) },
  { label: "echo with nothing to say", step: step({ type: "echo" }) },
  { label: "reload with a timeout", step: step({ type: "reload", timeoutMs: 30_000 }) },
  // `force` was in the generated call and NOT in the renderer's step list until
  // 2026-08-21, so a step the user had marked "skip actionability checks" read
  // on screen as an ordinary click. There was no case here to catch it.
  { label: "click forced", step: step({ type: "click", locator: LOCATOR, force: true }) },
  // The per-step timeout, on one action of each arity: no argument, one
  // argument, and the click that can carry `force` alongside it. The key ORDER
  // is part of what these pin — both copies must say `{ force: true, timeout: … }`.
  { label: "click with a timeout", step: step({ type: "click", locator: LOCATOR, timeoutMs: 15_000 }) },
  {
    label: "click forced with a timeout",
    step: step({ type: "click", locator: LOCATOR, force: true, timeoutMs: 15_000 }),
  },
  {
    label: "fill with a timeout",
    step: step({ type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.c", timeoutMs: 9000 }),
  },
  { label: "check with a timeout", step: step({ type: "check", locator: { k: "testid", v: "c" }, timeoutMs: 9000 }) },
  // A forged timeout must degrade to "no option" on BOTH sides rather than one
  // of them printing it into the step list.
  {
    label: "click with a forged timeout",
    step: step({ type: "click", locator: LOCATOR, timeoutMs: "5000); require(\"fs\")" as never }),
  },
  { label: "click with a negative timeout", step: step({ type: "click", locator: LOCATOR, timeoutMs: -1 }) },
  // Per-character fill, with and without a delay, and with the delay forged.
  {
    label: "fill sequential",
    step: step({ type: "fill", locator: { k: "label", v: "City" }, value: "Lon", typeMode: "sequential" }),
  },
  {
    label: "fill sequential with a delay",
    step: step({
      type: "fill",
      locator: { k: "label", v: "City" },
      value: "Lon",
      typeMode: "sequential",
      typeDelayMs: 40,
    }),
  },
  {
    label: "fill sequential with a delay and a timeout",
    step: step({
      type: "fill",
      locator: { k: "label", v: "City" },
      value: "Lon",
      typeMode: "sequential",
      typeDelayMs: 40,
      timeoutMs: 9000,
    }),
  },
  {
    label: "fill sequential with a forged delay",
    step: step({
      type: "fill",
      locator: { k: "label", v: "City" },
      value: "Lon",
      typeMode: "sequential",
      typeDelayMs: "40); require(\"fs\")" as never,
    }),
  },
  // A `press` step without a locator types wherever focus is, so it has no
  // timeout to give — both sides must drop it rather than one inventing an
  // option page.keyboard.press does not have.
  { label: "press without locator, with a timeout", step: step({ type: "press", value: "Escape", timeoutMs: 9000 }) },
  { label: "wait ms", step: step({ type: "wait", waitMs: 500 }) },
  { label: "wait for locator", step: step({ type: "wait", locator: LOCATOR }) },
  { label: "viewport", step: step({ type: "viewport", width: 1024, height: 768 }) },
  { label: "endif", step: step({ type: "endif" }) },
  { label: "else", step: step({ type: "else" }) },
  { label: "loop", step: step({ type: "loop", loopCount: 4 }) },
  { label: "loop with no count", step: step({ type: "loop" }) },
  { label: "endLoop", step: step({ type: "endLoop" }) },
  { label: "ai check", step: step({ type: "aiCheck", text: "the cart badge shows 3" }) },
  { label: "ai check with no claim", step: step({ type: "aiCheck" }) },
  { label: "group", step: step({ type: "group", label: "Log in" }) },
  { label: "group with no label", step: step({ type: "group" }) },
  { label: "endGroup", step: step({ type: "endGroup" }) },
  { label: "teardown", step: step({ type: "teardown" }) },
  { label: "dialog accept with text", step: step({ type: "dialog", dialogAction: "accept", value: "Jane" }) },
  { label: "dialog dismiss", step: step({ type: "dialog", dialogAction: "dismiss" }) },
  { label: "dialog with no action", step: step({ type: "dialog" }) },
  { label: "a11y gate", step: step({ type: "a11y", a11yImpact: "critical" }) },
  { label: "a11y gate default impact", step: step({ type: "a11y" }) },
  // Malformed on purpose: both sides must fall back to "serious" identically.
  { label: "a11y gate with forged impact", step: step({ type: "a11y", a11yImpact: "nope" as never }) },
  {
    label: "upload",
    step: step({ type: "upload", locator: { k: "testid", v: "f" }, value: "uploads/t/report.csv" }),
  },
  // Malformed on purpose: no value — both sides must degrade identically.
  { label: "upload with no file", step: step({ type: "upload", locator: { k: "testid", v: "f" } }) },
  {
    label: "api full",
    step: step({
      type: "api",
      apiMethod: "POST",
      url: "https://api.example.com/users",
      expectStatus: 201,
      captureVar: "userId",
    }),
  },
  { label: "api minimal", step: step({ type: "api", url: "https://x.test/health" }) },
  // Malformed on purpose: a forged method and an invalid capture name — both
  // sides must fall back the same way.
  {
    label: "api with forged fields",
    step: step({ type: "api", apiMethod: "YEET" as never, url: "u", captureVar: "not a name" }),
  },
  {
    label: "capture count",
    step: step({ type: "capture", captureVar: "results", captureFrom: "count", locator: LOCATOR }),
  },
  { label: "download, any", step: step({ type: "download" }) },
  { label: "download containing", step: step({ type: "download", value: "report.csv" }) },
  {
    label: "download exact + capture",
    step: step({ type: "download", value: "a.pdf", downloadMatch: "exact", captureVar: "got" }),
  },
  {
    label: "download with an invalid capture name stays silent about it",
    step: step({ type: "download", value: "a.pdf", captureVar: "not a name" }),
  },
  // capture/runFlow were never covered here: the old hand-written step-type
  // guard omitted them, so nothing said so. Both are described by a PHRASE
  // rather than by the generated call, which is exactly the shape that drifts.
  {
    label: "capture text",
    step: step({ type: "capture", captureVar: "sku", captureFrom: "text", locator: LOCATOR }),
  },
  {
    label: "capture attribute",
    step: step({
      type: "capture",
      captureVar: "href",
      captureFrom: "attribute",
      captureAttr: "href",
      locator: LOCATOR,
    }),
  },
  { label: "capture url", step: step({ type: "capture", captureVar: "u", captureFrom: "url" }) },
  {
    label: "runFlow with args",
    step: step({ type: "runFlow", flowId: "f1", label: "Login", flowArgs: { user: "a@b.c" } }),
  },
  { label: "runFlow without args", step: step({ type: "runFlow", flowId: "f1", label: "Login" }) },
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
  // Scroll: the element form reads like the emitted line, the position form is
  // a phrase (the emitted glazeScrollTo(...) names the mechanism, not the
  // intent). Both sides must say the same thing either way.
  { label: "scroll to element", step: step({ type: "scroll", locator: LOCATOR }) },
  { label: "scroll to position", step: step({ type: "scroll", scrollX: 0, scrollY: 1240 }) },
  // Malformed on purpose, same rule as the cookie above.
  { label: "scroll with neither form", step: step({ type: "scroll" }) },
];

// Every assert kind, since assertLine is the branchiest part of both files.
//
// DERIVED from ASSERT_KINDS, not retyped. The hand-written list this replaced
// looked like it covered everything and had no way to say otherwise — the
// "covers every step type" guard below had silently fallen two step types
// behind for the same reason. A list that must be remembered is not a guard.
const ASSERTS = ASSERT_KINDS;

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
      cssProp: "background-color",
      count: 2,
    }),
  });
  cases.push({
    label: `assert ${a} (with a timeout)`,
    step: step({
      type: "assert",
      assert: a,
      locator: LOCATOR,
      timeoutMs: 7500,
      text: "some text",
      value: "expected",
      attr: "data-x",
      cssProp: "background-color",
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
      cssProp: "background-color",
      count: 2,
    }),
  });
}

// The `css` assert takes a second axis the loop above can't express, and both
// arms matter: `contains` compiles to a RegExp on both sides, and a css assert
// with NO property must degrade identically rather than one side printing
// `toHaveCSS("", …)` and the other bailing out.
cases.push({
  label: "assert css (contains)",
  step: step({
    type: "assert",
    assert: "css",
    locator: LOCATOR,
    cssProp: "font-family",
    cssMatch: "contains",
    value: "Helvetica Neue",
  }),
});
cases.push({
  label: "assert css with no property",
  step: step({ type: "assert", assert: "css", locator: LOCATOR, value: "red" }),
});

// Every comparison operator, on BOTH the `variable` assert and the `variable`
// condition. They are the same claim in two places, and describing them
// differently is how a user comes to believe they mean different things.
//
// DERIVED from COMPARE_OPS, not retyped — the same argument as ASSERT_KINDS
// above: a list that must be remembered is not a guard.
for (const op of COMPARE_OPS) {
  cases.push({
    label: `assert variable ${op}`,
    step: step({ type: "assert", assert: "variable", captureVar: "orderTotal", compareOp: op, value: "49.99" }),
  });
  cases.push({
    label: `if variable ${op}`,
    step: step({ type: "if", cond: "variable", captureVar: "orderTotal", compareOp: op, value: "49.99" }),
  });
}
// Degenerate shapes: no variable chosen, no operator chosen, a forged one.
// Both sides must degrade identically rather than one throwing and the other
// printing "undefined".
cases.push({
  label: "assert variable with no name or operator",
  step: step({ type: "assert", assert: "variable", value: "49.99" }),
});
cases.push({
  label: "assert variable with a forged operator",
  step: step({ type: "assert", assert: "variable", captureVar: "x", compareOp: "nope" as never, value: "1" }),
});

// Every pseudo-state. `press`/`release` carry no locator on purpose, and that
// is exactly the case where the two copies could disagree about what to print.
for (const s of ELEMENT_STATES) {
  cases.push({
    label: `state ${s}`,
    step: step({
      type: "state",
      elementState: s,
      ...(s === "press" || s === "release" ? {} : { locator: LOCATOR }),
    }),
  });
}
cases.push({
  label: "state hover with no locator",
  step: step({ type: "state", elementState: "hover" }),
});

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
  "variable",
] as const;

for (const c of CONDITIONS) {
  cases.push({
    label: `if ${c}`,
    step: step({ type: "if", cond: c, locator: LOCATOR, value: "substring" }),
  });
}

// Every wait-until predicate. Conditional waits are described by a PHRASE
// rather than by the generated call (which carries the `// wait until` parser
// marker and a `{ timeout: … }` object), so the two copies can drift in wording
// with nothing else to catch it.
const WAIT_UNTILS = [
  "visible",
  "hidden",
  "exists",
  "enabled",
  "disabled",
  "checked",
  "unchecked",
  "text",
  "value",
  "count",
  "urlContains",
  "titleContains",
] as const;

for (const w of WAIT_UNTILS) {
  cases.push({
    label: `wait until ${w}`,
    step: step({
      type: "wait",
      waitUntil: w,
      locator: LOCATOR,
      text: "some text",
      value: "expected",
      count: 2,
      timeoutMs: 4500,
    }),
  });
  // With no explicit timeout each side falls back to its OWN copy of the
  // default (the backend's constant, the renderer's mirror of it). This case is
  // what pins those two numbers together — the phrasing quotes the timeout, so
  // a drift shows up as a mismatched string rather than as nothing at all.
  cases.push({
    label: `wait until ${w} (default timeout)`,
    step: step({ type: "wait", waitUntil: w, locator: LOCATOR, text: "t", value: "v", count: 1 }),
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
    //
    // Derived from STEP_TYPES rather than retyped. The hand-written list this
    // replaced had gone stale without failing — `capture` and `runFlow` were
    // both missing from it, so the guard had been passing while guarding
    // nothing for two step types. A guard you have to remember to update is the
    // same class of bug it exists to catch.
    const covered = new Set(cases.map((c) => c.step.type));
    expect(STEP_TYPES.filter((t) => !covered.has(t))).toEqual([]);
  });

  it("covers every assert kind", () => {
    const covered = new Set(
      cases.filter((c) => c.step.type === "assert").map((c) => c.step.assert),
    );
    expect(ASSERT_KINDS.filter((a) => !covered.has(a))).toEqual([]);
  });

  it("covers every element state", () => {
    const covered = new Set(
      cases.filter((c) => c.step.type === "state").map((c) => c.step.elementState),
    );
    expect(ELEMENT_STATES.filter((s) => !covered.has(s))).toEqual([]);
  });
});
