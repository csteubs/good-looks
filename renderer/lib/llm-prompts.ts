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
