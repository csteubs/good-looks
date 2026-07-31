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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll spec-parser checks passed");
