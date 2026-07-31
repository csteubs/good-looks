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

Output format: plain text only, no markdown (no #, **, or code fences) — your response is shown as-is in a plain text panel, not rendered. Keep it short: a 1-2 sentence diagnosis, then the fixed lines as plain, copy-pasteable Playwright code the user can paste directly into the script editor. If the output doesn't contain enough detail to diagnose, say what additional information would help instead of guessing.`;

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
  const contextLines = [
    `Test: "${ctx.testName}"`,
    `Target URL: ${ctx.testUrl}`,
    ctx.imported
      ? "Source: imported from an external Playwright project — this script is hand-authored, not recorder-generated, so the locator conventions above may not apply to it."
      : "Source: recorded in this app from user actions, generated using the locator conventions above.",
    slowMo > 0
      ? `Playback speed: "${ctx.speed}" (Playwright inserts an artificial ${slowMo}ms delay between actions) — timing/race issues are less likely here than on a fast run, so weigh other causes first.`
      : `Playback speed: "fast" (no artificial delay between actions) — timing-sensitive failures (assertions firing before the page settles) are more likely here than on a slowed-down run.`,
  ];

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
