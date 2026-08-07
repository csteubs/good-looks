// Standalone regression check for spec-parser.ts's round-trip fidelity
// against script-generator.ts's vocabulary. No test runner exists in this
// project (see package.json) — plain assertions + a non-zero exit code on
// failure stand in for one. Run with:
//   npx tsx main/services/__tests__/spec-parser.check.ts

import { generateSpec } from "../script-generator.js";
import { parseSpec, parseSpecDetailed } from "../spec-parser.js";
import type { Step } from "../../recorder/types.js";

let failures = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: "s", timestamp: 0, ...partial } as Step;
}

// ── 1. Round-trip: 7 recorded steps -> script -> re-parsed steps ──────────
const sevenSteps: Step[] = [
  step({ type: "goto", url: "https://example.com" }),
  step({ type: "click", locator: { k: "role", role: "button", name: "Sign in" } }),
  step({ type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.com" }),
  step({ type: "fill", locator: { k: "label", v: "Password" }, value: "hunter2" }),
  step({ type: "check", locator: { k: "testid", v: "remember-me" } }),
  step({ type: "click", locator: { k: "role", role: "button", name: "Submit" } }),
  step({ type: "assert", locator: { k: "text", v: "Welcome" }, assert: "visible" }),
];
const baseSource = generateSpec({ name: "login", url: "https://example.com", steps: sevenSteps });
assertEqual(parseSpec(baseSource).length, 7, "round-trips the base 7-step script");

// ── 2. The actual regression: splice in two `page.waitForTimeout(...)` calls
// the way an approved LLM debug diff would, and confirm the resync sees all
// 9 steps (previously it silently stayed at 7 — the bug this fix targets). ──
const lines = baseSource.split("\n");
const signInIdx = lines.findIndex((l) => l.includes("Sign in"));
lines.splice(signInIdx + 1, 0, "  await page.waitForTimeout(500);");
const submitIdx = lines.findIndex((l) => l.includes("Submit"));
lines.splice(submitIdx + 1, 0, "  await page.waitForTimeout(1000);");
const patched = parseSpecDetailed(lines.join("\n"));
assertEqual(patched.steps.length, 9, "resyncs to 9 steps after an LLM-style wait-call diff");
assertEqual(patched.skipped, 0, "recognized waitForTimeout calls aren't counted as skipped");
const waitSteps = patched.steps.filter((s) => s.type === "wait");
assertEqual(waitSteps.length, 2, "both inserted wait steps are recognized");
assertEqual(
  waitSteps.map((s) => s.waitMs).sort((a, b) => (a ?? 0) - (b ?? 0)),
  [500, 1000],
  "wait durations round-trip",
);

// ── 3. Extended assert/viewport/wait vocabulary round-trips ────────────────
const richSteps: Step[] = [
  step({ type: "viewport", width: 390, height: 844 }),
  step({ type: "wait", waitMs: 250 }),
  step({ type: "wait", locator: { k: "css", v: "#ready" } }),
  step({ type: "assert", locator: { k: "css", v: "#a" }, assert: "hidden" }),
  step({ type: "assert", locator: { k: "css", v: "#b" }, assert: "exactText", text: "Done" }),
  step({ type: "assert", locator: { k: "css", v: "#c" }, assert: "enabled" }),
  step({ type: "assert", locator: { k: "css", v: "#d" }, assert: "disabled" }),
  step({ type: "assert", locator: { k: "css", v: "#e" }, assert: "checked" }),
  step({ type: "assert", locator: { k: "css", v: "#f" }, assert: "unchecked" }),
  step({ type: "assert", locator: { k: "css", v: "#g" }, assert: "value", value: "42" }),
  step({ type: "assert", locator: { k: "css", v: "#h" }, assert: "attribute", attr: "data-x", value: "y" }),
  step({ type: "assert", locator: { k: "css", v: "#i" }, assert: "count", count: 3 }),
  step({ type: "assert", assert: "url", value: "https://example.com/done" }),
  step({ type: "assert", assert: "title", value: "Done" }),
  step({ type: "assert", locator: { k: "css", v: "#j" }, assert: "visible", soft: true }),
];
const richSource = generateSpec({ name: "rich", url: "https://example.com", steps: richSteps });
const richParsed = parseSpecDetailed(richSource);
assertEqual(richParsed.skipped, 0, "extended vocabulary produces zero skips");
assertEqual(richParsed.steps.length, richSteps.length, "extended vocabulary round-trips step count");
richSteps.forEach((expected, idx) => {
  const actual = richParsed.steps[idx];
  assertEqual(actual?.type, expected.type, `step ${idx} type (${expected.type})`);
  assertEqual(actual?.assert, expected.assert, `step ${idx} assert kind`);
});
assertEqual(richParsed.steps[4]?.text, "Done", "exactText assertion captures expected text");
assertEqual(richParsed.steps[9]?.value, "42", "value assertion captures expected value");
assertEqual(richParsed.steps[10]?.attr, "data-x", "attribute assertion captures attr name");
assertEqual(richParsed.steps[10]?.value, "y", "attribute assertion captures attr value");
assertEqual(richParsed.steps[11]?.count, 3, "count assertion captures expected count");
assertEqual(richParsed.steps[12]?.value, "https://example.com/done", "url assertion captures expected url");
assertEqual(richParsed.steps[13]?.value, "Done", "title assertion captures expected title");
assertEqual(richParsed.steps[14]?.soft, true, "soft assertion flag round-trips");

// ── 4. A genuinely unmappable statement is flagged, not silently dropped ──
const unmappable = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("weird", async ({ page }) => {',
  '  await page.goto("https://example.com");',
  "  await page.reload();",
  '  await page.getByRole("button", { name: "Go" }).hover();',
  "});",
  "",
].join("\n");
const unmappableParsed = parseSpecDetailed(unmappable);
assertEqual(unmappableParsed.steps.length, 1, "only the recognized goto is kept");
assertEqual(unmappableParsed.skipped, 2, "reload() and hover() are both counted as skipped");

// ── 5. Conditional (if/endif) logic blocks round-trip ─────────────────────
const condSteps: Step[] = [
  step({ type: "goto", url: "https://example.com" }),
  step({ type: "if", cond: "visible", locator: { k: "text", v: "Accept cookies" } }),
  step({ type: "click", locator: { k: "role", role: "button", name: "Accept" } }),
  step({ type: "endif" }),
  step({ type: "if", cond: "urlContains", value: "/checkout" }),
  step({ type: "assert", locator: { k: "css", v: "#total" }, assert: "visible" }),
  step({ type: "endif" }),
];
const condSource = generateSpec({ name: "cond", url: "https://example.com", steps: condSteps });
const condParsed = parseSpecDetailed(condSource);
assertEqual(condParsed.skipped, 0, "conditional blocks produce zero skips");
assertEqual(
  condParsed.steps.map((s) => s.type),
  condSteps.map((s) => s.type),
  "if/endif block structure round-trips",
);
assertEqual(condParsed.steps[1]?.cond, "visible", "element condition kind round-trips");
assertEqual(condParsed.steps[1]?.locator?.k, "text", "element condition locator round-trips");
assertEqual(condParsed.steps[4]?.cond, "urlContains", "page condition kind round-trips");
assertEqual(condParsed.steps[4]?.value, "/checkout", "page condition substring round-trips");
const clickLine = condSource.split("\n").find((l) => l.includes(".click()"));
assertEqual(clickLine?.startsWith("    "), true, "conditional body is indented one level deeper");

// ── 6. Nested + negated + count-based conditions round-trip ────────────────
const nestedCond: Step[] = [
  step({ type: "if", cond: "exists", locator: { k: "css", v: ".item" } }),
  step({ type: "if", cond: "unchecked", locator: { k: "testid", v: "agree" } }),
  step({ type: "check", locator: { k: "testid", v: "agree" } }),
  step({ type: "endif" }),
  step({ type: "if", cond: "titleContains", value: "Cart" }),
  step({ type: "click", locator: { k: "text", v: "Pay" } }),
  step({ type: "endif" }),
  step({ type: "endif" }),
];
const nestedSource = generateSpec({ name: "nested", url: "x", steps: nestedCond });
const nestedParsed = parseSpecDetailed(nestedSource);
assertEqual(nestedParsed.skipped, 0, "nested/negated conditions produce zero skips");
assertEqual(
  nestedParsed.steps.map((s) => s.type),
  nestedCond.map((s) => s.type),
  "nested if/endif structure round-trips",
);
assertEqual(nestedParsed.steps[0]?.cond, "exists", "exists condition round-trips");
assertEqual(nestedParsed.steps[1]?.cond, "unchecked", "unchecked (negated) condition round-trips");
assertEqual(nestedParsed.steps[4]?.cond, "titleContains", "titleContains condition round-trips");

// ── 7. "Continue on Failure" (try/catch wrapper) round-trips ───────────────
const cofSteps: Step[] = [
  step({ type: "goto", url: "https://example.com" }),
  step({ type: "click", locator: { k: "role", role: "button", name: "Maybe" }, continueOnFailure: true }),
  step({ type: "assert", locator: { k: "css", v: "#result" }, assert: "visible", continueOnFailure: true }),
  step({ type: "click", locator: { k: "role", role: "button", name: "Next" } }),
];
const cofSource = generateSpec({ name: "cof", url: "https://example.com", steps: cofSteps });
const cofParsed = parseSpecDetailed(cofSource);
assertEqual(cofParsed.skipped, 0, "continue-on-failure wrapper produces zero skips");
assertEqual(cofParsed.steps.length, cofSteps.length, "continue-on-failure round-trips step count");
assertEqual(cofParsed.steps[1]?.continueOnFailure, true, "click step continueOnFailure flag round-trips");
assertEqual(cofParsed.steps[2]?.continueOnFailure, true, "assert step continueOnFailure flag round-trips");
assertEqual(cofParsed.steps[3]?.continueOnFailure, undefined, "untoggled step has no continueOnFailure flag");
// The wrapper must actually be emitted in the source.
const tryLines = cofSource.split("\n").filter((l) => l.includes("try {"));
assertEqual(tryLines.length, 2, "two try/catch wrappers emitted for two toggled steps");

// ── 8. "Disable Step" (commented-out line) round-trips ──────────────────────
const disSteps: Step[] = [
  step({ type: "goto", url: "https://example.com" }),
  step({ type: "click", locator: { k: "role", role: "button", name: "Skip" }, disabled: true }),
  step({ type: "assert", locator: { k: "css", v: "#result" }, assert: "visible", disabled: true }),
  step({ type: "click", locator: { k: "role", role: "button", name: "Next" } }),
];
const disSource = generateSpec({ name: "dis", url: "https://example.com", steps: disSteps });
const disParsed = parseSpecDetailed(disSource);
assertEqual(disParsed.skipped, 0, "disabled comment produces zero skips");
assertEqual(disParsed.steps.length, disSteps.length, "disabled round-trips step count");
assertEqual(disParsed.steps[1]?.disabled, true, "click step disabled flag round-trips");
assertEqual(disParsed.steps[2]?.disabled, true, "assert step disabled flag round-trips");
assertEqual(disParsed.steps[3]?.disabled, undefined, "untoggled step has no disabled flag");
// The commented-out lines must actually be emitted in the source.
const disLines = disSource.split("\n").filter((l) => l.includes("// disabled — skipped:"));
assertEqual(disLines.length, 2, "two disabled comment lines emitted for two toggled steps");

// ── 9. Variables, capture steps and flow inlining round-trip ───────────────
//
// The failure mode being guarded is silent: a `${var}` reference that parses
// back as the literal text "V.email" still LOOKS like a valid step in the
// editor, and the next regeneration emits it as a quoted string — quietly
// un-parameterizing the test. Likewise, a `const V = {…}` header counted as an
// unclassifiable statement would set stepsDiverged on every parameterized test
// forever, training the user to ignore that warning.
const varVariables = [
  { name: "email", kind: "plain" as const, value: "a@b.com" },
  { name: "password", kind: "secret" as const },
  { name: "orderId", kind: "captured" as const },
];
const varSteps: Step[] = [
  step({ type: "goto", url: "https://example.com" }),
  step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${email}" }),
  step({ type: "fill", locator: { k: "label", v: "Password" }, value: "${password}" }),
  step({
    type: "capture",
    locator: { k: "testid", v: "order" },
    captureVar: "orderId",
    captureFrom: "text",
  }),
  step({ type: "capture", captureVar: "landed", captureFrom: "url" }),
  step({
    type: "capture",
    locator: { k: "testid", v: "link" },
    captureVar: "href",
    captureFrom: "attribute",
    captureAttr: "href",
  }),
  step({
    type: "assert",
    locator: { k: "testid", v: "conf" },
    assert: "text",
    text: "Order ${orderId} confirmed",
  }),
];
const varSource = generateSpec({
  name: "vars",
  url: "https://example.com",
  steps: varSteps,
  variables: varVariables,
});
const varParsed = parseSpecDetailed(varSource);
assertEqual(varParsed.skipped, 0, "the variable header and capture calls produce zero skips");
assertEqual(varParsed.steps.length, varSteps.length, "variables round-trip the step count");
assertEqual(varParsed.steps[1]?.value, "${email}", "a whole-value variable reference round-trips");
assertEqual(
  varParsed.steps[2]?.value,
  "${password}",
  "a secret variable reference round-trips (and never becomes its value)",
);
assertEqual(
  varParsed.steps[6]?.text,
  "Order ${orderId} confirmed",
  "an embedded variable reference inside surrounding text round-trips",
);
assertEqual(varParsed.steps[3]?.captureVar, "orderId", "capture target variable round-trips");
assertEqual(varParsed.steps[3]?.captureFrom, "text", "capture source round-trips");
assertEqual(
  varParsed.steps[3]?.locator,
  { k: "testid", v: "order" },
  "capture locator round-trips",
);
assertEqual(varParsed.steps[4]?.captureFrom, "url", "a page-level capture needs no locator");
assertEqual(varParsed.steps[5]?.captureAttr, "href", "capture attribute name round-trips");
// The secret's VALUE must never appear in the generated spec — only an env
// reference. This is the guarantee the whole secrets store exists to provide.
assertEqual(
  varSource.includes("process.env.GLAZE_SECRET_password"),
  true,
  "a secret is emitted as an env reference",
);

// A test with no variables must generate exactly what it always did — no
// header, no runtime import — so nothing about existing tests changes.
const plainSource = generateSpec({ name: "login", url: "https://example.com", steps: sevenSteps });
assertEqual(plainSource.includes("const V"), false, "a test with no variables emits no header");
assertEqual(
  plainSource.includes("glaze-runtime"),
  false,
  "a test with no capture step imports no runtime helper",
);
assertEqual(plainSource, baseSource, "a test with no variables generates byte-identical output");

// Flow inlining: the flow's steps appear in the caller, with the caller's
// argument bound in place of the flow's parameter.
const loginFlow = {
  id: "flow-1",
  name: "Login",
  flowParams: ["user"],
  variables: [{ name: "user", kind: "plain" as const, value: "fallback@x.com" }],
  steps: [
    step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${user}" }),
    step({ type: "click", locator: { k: "role", role: "button", name: "Log in" } }),
  ],
};
const callerSteps: Step[] = [
  step({ type: "goto", url: "https://example.com" }),
  step({ type: "runFlow", flowId: "flow-1", label: "Login", flowArgs: { user: "${email}" } }),
];
const flowSource = generateSpec(
  { name: "caller", url: "https://example.com", steps: callerSteps, variables: varVariables },
  { resolveFlow: (id) => (id === "flow-1" ? loginFlow : null) },
);
assertEqual(
  flowSource.includes('await page.getByLabel("Email").fill(V.email)'),
  true,
  "an inlined flow step binds the caller's argument, not the flow's default",
);
assertEqual(
  flowSource.includes('getByRole("button", { name: "Log in" }).click()'),
  true,
  "every step of an inlined flow is emitted",
);

// An unsupplied parameter falls back to the flow's own default rather than
// emitting an empty value — a silently blank login field is the worst outcome.
const noArgSource = generateSpec(
  {
    name: "caller",
    url: "https://example.com",
    steps: [step({ type: "runFlow", flowId: "flow-1", label: "Login" })],
  },
  { resolveFlow: (id) => (id === "flow-1" ? loginFlow : null) },
);
assertEqual(
  noArgSource.includes('fill("fallback@x.com")'),
  true,
  "an unsupplied flow parameter falls back to the flow's declared default",
);

// A flow that invokes itself must not expand forever.
const selfFlow = {
  id: "loop-1",
  name: "Loop",
  steps: [step({ type: "runFlow", flowId: "loop-1", label: "Loop" })],
};
const cycleSource = generateSpec(
  {
    name: "caller",
    url: "https://example.com",
    steps: [step({ type: "runFlow", flowId: "loop-1", label: "Loop" })],
  },
  { resolveFlow: (id) => (id === "loop-1" ? selfFlow : null) },
);
assertEqual(
  cycleSource.includes("circular reference"),
  true,
  "a self-referencing flow is refused with a visible comment, not infinite output",
);

// A flow the resolver can't find leaves a visible marker rather than silently
// dropping the call — a test that quietly skips its login still "passes".
const missingSource = generateSpec(
  {
    name: "caller",
    url: "https://example.com",
    steps: [step({ type: "runFlow", flowId: "gone", label: "Gone" })],
  },
  { resolveFlow: () => null },
);
assertEqual(
  missingSource.includes("flow Gone not found"),
  true,
  "a missing flow is reported in the spec, not silently dropped",
);

// ── 10. A resize step's log line is not mistaken for a step ───────────────
//
// script-generator emits `console.log(...)` after every `viewport` step. If the
// parser counted that as an unclassifiable statement, `skipped` would be
// non-zero and TestRecord.stepsDiverged would warn — permanently, on every test
// that resizes — that the steps undercount the script.
{
  const resizeSteps: Step[] = [
    step({ type: "viewport", width: 390, height: 844 }),
    step({ type: "goto", url: "https://example.com" }),
    step({ type: "click", locator: { k: "testid", v: "menu" } }),
    step({ type: "viewport", width: 1280, height: 800 }),
  ];
  const src = generateSpec({ name: "resize", url: "https://example.com", steps: resizeSteps });
  assertEqual(src.includes("console.log("), true, "the generator logs each resize");
  const parsed = parseSpecDetailed(src);
  assertEqual(parsed.skipped, 0, "a resize log line is not counted as a skipped statement");
  assertEqual(parsed.steps.length, 4, "a logged resize round-trips without extra steps");
  assertEqual(
    parsed.steps.map((s) => s.type),
    ["viewport", "goto", "click", "viewport"],
    "resize steps round-trip in order",
  );
  assertEqual(
    parsed.steps.filter((s) => s.type === "viewport").map((s) => [s.width, s.height]),
    [[390, 844], [1280, 800]],
    "both resize sizes round-trip",
  );
}

// A DISABLED resize is commented out as TWO lines (the resize and its log), and
// only the first carries a step. Counting the second as unclassifiable is the
// same false divergence warning by another route.
{
  const src = generateSpec({
    name: "disabled resize",
    url: "https://example.com",
    steps: [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "viewport", width: 390, height: 844, disabled: true }),
    ],
  });
  const parsed = parseSpecDetailed(src);
  assertEqual(parsed.skipped, 0, "a disabled resize's commented log line is not counted as skipped");
  assertEqual(parsed.steps.length, 2, "a disabled resize round-trips as one step");
  assertEqual(parsed.steps[1]?.disabled, true, "…and keeps its disabled flag");
}

// Continue-on-failure wraps BOTH lines in the try block.
{
  const src = generateSpec({
    name: "continue resize",
    url: "https://example.com",
    steps: [step({ type: "viewport", width: 390, height: 844, continueOnFailure: true })],
  });
  const parsed = parseSpecDetailed(src);
  assertEqual(parsed.skipped, 0, "a continue-on-failure resize produces no skips");
  assertEqual(parsed.steps.length, 1, "…and round-trips as exactly one step");
  assertEqual(parsed.steps[0]?.continueOnFailure, true, "…keeping its continue-on-failure flag");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll spec-parser checks passed");
