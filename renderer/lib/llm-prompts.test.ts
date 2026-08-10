// Tests for the contract between the "Generate test from prompt" system prompt
// and the parser that reads the model's spec back into steps.
//
// These two are a matched pair with nothing connecting them in the type system:
// the prompt promises a vocabulary, spec-parser.ts implements one, and a spec
// written to a promise the parser doesn't keep still RUNS — it just arrives
// with a step list that omits most of the flow. That is exactly how a
// prompt-generated test shipped with two steps for a ten-statement script: the
// model bound its locators to `const`s, which the prompt never told it not to
// do, and the trainer had nothing to show.
//
// So the real assertion here is the second block: take the shapes the prompt
// tells the model to write, and prove the parser turns ALL of them into steps
// with nothing skipped. A copy edit that drops a rule, or a parser change that
// narrows the vocabulary, fails here rather than in a generated test the user
// has to notice is wrong.

import { describe, it, expect } from "vitest";

import { parseSpecDetailed } from "../../main/services/spec-parser";
import { buildGenerateMessages } from "./llm-prompts";

const systemPrompt = (): string => {
  const msg = buildGenerateMessages({
    prompt: "Sign in and check the dashboard",
    url: "https://example.com",
    name: "Sign in",
  }).find((m) => m.role === "system");
  return msg?.content ?? "";
};

describe("the generate-from-prompt system prompt", () => {
  it("names the three shapes that silently cost the user their steps", () => {
    const p = systemPrompt();
    // Each of these produced a real, silent step loss before it was stated.
    expect(p).toMatch(/Do NOT assign a locator to a variable/i);
    expect(p).toMatch(/Do NOT wrap the flow in test\.step/i);
    expect(p).toMatch(/Never expect\(\) a JavaScript value/i);
  });

  it("still welcomes the comments and logging the reader ignores", () => {
    // The generated script the user liked was readable because of these. They
    // cost nothing — the parser consumes both without counting a skip — so a
    // rule tightening the vocabulary must not take them away too.
    expect(systemPrompt()).toMatch(/Comments and console\.log\(\) calls are welcome/i);
  });
});

describe("a spec written to the prompt's rules", () => {
  // Every statement below is a shape the system prompt explicitly asks for.
  const spec = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("Sign in", async ({ page }) => {',
    "  await page.setViewportSize({ width: 1280, height: 800 });",
    "",
    "  // Load the sign-in page",
    '  await page.goto("https://example.com/login");',
    '  console.log("[1/3] Opened the login page");',
    "",
    "  // Fill the form and submit",
    '  await page.getByLabel("Email").fill("test@example.com");',
    '  await page.getByLabel("Password").fill("secret123");',
    '  await page.getByRole("checkbox", { name: "Remember me" }).check();',
    '  await page.getByRole("button", { name: "Sign in" }).click();',
    '  console.log("[2/3] Submitted the form");',
    "",
    "  // Verify the user landed on the dashboard",
    '  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();',
    '  await expect(page).toHaveURL("https://example.com/dashboard");',
    '  console.log("[3/3] Dashboard verified");',
    "});",
    "",
  ].join("\n");

  it("parses into a step for every action, with nothing unclassified", () => {
    const parsed = parseSpecDetailed(spec);
    expect(parsed.steps.map((s) => s.type)).toEqual([
      "viewport",
      "goto",
      "fill",
      "fill",
      "check",
      "click",
      "assert",
      "assert",
    ]);
    // A skip is what sets stepsDiverged, which puts a warning on a test that
    // was generated correctly. Comments and console.log must not trigger it.
    expect(parsed.skipped).toBe(0);
  });

  it("keeps the values and locators the steps replay from", () => {
    const parsed = parseSpecDetailed(spec);
    // An empty locator or a lost value parses fine and fails at replay time,
    // which reads as a broken app rather than a lossy translation.
    expect(parsed.steps[2]).toMatchObject({
      type: "fill",
      locator: { k: "label", v: "Email" },
      value: "test@example.com",
    });
    expect(parsed.steps[5]).toMatchObject({
      type: "click",
      locator: { k: "role", role: "button", name: "Sign in" },
    });
  });
});
