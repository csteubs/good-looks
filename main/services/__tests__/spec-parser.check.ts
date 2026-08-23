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
  // `urlPathIs` emits a STRUCTURAL pattern (`^scheme://host` + path + `/?` +
  // `(?:[?#]|$)`), which ends in `$` like an exact match — so without its own
  // parser branch it would round-trip as `urlIs` carrying the raw pattern, and
  // the next regeneration would escape the escapes. The dotted value pins that
  // the middle is un-escaped on the way back.
  step({ type: "assert", assert: "urlPathIs", value: "/products/synbiotic-2.0" }),
  // The site root: the pattern spells "/" as an empty middle, so parsing it
  // back must restore the "/" rather than storing an empty value the
  // generator refuses to re-emit.
  step({ type: "assert", assert: "urlPathIs", value: "/" }),
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
assertEqual(richParsed.steps[13]?.assert, "urlPathIs", "urlPathIs is not misread as urlIs");
assertEqual(richParsed.steps[13]?.value, "/products/synbiotic-2.0", "urlPathIs un-escapes its path on the way back");
assertEqual(richParsed.steps[14]?.value, "/", "a root urlPathIs restores the slash its pattern spells as nothing");
assertEqual(richParsed.steps[15]?.value, "Done", "title assertion captures expected title");
assertEqual(richParsed.steps[16]?.soft, true, "soft assertion flag round-trips");

// ── 4. A genuinely unmappable statement is flagged, not silently dropped ──
//
// Two statements have graduated OUT of this section, and the graduations are
// the point: `.hover()` became a `state` step, and `page.reload()` became a
// `reload` step (2026-08-21). Each time, this check went red rather than
// quietly keeping a stale example — which is what it is for. `page.goBack()`
// is the current stand-in: a real Playwright call with no counterpart in the
// step model, so it must be COUNTED as a skip rather than vanishing.
const unmappable = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("weird", async ({ page }) => {',
  '  await page.goto("https://example.com");',
  "  await page.goBack();",
  '  await page.getByRole("button", { name: "Go" }).hover();',
  "});",
  "",
].join("\n");
const unmappableParsed = parseSpecDetailed(unmappable);
assertEqual(unmappableParsed.steps.length, 2, "the goto and the hover are both kept");
assertEqual(unmappableParsed.skipped, 1, "only goBack() is counted as skipped");
assertEqual(unmappableParsed.steps[1]?.type, "state", "hover() parses as a state step");
assertEqual(unmappableParsed.steps[1]?.elementState, "hover", "hover() keeps its state");

// And the half that used to live here: a reload IS a step now, and reads back
// as one rather than as a skip.
const reloadParsed = parseSpecDetailed(
  [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("reload", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    "  await page.reload();",
    "});",
    "",
  ].join("\n"),
);
assertEqual(reloadParsed.steps.map((s) => s.type).join(","), "goto,reload", "reload() is a step");
assertEqual(reloadParsed.skipped, 0, "…and is not counted as a skip");

// A NESTED page call nobody round-trips must still be COUNTED. Before the
// fallback learned about dotted paths, `page.mouse.move(...)` matched no branch
// and no fallback: the scan walked it character by character and it produced
// neither a step nor a skip, so it vanished on the next resync with nothing
// saying so. A miscount is visible; a disappearance is not.
const nestedUnmappable = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("nested", async ({ page }) => {',
  '  await page.goto("https://example.com");',
  "  await page.mouse.move(10, 20);",
  "});",
  "",
].join("\n");
const nestedCallParsed = parseSpecDetailed(nestedUnmappable);
assertEqual(nestedCallParsed.steps.length, 1, "only the recognized goto is kept (nested call)");
assertEqual(nestedCallParsed.skipped, 1, "an unrecognized nested page call is counted as skipped");

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

// ── 10. Conditional waits ("Wait until") round-trip as WAITS, not asserts ──
//
// This is the section the whole `// wait until` marker exists for. Playwright's
// only auto-retrying primitive for most of these predicates IS `expect`, so a
// conditional wait and the matching assertion compile to the same call. Without
// the marker every wait comes back from a script edit as an assertion — the
// step's type changing under the user, with nothing on screen to say so.
const WAIT_UNTIL_CASES: { label: string; step: Step }[] = [
  { label: "visible", step: step({ type: "wait", waitUntil: "visible", locator: { k: "css", v: "#a" }, timeoutMs: 10000 }) },
  { label: "hidden", step: step({ type: "wait", waitUntil: "hidden", locator: { k: "css", v: "#b" }, timeoutMs: 10000 }) },
  { label: "exists", step: step({ type: "wait", waitUntil: "exists", locator: { k: "css", v: "#c" }, timeoutMs: 10000 }) },
  { label: "enabled", step: step({ type: "wait", waitUntil: "enabled", locator: { k: "css", v: "#d" }, timeoutMs: 10000 }) },
  { label: "disabled", step: step({ type: "wait", waitUntil: "disabled", locator: { k: "css", v: "#e" }, timeoutMs: 10000 }) },
  { label: "checked", step: step({ type: "wait", waitUntil: "checked", locator: { k: "css", v: "#f" }, timeoutMs: 10000 }) },
  { label: "unchecked", step: step({ type: "wait", waitUntil: "unchecked", locator: { k: "css", v: "#g" }, timeoutMs: 10000 }) },
  { label: "text", step: step({ type: "wait", waitUntil: "text", locator: { k: "css", v: "#h" }, text: "Ready", timeoutMs: 10000 }) },
  { label: "value", step: step({ type: "wait", waitUntil: "value", locator: { k: "css", v: "#i" }, value: "42", timeoutMs: 10000 }) },
  { label: "count", step: step({ type: "wait", waitUntil: "count", locator: { k: "css", v: "#j" }, count: 3, timeoutMs: 10000 }) },
  // The two page predicates embed their expected text in a RegExp, so they also
  // pin that the generator's reEscape is undone on the way back — otherwise
  // "example.com" round-trips as "example\.com" and the escaping compounds on
  // every regeneration.
  { label: "urlContains", step: step({ type: "wait", waitUntil: "urlContains", value: "example.com/checkout", timeoutMs: 10000 }) },
  { label: "titleContains", step: step({ type: "wait", waitUntil: "titleContains", value: "Order (1)", timeoutMs: 10000 }) },
];

for (const c of WAIT_UNTIL_CASES) {
  const src = generateSpec({ name: "w", url: "https://example.com", steps: [c.step] });
  const parsed = parseSpecDetailed(src);
  assertEqual(parsed.skipped, 0, `wait until ${c.label}: no skips`);
  assertEqual(parsed.steps.length, 1, `wait until ${c.label}: one step`);
  assertEqual(parsed.steps[0]?.type, "wait", `wait until ${c.label}: stays a WAIT, not an assert`);
  assertEqual(parsed.steps[0]?.waitUntil, c.step.waitUntil, `wait until ${c.label}: predicate round-trips`);
  assertEqual(parsed.steps[0]?.timeoutMs, 10000, `wait until ${c.label}: timeout round-trips`);
  // Regenerating from the parsed step must produce the same source. This is the
  // property that actually matters: `tests:updateScript` re-parses and then the
  // next edit regenerates, so any loss compounds silently across saves.
  const reparsed = generateSpec({
    name: "w",
    url: "https://example.com",
    steps: [{ ...parsed.steps[0] } as Step],
  });
  assertEqual(reparsed, src, `wait until ${c.label}: regenerates byte-identically`);
}

// The operands survive, not just the predicate.
{
  const withText = generateSpec({
    name: "w",
    url: "https://example.com",
    steps: [step({ type: "wait", waitUntil: "text", locator: { k: "css", v: "#h" }, text: "Ready" })],
  });
  assertEqual(parseSpec(withText)[0]?.text, "Ready", "a text operand round-trips onto the wait");
  const withCount = generateSpec({
    name: "w",
    url: "https://example.com",
    steps: [step({ type: "wait", waitUntil: "count", locator: { k: "css", v: "#j" }, count: 7 })],
  });
  assertEqual(parseSpec(withCount)[0]?.count, 7, "a count operand round-trips onto the wait");
  const urlWait = generateSpec({
    name: "w",
    url: "https://example.com",
    steps: [step({ type: "wait", waitUntil: "urlContains", value: "example.com/checkout" })],
  });
  assertEqual(
    parseSpec(urlWait)[0]?.value,
    "example.com/checkout",
    "a page-level substring is un-escaped back to what the user typed",
  );
}

// The other half of the contract: an expect with NO marker is still an
// assertion. If this ever flips, every hand-written assertion in an imported
// spec silently becomes a wait.
{
  const asserted = generateSpec({
    name: "a",
    url: "https://example.com",
    steps: [step({ type: "assert", locator: { k: "css", v: "#a" }, assert: "enabled" })],
  });
  assertEqual(asserted.includes("// wait until"), false, "a plain assertion carries no marker");
  const parsed = parseSpec(asserted);
  assertEqual(parsed[0]?.type, "assert", "an unmarked expect stays an assertion");
  assertEqual(parsed[0]?.waitUntil, undefined, "…with no wait predicate attached");
}

// A hand-written marker on a predicate that has no wait counterpart must not
// invent one — `exactText`/`attribute` are assertions only.
{
  const handWritten = [
    'import { test, expect } from "@playwright/test";',
    'test("t", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    '  await expect(page.locator("#a")).toHaveText("Done"); // wait until',
    "});",
  ].join("\n");
  const parsed = parseSpec(handWritten);
  const nonGoto = parsed.filter((s) => s.type !== "goto");
  assertEqual(nonGoto[0]?.type, "assert", "a marker on exactText stays an assertion");
}

// ── 11. `.waitFor({ state })` carries its state back ───────────────────────
//
// The regression this fixes was silent and inverted: a wait-for-HIDDEN parsed
// as a bare wait, which regenerates as `.waitFor()` — wait for VISIBLE.
{
  const hiddenSrc = generateSpec({
    name: "h",
    url: "https://example.com",
    steps: [step({ type: "wait", waitUntil: "hidden", locator: { k: "testid", v: "spinner" } })],
  });
  assertEqual(
    hiddenSrc.includes('state: "hidden"'),
    true,
    "a hidden wait generates the native waitFor state",
  );
  const back = parseSpec(hiddenSrc).filter((s) => s.type === "wait");
  assertEqual(back[0]?.waitUntil, "hidden", "…and parses back as hidden, not as a plain wait");
  assertEqual(
    generateSpec({ name: "h", url: "https://example.com", steps: [back[0]] }).includes('state: "hidden"'),
    true,
    "…so regenerating does not invert it to a visible wait",
  );
}

// A bare `.waitFor()` (what the app emitted before conditional waits, and what
// sits in every test recorded until now) still parses as a plain wait.
{
  const plain = generateSpec({
    name: "p",
    url: "https://example.com",
    steps: [step({ type: "wait", locator: { k: "testid", v: "x" } })],
  });
  assertEqual(plain.includes(".waitFor();"), true, "a legacy element wait is unchanged");
  const back = parseSpec(plain).filter((s) => s.type === "wait");
  assertEqual(back[0]?.waitUntil, undefined, "…and carries no invented predicate");
}

// `detached` has no counterpart in the step model. Modeling it as a plain wait
// would regenerate as a wait-for-VISIBLE, so it is reported unclassified
// instead — which surfaces to the user as stepsDiverged.
{
  const detached = [
    'import { test, expect } from "@playwright/test";',
    'test("t", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    '  await page.locator("#a").waitFor({ state: "detached" });',
    "});",
  ].join("\n");
  const parsed = parseSpecDetailed(detached);
  assertEqual(parsed.skipped, 1, "a detached wait is reported as unclassified");
  assertEqual(
    parsed.steps.some((s) => s.type === "wait"),
    false,
    "…rather than becoming a wait that means the opposite",
  );
}

// ── 12. A disabled conditional wait keeps its predicate ────────────────────
//
// A disabled step is emitted as a commented-out line, and the marker rides
// along inside that comment. Both comment rules have to hold at once.
{
  const src = generateSpec({
    name: "d",
    url: "https://example.com",
    steps: [step({ type: "wait", waitUntil: "enabled", locator: { k: "css", v: "#a" }, timeoutMs: 3000, disabled: true })],
  });
  const parsed = parseSpec(src).filter((s) => s.type === "wait");
  assertEqual(parsed[0]?.waitUntil, "enabled", "a disabled conditional wait keeps its predicate");
  assertEqual(parsed[0]?.disabled, true, "…and stays disabled");
  assertEqual(parsed[0]?.timeoutMs, 3000, "…and keeps its timeout");
}

// ── 13. A resize step's log line is not mistaken for a step ───────────────
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

// ── 14. Resize logging and conditional waits, in one spec ─────────────────
//
// Neither feature's own section can catch this: they landed on separate
// branches and only meet here. A resize now emits TWO lines (the call and its
// `console.log`), and a conditional wait is recognized by a trailing comment on
// its own line — so an off-by-one in either walk would show up as a wait parsed
// as an assertion, or as a phantom `skipped` that flags every test doing both
// as diverged.
{
  const mixed: Step[] = [
    step({ type: "viewport", width: 390, height: 844 }),
    step({ type: "wait", waitUntil: "enabled", locator: { k: "css", v: "#pay" }, timeoutMs: 15000 }),
    step({ type: "viewport", width: 1280, height: 800 }),
    step({ type: "wait", waitUntil: "urlContains", value: "example.com/done", timeoutMs: 10000 }),
  ];
  const src = generateSpec({ name: "mix", url: "https://example.com", steps: mixed });
  const parsed = parseSpecDetailed(src);
  assertEqual(parsed.skipped, 0, "a resize next to a conditional wait produces no skips");
  assertEqual(
    parsed.steps.map((s) => s.type),
    ["viewport", "wait", "viewport", "wait"],
    "…and both step types survive interleaved",
  );
  assertEqual(
    parsed.steps.map((s) => s.waitUntil ?? null),
    [null, "enabled", null, "urlContains"],
    "…with each wait keeping its predicate across the resize log lines",
  );
}

// ── 15. CSS assertions and pseudo-state steps ─────────────────────────────
//
// The round trip is the whole risk here. A `css` assert and a `state` step both
// compile to calls that LOOK like several existing ones, and a resync
// (`tests:updateScript`, an applied AI fix) re-parses the whole spec — so a
// missed branch doesn't error, it changes the step under the user.
{
  const cssSteps: Step[] = [
    step({ type: "goto", url: "https://example.com" }),
    step({ type: "state", elementState: "hover", locator: { k: "role", role: "button", name: "Buy" } }),
    step({
      type: "assert",
      locator: { k: "role", role: "button", name: "Buy" },
      assert: "css",
      cssProp: "background-color",
      cssMatch: "is",
      value: "rgb(0, 82, 204)",
    }),
    step({ type: "state", elementState: "focus", locator: { k: "label", v: "Email" } }),
    step({
      type: "assert",
      locator: { k: "label", v: "Email" },
      assert: "css",
      // A value full of regex metacharacters, which is the normal case for CSS
      // — `rgb(…)`, `translate(-50%, 0)`, a quoted font stack. Unescaped, the
      // parens become capture groups and the pattern matches something else.
      cssProp: "box-shadow",
      cssMatch: "contains",
      value: "rgb(0, 0, 0) 0px 0px 0px 2px",
    }),
    step({ type: "state", elementState: "press" }),
    step({
      type: "assert",
      locator: { k: "css", v: "#buy" },
      assert: "css",
      cssProp: "transform",
      cssMatch: "is",
      value: "matrix(0.98, 0, 0, 0.98, 0, 0)",
      soft: true,
    }),
    step({ type: "state", elementState: "release" }),
  ];
  const src = generateSpec({ name: "css", url: "https://example.com", steps: cssSteps });
  const parsed = parseSpecDetailed(src);
  assertEqual(parsed.skipped, 0, "css asserts and state steps produce zero skips");
  assertEqual(
    parsed.steps.map((s) => s.type),
    ["goto", "state", "assert", "state", "assert", "state", "assert", "state"],
    "css/state vocabulary round-trips step types",
  );
  assertEqual(
    parsed.steps.map((s) => s.elementState ?? null),
    [null, "hover", null, "focus", null, "press", null, "release"],
    "…and every pseudo-state survives, including the locator-less pair",
  );
  assertEqual(
    parsed.steps.map((s) => s.cssProp ?? null),
    [null, null, "background-color", null, "box-shadow", null, "transform", null],
    "…and each css assert keeps its property",
  );
  assertEqual(
    parsed.steps.map((s) => s.cssMatch ?? null),
    [null, null, "is", null, "contains", null, "is", null],
    "…and its match mode",
  );
  assertEqual(parsed.steps[2]?.value, "rgb(0, 82, 204)", "an `is` css assert keeps its value");
  assertEqual(
    parsed.steps[4]?.value,
    "rgb(0, 0, 0) 0px 0px 0px 2px",
    "a `contains` css assert un-escapes back to the value the user typed",
  );
  assertEqual(parsed.steps[6]?.soft, true, "a soft css assert stays soft");

  // BYTE-identical regeneration is the property that actually matters: a value
  // that survives parsing but re-escapes on the way out drifts one backslash
  // per round trip, and every intermediate spec still looks plausible.
  const regenerated = generateSpec({
    name: "css",
    url: "https://example.com",
    steps: parsed.steps,
  });
  assertEqual(regenerated, src, "css/state spec regenerates byte-identically");
}

// ── 16. A disabled / continue-on-failure css assert and state step ────────
//
// Both wrappers rewrite the statement — one comments it out, the other nests it
// in a try/catch — and each is a separate chance for a new branch to stop
// matching.
{
  const wrapped: Step[] = [
    step({ type: "goto", url: "https://example.com" }),
    step({
      type: "state",
      elementState: "hover",
      locator: { k: "css", v: "#a" },
      disabled: true,
    }),
    step({
      type: "assert",
      locator: { k: "css", v: "#a" },
      assert: "css",
      cssProp: "color",
      cssMatch: "is",
      value: "rgb(255, 0, 0)",
      continueOnFailure: true,
    }),
  ];
  const src = generateSpec({ name: "wrapped", url: "https://example.com", steps: wrapped });
  const parsed = parseSpecDetailed(src);
  assertEqual(parsed.skipped, 0, "a disabled state step and a guarded css assert produce no skips");
  assertEqual(
    parsed.steps.map((s) => s.type),
    ["goto", "state", "assert"],
    "…and both survive their wrappers",
  );
  assertEqual(parsed.steps[1]?.disabled, true, "the disabled state step stays disabled");
  assertEqual(parsed.steps[1]?.elementState, "hover", "…and keeps its state through the comment");
  assertEqual(
    parsed.steps[2]?.continueOnFailure,
    true,
    "the css assert keeps continue-on-failure",
  );
  assertEqual(parsed.steps[2]?.cssProp, "color", "…and its property through the try/catch");
}

// ── 17. `// wait until` does not turn a css assert into a wait ────────────
//
// Every other element assert has a wait counterpart, so a marked one becomes a
// `wait`. `toHaveCSS` has none — ASSERT_TO_WAIT_UNTIL has no `css` entry — and
// the fallback must therefore keep it an ASSERTION rather than dropping it.
{
  const marked = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("marked", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    '  await expect(page.locator("#a")).toHaveCSS("color", "rgb(1, 2, 3)"); // wait until',
    "});",
    "",
  ].join("\n");
  const parsed = parseSpecDetailed(marked);
  assertEqual(parsed.skipped, 0, "a marked css assert is not unclassified");
  assertEqual(
    parsed.steps.map((s) => s.type),
    ["goto", "assert"],
    "a css assert carrying the wait marker stays an assertion",
  );
  assertEqual(parsed.steps[1]?.assert, "css", "…and keeps its assert kind");
}

// ── 18. `test.step(...)` blocks contribute their steps exactly ONCE ───────
//
// The wrapper's body is already inside the `test(...)` body the scan walks, so
// extracting it as a test body of its own replayed every statement a second
// time. Prompt-generated specs use this shape constantly, and the duplicate
// steps were silent: the list simply showed the flow twice.
{
  const src = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("wrapped", async ({ page }) => {',
    '  await test.step("Go", async () => {',
    '    await page.goto("https://example.com");',
    "  });",
    '  await test.step("Act", async () => {',
    '    await page.getByRole("button", { name: "Go" }).click();',
    '    await expect(page.getByText("Done")).toBeVisible();',
    "  });",
    "});",
    "",
  ].join("\n");
  const parsed = parseSpecDetailed(src);
  assertEqual(
    parsed.steps.map((s) => s.type),
    ["goto", "click", "assert"],
    "test.step bodies contribute their steps once, not twice",
  );
  assertEqual(parsed.skipped, 0, "the test.step wrappers themselves aren't counted as skipped");
}

// ── 18b. A wrapper inside a block, before an else, and with a hostile title ─
//
// The generator wraps every plain statement in `await test.step(…)` since
// 2026-08-22. Three places the old walk-through-the-wrapper reading went
// wrong, each pinned: the wrapper's `});` inside an `if` popped the block and
// read as `endif`; a wrapper directly before `} else {` made the anchored
// else matcher miss, losing the else; and a title quoting a statement was
// scanned as one. None of these had a fixture before the generator emitted
// the shape.
{
  const src = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("wrapped", async ({ page }) => {',
    '  await test.step("goto https://example.com", async () => {',
    '    await page.goto("https://example.com");',
    "  });",
    '  if (await page.getByText("Promo").isVisible()) {',
    '    await test.step("click page.getByTestId(\\"a\\").click()", async () => {',
    '      await page.getByTestId("promo-close").click();',
    "    });",
    "  } else {",
    '    await test.step("fill Email", async () => {',
    '      await page.getByLabel("Email").fill("a@b.c");',
    "    });",
    "  }",
    "  for (let i = 0; i < 2; i++) {",
    '    await test.step("click Next", async () => {',
    '      await page.getByRole("button", { name: "Next" }).click();',
    "    });",
    "  }",
    "});",
    "",
  ].join("\n");
  const parsed = parseSpecDetailed(src);
  assertEqual(
    parsed.steps.map((s) => s.type),
    ["goto", "if", "click", "else", "fill", "endif", "loop", "click", "endLoop"],
    "wrappers inside if/else/for read as their statements, with the blocks intact",
  );
  assertEqual(parsed.skipped, 0, "no wrapper, and no wrapper title, counts as a skip");
  assertEqual(
    parsed.steps.filter((s) => s.type === "click").map((s) => s.locator?.v),
    ["promo-close", undefined],
    "the title's quoted statement never became a step of its own",
  );
  assertEqual(parsed.stepRanges.length, parsed.steps.length, "every step has a range");
  // The ranges land on the inner statements, never on the wrapper lines.
  for (const r of parsed.stepRanges) {
    const text = src.slice(r.from, r.to);
    assertEqual(/test\.step/.test(text), false, "a step's range excludes the wrapper: " + JSON.stringify(text));
  }
}

// ── 19. A locator bound to a `const` and used later ───────────────────────
//
// The app never generates this, but a model asked for a readable spec writes
// it constantly. Before it was recognized the declaration counted a skip and
// the LATER USE vanished entirely — no step and no skip — so a generated test
// arrived with a step list that silently omitted every action.
{
  const src = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("vars", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    '  const emailInput = page.getByLabel("Email");',
    '  const submit = page.getByRole("button", { name: "Submit" });',
    '  const banner = page.getByText("Thanks");',
    '  await emailInput.fill("a@b.com");',
    "  await submit.click();",
    "  await expect(banner).toBeVisible();",
    "});",
    "",
  ].join("\n");
  const parsed = parseSpecDetailed(src);
  assertEqual(
    parsed.steps.map((s) => s.type),
    ["goto", "fill", "click", "assert"],
    "actions on a locator held in a variable become steps",
  );
  assertEqual(parsed.skipped, 0, "…and neither the declarations nor the uses count as skipped");
  assertEqual(
    parsed.steps[1]?.locator,
    { k: "label", v: "Email" },
    "the variable's locator is carried to its use",
  );
  assertEqual(parsed.steps[1]?.value, "a@b.com", "…along with the action's value");
  assertEqual(
    parsed.steps[3]?.locator,
    { k: "text", v: "Thanks" },
    "expect() over a locator variable resolves the same way",
  );
}

// ── 20. What CANNOT be modeled is counted, not swallowed ──────────────────
//
// Both of these are one statement away from the shapes above, and both used to
// leave no trace: a refined chain would have regenerated as the unrefined
// locator (matching the wrong element), and an expect() over a JS value has no
// step at all. Counting them is what puts the divergence warning on screen.
{
  const refined = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("refined", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    '  const row = page.getByRole("row").first();',
    "  await row.click();",
    "});",
    "",
  ].join("\n");
  const parsedRefined = parseSpecDetailed(refined);
  assertEqual(
    parsedRefined.steps.map((s) => s.type),
    ["goto"],
    "a refined locator chain is not stored as its unrefined base",
  );
  assertEqual(parsedRefined.skipped, 2, "…and both the declaration and its use are counted");

  const valueExpect = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("value", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    '  const label = "hello";',
    "  expect(label).toBeDefined();",
    "});",
    "",
  ].join("\n");
  const parsedValue = parseSpecDetailed(valueExpect);
  assertEqual(
    parsedValue.steps.map((s) => s.type),
    ["goto"],
    "expect() over a plain JS value produces no step",
  );
  assertEqual(parsedValue.skipped, 1, "…and is reported as unclassified rather than ignored");
}

// ── 21. `.nth(k)` survives the round trip ──────────────────────────────────
//
// The generator emits it (`locatorExpr`) and this parser could not read it, so
// `page.getByText("Save").nth(1).click()` matched no action shape and the WHOLE
// STEP was dropped. Not its index — the step. Every hand edit of the Script tab
// and every applied AI fix silently deleted the recorder's own output, for
// exactly the steps that needed an index: the ones where nothing unique existed.
//
// Checked across all four shapes, because the action, assertion and wait paths
// reach `parseLocator` differently and only one of them happened to work.
{
  const nthSteps: Step[] = [
    step({ type: "click", locator: { k: "text", v: "Save", nth: 1 } }),
    step({ type: "assert", assert: "visible", locator: { k: "text", v: "Row", nth: 2 } }),
    step({ type: "fill", value: "x", locator: { k: "role", role: "textbox", name: "Email", nth: 0 } }),
    step({ type: "wait", waitUntil: "visible", locator: { k: "testid", v: "t", nth: 3 } }),
  ];
  for (const s of nthSteps) {
    const src = generateSpec({ name: "nth", url: "https://example.com", steps: [s] });
    const parsed = parseSpecDetailed(src);
    const got = parsed.steps.filter((x) => x.type !== "goto")[0];
    assertEqual(got?.type, s.type, `a ${s.type} step with .nth() survives the round trip`);
    assertEqual(got?.locator?.nth, s.locator?.nth, `…and keeps its index (${s.type})`);
    assertEqual(parsed.skipped, 0, `…and is not counted as unclassified (${s.type})`);
  }

  // And it regenerates byte-identically, which is what makes an edit safe.
  const chain = [
    step({ type: "click", locator: { k: "text", v: "Save", nth: 1 } }),
    step({ type: "assert", assert: "text", text: "Done", locator: { k: "testid", v: "out", nth: 0 } }),
  ];
  const once = generateSpec({ name: "nth", url: "https://example.com", steps: chain });
  const twice = generateSpec({
    name: "nth",
    url: "https://example.com",
    steps: parseSpecDetailed(once).steps,
  });
  assertEqual(twice, once, "a spec with .nth() locators regenerates byte-identically");
}

// ── Scroll steps round-trip in BOTH forms ──────────────────────────────────
//
// The element form is a native locator call; the position form is a
// glazeScrollTo(page, x, y) helper call. Each must parse back as a scroll
// step, or an imported/LLM-resynced test silently loses the scroll that its
// following assertion depends on — the lazy-render content is then never on
// the page and the assert fails for a reason nothing in the step list shows.
{
  const scrollSteps: Step[] = [
    step({ type: "goto", url: "https://example.com" }),
    step({ type: "scroll", scrollX: 0, scrollY: 1240 }),
    step({ type: "scroll", locator: { k: "testid", v: "reviews" } }),
    step({ type: "assert", assert: "visible", locator: { k: "testid", v: "reviews" } }),
  ];
  const src = generateSpec({ name: "scrolls", url: "https://example.com", steps: scrollSteps });
  const parsed = parseSpecDetailed(src);
  assertEqual(parsed.skipped, 0, "scroll steps are not counted as unclassified");
  assertEqual(parsed.steps.length, 4, "both scroll forms round-trip in step count");
  assertEqual(parsed.steps[1]?.type, "scroll", "the position scroll parses as a scroll step");
  assertEqual(parsed.steps[1]?.scrollX, 0, "…and keeps its X");
  assertEqual(parsed.steps[1]?.scrollY, 1240, "…and keeps its Y");
  assertEqual(parsed.steps[2]?.type, "scroll", "the element scroll parses as a scroll step");
  assertEqual(parsed.steps[2]?.locator?.v, "reviews", "…and keeps its locator");

  // Byte-identical regeneration — what makes an edit-then-resync safe.
  const twice = generateSpec({
    name: "scrolls",
    url: "https://example.com",
    steps: parseSpecDetailed(src).steps,
  });
  assertEqual(twice, src, "a spec with scroll steps regenerates byte-identically");
}

// ── getByText's exact option ───────────────────────────────────────────────
//
// A hand-written or model-written `getByText("Save", { exact: true })` is the
// same locator the recorder emits for an ambiguous substring, and has to parse
// as one — the round-trip check covers the generated form; this covers the
// spellings a person writes.
{
  const src = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("exact", async ({ page }) => {',
    '  await page.getByText("Save", { exact: true }).click();',
    "  await page.getByText('Save', {exact:true}).click();",
    '  await page.getByText("Save", { exact: false }).click();',
    '  await expect(page.getByText("Done", { exact: true })).toBeVisible();',
    "});",
    "",
  ].join("\n");
  const parsed = parseSpecDetailed(src);
  assertEqual(parsed.skipped, 0, "exact-text builders are recognised, not skipped");
  assertEqual(
    parsed.steps.map((s) => s.locator?.exact ?? null),
    [true, true, null, true],
    "exact: true is read back in either spacing; exact: false is the substring default",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll spec-parser checks passed");
