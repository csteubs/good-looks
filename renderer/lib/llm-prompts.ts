// Persona and prompt-construction pipeline shared by every LLM feature in this
// app (currently just "Debug with AI"). Kept separate from the panels that use
// it so the same rules apply if test-step generation is ever added.

import type { LlmMessage } from "./llm-types";
import type { TestSpeed } from "./recorder-types";

const MAX_SCRIPT_CHARS = 6000;
const MAX_OUTPUT_CHARS = 8000;

// Mirror of main/services/playwright-runner.ts SLOW_MO_MS — keep in sync.
const SLOW_MO_MS: Record<TestSpeed, number> = { fast: 0, medium: 400, slow: 1200 };

// Errors are the most informative part of a long run output, so keep the tail.
function truncateTail(text: string, max: number): string {
  return text.length > max ? `…(truncated)…\n${text.slice(-max)}` : text;
}

function truncateHead(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)…` : text;
}

const SYSTEM_PROMPT = `You are an expert QA automation engineer embedded in a Playwright test recorder app, helping debug a failed test run.

This app's generated specs always follow these conventions — treat a violation as a likely bug, not a style nit:
- Locators prefer getByRole, getByTestId, getByLabel, getByPlaceholder, or getByText over a raw CSS locator(). A raw locator() usually means the recorder couldn't find a better handle for that element, and is a common source of flaky selectors.
  Bad:  await page.click('.btn-submit');
  Good: await page.getByRole('button', { name: 'Submit' }).click();
- No page.waitForTimeout(). Waits should be web-first assertions instead, e.g. expect(locator).toBeVisible() or expect(locator).toContainText().

Task: given the test's Playwright spec and its failing run output, identify the most likely root cause and suggest a concrete fix.

Output format:
- Start with a 1-2 sentence diagnosis of the most likely root cause, in plain prose. Do not use markdown headings (#) or bold (**).
- Put ALL code inside fenced code blocks using triple backticks with a "ts" language tag, so it is clearly separated from your explanation. Never write code inline in a prose sentence.
- When you can suggest a concrete fix, output the COMPLETE corrected spec as a single fenced code block: the entire file from the imports down, ready to save and run — not just the changed lines. Keep everything that was already correct exactly as-is; only change what is needed for the fix. The app shows this block to the user as a one-click "Apply to script", so it must be the whole, self-contained, valid file (it must still contain the imports and the test(...) call).
- If the run output lacks enough detail to diagnose, say what additional information would help instead of guessing, and do NOT output a code block.`;

export interface DebugContext {
  testName: string;
  testUrl: string;
  script: string;
  output: string;
  /** true when the test's script came from an imported external project rather than the in-app recorder. */
  imported: boolean;
  speed?: TestSpeed;
}

export function buildDebugMessages(ctx: DebugContext): LlmMessage[] {
  const slowMo = SLOW_MO_MS[ctx.speed ?? "fast"];
  const scriptTruncated = ctx.script.length > MAX_SCRIPT_CHARS;
  const contextLines = [
    `Test: "${ctx.testName}"`,
    `Target URL: ${ctx.testUrl}`,
    ctx.imported
      ? "Source: imported from an external Playwright project — this script is hand-authored, not recorder-generated, so the locator conventions above may not apply to it."
      : "Source: recorded in this app from user actions, generated using the locator conventions above.",
    slowMo > 0
      ? `Playback speed: "${ctx.speed}" (Playwright inserts an artificial ${slowMo}ms delay between actions) — timing/race issues are less likely here than on a fast run, so weigh other causes first.`
      : `Playback speed: "fast" (no artificial delay between actions) — timing-sensitive failures (assertions firing before the page settles) are more likely here than on a slowed-down run.`,
    // If the spec was too long to include in full, the model can't reproduce a
    // complete file — ask for just the changed lines so no partial file gets
    // offered as an applyable full-file replacement.
    scriptTruncated
      ? "NOTE: the spec below was truncated because it is long, so do NOT output a full-file replacement — show only the specific changed lines in a code block instead."
      : null,
  ].filter((line): line is string => line !== null);

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        contextLines.join("\n") +
        `\n\nPlaywright spec:\n\`\`\`ts\n${truncateHead(ctx.script, MAX_SCRIPT_CHARS)}\n\`\`\`\n\n` +
        `Run output (failed):\n\`\`\`\n${truncateTail(ctx.output, MAX_OUTPUT_CHARS)}\n\`\`\``,
    },
  ];
}

// ── Test generation by prompt ──────────────────────────────────────────
// A separate system prompt for generating a brand-new Playwright spec from a
// natural-language description, reusing the same locator conventions as the
// recorder so generated tests match hand-recorded ones.

const GENERATE_SYSTEM_PROMPT = `You are an expert QA automation engineer embedded in a Playwright test recorder app. Your task is to write a complete, runnable @playwright/test spec from a natural-language description.

This app's generated specs always follow these conventions — follow them exactly:
- Locators prefer getByRole, getByTestId, getByLabel, getByPlaceholder, or getByText over a raw CSS locator(). Use a raw locator() only when no better handle exists.
  Bad:  await page.click('.btn-submit');
  Good: await page.getByRole('button', { name: 'Submit' }).click();
- No page.waitForTimeout(). Waits must be web-first assertions, e.g. expect(locator).toBeVisible() or expect(locator).toContainText().
- Start every test by navigating to the requested URL with await page.goto(...).
- Add assertions that verify the user's intent, not just that actions ran.

Output format:
- Output ONLY the complete spec file inside a single fenced code block with a "ts" language tag. No prose before or after the block.
- The file must start with the import line and contain exactly one test(...) call, ready to save and run as-is.
- If the prompt is too vague to produce a runnable test, output a single fenced block containing a one-line comment explaining what's missing instead — do not guess.`;

export interface GenerateContext {
  /** The user's natural-language description of the test to generate. */
  prompt: string;
  /** Starting URL to navigate to (the test's first step). */
  url: string;
  /** Test name / title for the test(...) call. */
  name: string;
  /** Playback speed hint — affects how the test will be run, not the code. */
  speed?: TestSpeed;
  /** Optional browser viewport (width x height) the test should assume. */
  viewport?: { width: number; height: number };
}

export function buildGenerateMessages(ctx: GenerateContext): LlmMessage[] {
  const optLines: string[] = [
    `Test name: ${ctx.name}`,
    `Starting URL: ${ctx.url}`,
  ];
  if (ctx.speed && ctx.speed !== "fast") {
    const slowMo = SLOW_MO_MS[ctx.speed];
    optLines.push(
      `Playback speed: "${ctx.speed}" — the runner inserts an artificial ${slowMo}ms delay between actions, so the test does not need its own waits.`,
    );
  }
  if (ctx.viewport) {
    optLines.push(
      `Browser viewport: ${ctx.viewport.width}x${ctx.viewport.height} (the test should assume this window size).`,
    );
  }

  return [
    { role: "system", content: GENERATE_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        optLines.join("\n") +
        `\n\nTest description:\n${ctx.prompt.trim()}\n\n` +
        `Output the complete spec in a single fenced \`\`\`ts block.`,
    },
  ];
}

// ── Test-step generation (structured) ──────────────────────────────────
// Unlike buildGenerateMessages (which emits raw spec text), this asks the model
// to emit our structured Step[] schema so the steps land in the trainer's live,
// editable list — the user can then reorder, edit, and replay them before
// generating the spec. Mirrors mabl's AI Test Creation Agent building steps.

const GENERATE_STEPS_SYSTEM_PROMPT = `You are an expert QA automation engineer embedded in a Playwright test recorder. Turn a natural-language description into an ordered list of test STEPS as JSON, matching the recorder's own step model exactly.

Output format:
- Output ONLY a single fenced code block tagged "json" containing a JSON array of step objects. No prose before or after.
- Each step is an object. Allowed "type" values: "goto", "click", "fill", "press", "select", "check", "uncheck", "assert", "wait", "viewport".
- Locators use a "locator" object: { "k": <kind>, "v": <value>, "role": <ariaRole>, "name": <accessibleName> }. Locator kinds ("k"): "testid", "role", "label", "placeholder", "text", "css", "xpath". Prefer "role" (with "name"), "label", "placeholder", "text", or "testid" over "css"/"xpath".
- Step fields by type:
  - goto: { "type": "goto", "url": "..." }
  - click/check/uncheck: { "type": "click", "locator": {...} }
  - fill/select: { "type": "fill", "locator": {...}, "value": "..." }
  - press: { "type": "press", "value": "Enter", "locator": {...} }  (locator optional)
  - assert: { "type": "assert", "assert": <kind>, "locator": {...}, "text": "...", "value": "...", "attr": "...", "count": 1, "soft": false }
    assert kinds: "visible", "hidden", "text", "exactText", "enabled", "disabled", "checked", "unchecked", "value", "attribute", "count", "url", "title". "url"/"title" are page-level and need no locator; use "value" for the expected string. "text"/"exactText" use "text". "value" uses "value". "attribute" uses "attr"+"value". "count" uses "count".
  - wait: { "type": "wait", "waitMs": 1000 }  (or omit waitMs and give a "locator" to wait for it)
  - viewport: { "type": "viewport", "width": 1280, "height": 800 }

Rules:
- Start with a "goto" step to the given URL.
- Add assertions that verify the user's intent, not just that actions ran.
- Do not invent selectors you can't justify from the description — prefer visible labels/roles/text.

Example:
\`\`\`json
[
  { "type": "goto", "url": "https://example.com/login" },
  { "type": "fill", "locator": { "k": "label", "v": "Email" }, "value": "test@example.com" },
  { "type": "fill", "locator": { "k": "label", "v": "Password" }, "value": "secret123" },
  { "type": "click", "locator": { "k": "role", "role": "button", "name": "Sign in" } },
  { "type": "assert", "assert": "visible", "locator": { "k": "text", "v": "Welcome" } }
]
\`\`\``;

export interface GenerateStepsContext {
  /** The user's natural-language description of the test to generate. */
  prompt: string;
  /** Starting URL the first goto step should navigate to. */
  url: string;
  /** Optional browser viewport hint. */
  viewport?: { width: number; height: number };
}

export function buildGenerateStepsMessages(ctx: GenerateStepsContext): LlmMessage[] {
  const lines: string[] = [`Starting URL: ${ctx.url}`];
  if (ctx.viewport) {
    lines.push(`Browser viewport: ${ctx.viewport.width}x${ctx.viewport.height}.`);
  }
  return [
    { role: "system", content: GENERATE_STEPS_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        lines.join("\n") +
        `\n\nTest description:\n${ctx.prompt.trim()}\n\n` +
        `Output the steps as a single fenced \`\`\`json array.`,
    },
  ];
}
