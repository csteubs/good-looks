// Persona and prompt-construction pipeline shared by every LLM feature in this
// app (currently just "Debug with AI"). Kept separate from the panels that use
// it so the same rules apply if test-step generation is ever added.

import type { LlmMessage } from "./llm-types";
import type { Locator, TestSpeed } from "./recorder-types";
import { LOG_REQUEST_PROTOCOL } from "./ai-log-request";
// The runner's own table, not a copy of it. The model is told what the run
// ACTUALLY did, so a stale number here is the app confidently stating a wrong
// fact to something reasoning from it — quieter than the MCP's copy was, and
// no more true. This used to be a third transcription kept honest by a
// text-scraping assertion in check:crawl-speed.
import { slowMoFor } from "../../shared/run-pacing.mjs";

const MAX_SCRIPT_CHARS = 6000;
const MAX_OUTPUT_CHARS = 8000;

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
  /** 0-based index of the step the run failed on, from the run's per-step markers, if known. */
  failedStepIndex?: number;
  /** Whether this run recorded console + network. Only when it did is the model
   *  told it may ask for them — offering data that doesn't exist wastes a round
   *  trip and teaches the model to ask for things nobody can supply. */
  logsAvailable?: boolean;
}

export function buildDebugMessages(ctx: DebugContext): LlmMessage[] {
  const slowMo = slowMoFor(ctx.speed);
  const scriptTruncated = ctx.script.length > MAX_SCRIPT_CHARS;
  const contextLines = [
    `Test: "${ctx.testName}"`,
    `Target URL: ${ctx.testUrl}`,
    ctx.imported
      ? "Source: imported from an external Playwright project — this script is hand-authored, not recorder-generated, so the locator conventions above may not apply to it."
      : "Source: recorded in this app from user actions, generated using the locator conventions above.",
    // Crawl gets its own line rather than sharing the generic "slowed down"
    // one. On a crawl run the runner has already waited for load, network
    // quiet and a painted frame after every action, so "it was a race" is very
    // nearly ruled out — and a model that spends its answer on waits the runner
    // already inserted is worse than useless, because the advice looks correct.
    ctx.speed === "crawl"
      ? `Playback speed: "crawl" — Playwright inserts a ${slowMo}ms delay between actions AND the runner waits after EVERY action for the load event, for the network to go quiet, and for a painted frame before the next step begins. A timing/race explanation is therefore very unlikely, and adding waits to the test would not help: look for a genuinely wrong locator, changed page content, or a real application bug.`
      : slowMo > 0
        ? `Playback speed: "${ctx.speed}" (Playwright inserts an artificial ${slowMo}ms delay between actions) — timing/race issues are less likely here than on a fast run, so weigh other causes first.`
        : `Playback speed: "fast" (no artificial delay between actions) — timing-sensitive failures (assertions firing before the page settles) are more likely here than on a slowed-down run.`,
    // If the spec was too long to include in full, the model can't reproduce
    // a complete file — ask for just the changed lines so no partial file gets
    // offered as an applyable full-file replacement.
    scriptTruncated
      ? "NOTE: the spec below was truncated because it is long, so do NOT output a full-file replacement — show only the specific changed lines in a code block instead."
      : null,
  ].filter((line): line is string => line !== null);

  return [
    {
      role: "system",
      content: ctx.logsAvailable ? `${SYSTEM_PROMPT}\n\n${LOG_REQUEST_PROTOCOL}` : SYSTEM_PROMPT,
    },
    {
      role: "user",
      content:
        contextLines.join("\n") +
        `\n\nPlaywright spec:\n\`\`\`ts\n${truncateHead(ctx.script, MAX_SCRIPT_CHARS)}\n\`\`\`\n\n` +
        `Run output (failed):\n\`\`\`\n${truncateTail(ctx.output, MAX_OUTPUT_CHARS)}\n\`\`\``,
    },
  ];
}

// ── Per-step replay debugging (trainer Console) ───────────────────────
// A focused diagnosis of a SINGLE failed trainer step (one step in the live,
// editable step list), given the step's action + locator, the error that
// replay produced, and the verbose log lines captured while replaying it.
// Unlike buildDebugMessages (which gets the whole spec + full run output and
// can offer a complete corrected file), this is a step in an editable list, so
// we ask for a plain-prose diagnosis plus an optional fenced ```ts snippet
// showing just the corrected Playwright expression for this step — not a
// whole-file replacement.

const STEP_DEBUG_SYSTEM_PROMPT = `You are an expert QA automation engineer embedded in a Playwright test recorder's live trainer. The user replayed a single test step against the live page and it failed. Diagnose why and suggest a concrete fix.

The recorder's steps use Playwright-style locators. Locator kinds: getByRole (with aria role + accessible name), getByLabel, getByPlaceholder, getByText, getByTestId, and raw CSS/XPath locator(). Prefer the semantic kinds over CSS/XPath; a raw CSS locator often means the recorder couldn't find a better handle and is a common source of flaky selectors.

Common causes of a single-step replay failure:
- The element isn't on the page yet (race condition) — the step ran before the page settled. Suggest a web-first wait (expect(locator).toBeVisible()) or reordering the step.
- The locator no longer matches the page (the element's role/label/text changed, or it's behind a shadow root). Suggest a more robust locator for the same element.
- The action itself is wrong for the element (e.g. fill on a non-input, click on a disabled control). Suggest the correct action.
- A navigation the previous step triggered hasn't completed.

Output format:
- Start with a 1-2 sentence diagnosis of the most likely root cause, in plain prose. Do not use markdown headings (#) or bold (**).
- If you can suggest a concrete fix, show the corrected Playwright expression for THIS STEP ONLY in a single fenced code block tagged "ts" — e.g. \`await page.getByRole('button', { name: 'Sign in' }).click();\`. Do NOT output a whole spec file; this is one editable step, not a script.
- If the logs don't give enough detail to diagnose, say what additional information would help instead of guessing, and do NOT output a code block.`;

export interface StepDebugContext {
  /** Test name, for context. */
  testName: string;
  /** The page URL the trainer has loaded (the step runs against this page). */
  url: string;
  /** Human-readable description of the failed step (e.g. "Click button ‘Sign in’"). */
  stepLabel: string;
  /** The step's locator rendered as a Playwright-style expression, if it has one. */
  locator?: string;
  /** The error message replay produced for this step. */
  error: string;
  /** Verbose diagnostic log lines captured while replaying the step (timestamp · level · message). */
  logs: { level: "info" | "warn" | "error"; message: string }[];
}

export function buildStepDebugMessages(ctx: StepDebugContext): LlmMessage[] {
  const logText = ctx.logs.length > 0
    ? ctx.logs.map((l) => `[${l.level}] ${l.message}`).join("\n")
    : "(no verbose logs were captured for this step)";
  const lines = [
    `Test: "${ctx.testName}"`,
    `Page URL: ${ctx.url}`,
    `Failed step: ${ctx.stepLabel}`,
    ctx.locator ? `Step locator: ${ctx.locator}` : "Step locator: (none — this step has no element locator)",
  "",
    `Error from replay:\n${ctx.error}`,
    "",
    `Verbose replay logs:\n${truncateTail(logText, MAX_OUTPUT_CHARS)}`,
  ];
  return [
    { role: "system", content: STEP_DEBUG_SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
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
- If a browser viewport is specified in the user message, the very first line inside the test(...) body (before goto) must be await page.setViewportSize({ width: <w>, height: <h> }) using the exact dimensions given. Never substitute your own default viewport size.
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
    const slowMo = slowMoFor(ctx.speed);
    optLines.push(
      ctx.speed === "crawl"
        ? `Playback speed: "crawl" — the runner inserts a ${slowMo}ms delay between actions AND waits for the page to load, go quiet and paint after every one of them. Do not write any waits of your own; they are already there.`
        : `Playback speed: "${ctx.speed}" — the runner inserts an artificial ${slowMo}ms delay between actions, so the test does not need its own waits.`,
    );
  }
  if (ctx.viewport) {
    optLines.push(
      `Browser viewport: ${ctx.viewport.width}x${ctx.viewport.height}. ` +
        `IMPORTANT: the user explicitly selected this window size — the FIRST line inside the test(...) body must be ` +
        `\`await page.setViewportSize({ width: ${ctx.viewport.width}, height: ${ctx.viewport.height} });\` ` +
        `so the test runs at exactly this size. Do NOT use any other viewport dimensions, and do NOT omit this call.`,
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
- Each step is an object. Allowed "type" values: "click", "fill", "press", "select", "check", "uncheck", "assert", "wait", "viewport", "if", "endif", "cookie", "capture", "runFlow", "state".
- Locators use a "locator" object: { "k": <kind>, "v": <value>, "role": <ariaRole>, "name": <accessibleName> }. Locator kinds ("k"): "testid", "role", "label", "placeholder", "text", "css", "xpath". Prefer "role" (with "name"), "label", "placeholder", "text", or "testid" over "css"/"xpath".
- Step fields by type:
  - click/check/uncheck: { "type": "click", "locator": {...} }
  - fill/select: { "type": "fill", "locator": {...}, "value": "..." }
  - press: { "type": "press", "value": "Enter", "locator": {...} }  (locator optional)
  - assert: { "type": "assert", "assert": <kind>, "locator": {...}, "text": "...", "value": "...", "attr": "...", "count": 1, "soft": false }
    assert kinds: "visible", "hidden", "text", "exactText", "enabled", "disabled", "checked", "unchecked", "value", "attribute", "count", "url", "urlEndsWith", "urlIs", "title". "url"/"urlEndsWith"/"urlIs"/"title" are page-level and need no locator; use "value" for the expected string ("url" = contains, "urlEndsWith" = ends with, "urlIs" = exact match). "text"/"exactText" use "text". "value" uses "value". "attribute" uses "attr"+"value". "count" uses "count".
  - wait: { "type": "wait", "waitMs": 1000 }  (or omit waitMs and give a "locator" to wait for it)
    A wait can also block on a condition instead: { "type": "wait", "waitUntil": <kind>, "locator": {...}, "timeoutMs": 10000 }. waitUntil kinds: "visible", "hidden", "exists", "enabled", "disabled", "checked", "unchecked", "text", "value", "count", "urlContains", "titleContains". "text" uses "text"; "value"/"urlContains"/"titleContains" use "value"; "count" uses "count". "urlContains"/"titleContains" are page-level and need no locator. Prefer a conditional wait over a fixed waitMs — a duration that is too short is flaky and one that is too long is slow.
  - viewport: { "type": "viewport", "width": <width>, "height": <height> } — ALWAYS emit a viewport step FIRST (before any action), using the exact width and height from the "Browser viewport" line in the user message. If no viewport is specified, use 1280x800.
  - if/endif: { "type": "if", "cond": <kind>, "locator": {...} } … { "type": "endif" } — steps between them run only when the condition holds, and the test continues gracefully when it does not. cond kinds: "visible", "hidden", "exists", "enabled", "disabled", "checked", "unchecked", "urlContains", "titleContains". The last two are page-level: they take no locator and read "value" as the substring. EVERY "if" must have a matching "endif".
  - capture: { "type": "capture", "captureVar": "orderId", "captureFrom": "text", "locator": {...} } — reads a value off the page into a variable later steps can use as \${orderId}. captureFrom: "text", "value", "attribute" (with "captureAttr"), "url", "title".
  - cookie: { "type": "cookie", "cookieAction": "set", "cookie": { "name": "...", "value": "...", "domain": "...", "path": "/" } }. cookieAction: "set", "delete", "clearAll" ("clearAll" takes no "cookie").
  - state: { "type": "state", "elementState": "hover", "locator": {...} } — puts an element into a pseudo-state so the assertion AFTER it measures the styled state. elementState: "hover", "focus", "press", "release".
  - runFlow: { "type": "runFlow", "flowId": "<id>", "flowArgs": { "<param>": "<value>" } } — only when the user names an existing flow to reuse. Do not invent a flowId.

Rules:
- Do NOT output a "goto" step. The test already starts by navigating to its URL (that is a test-level setting the user controls separately); you are only generating the steps that come AFTER navigation. Assume the page is already loaded at the starting URL.
- If a "Browser viewport" is specified in the user message, your FIRST step must be a "viewport" step with the exact dimensions given. Never substitute your own default size.
- Add assertions that verify the user's intent, not just that actions ran.
- Do not invent selectors you can't justify from the description — prefer visible labels/roles/text.

Example (when the user message specifies a 1280x800 viewport):
\`\`\`json
[
  { "type": "viewport", "width": 1280, "height": 800 },
  { "type": "fill", "locator": { "k": "label", "v": "Email" }, "value": "test@example.com" },
  { "type": "fill", "locator": { "k": "label", "v": "Password" }, "value": "secret123" },
  { "type": "click", "locator": { "k": "role", "role": "button", "name": "Sign in" } },
  { "type": "assert", "assert": "visible", "locator": { "k": "text", "v": "Welcome" } }
]
\`\`\``;

export interface GenerateStepsContext {
  /** The user's natural-language description of the test to generate. */
  prompt: string;
  /** Starting URL — already handled by the test's Step 1 (Navigate to URL); provided as context only, not to be emitted as a step. */
  url: string;
  /** Optional browser viewport hint. */
  viewport?: { width: number; height: number };
  /** Optional selector the user picked on the page to give the LLM exact context. */
  selector?: Locator;
}

// Render a Locator back into the Playwright-style expression the model recognizes,
// so the prompt's selector context matches the recorder's own locator vocabulary.
export function locatorToPrompt(l: Locator): string {
  switch (l.k) {
    case "testid":
      return `getByTestId(${JSON.stringify(l.v ?? "")})`;
    case "role":
      return l.name
        ? `getByRole(${JSON.stringify(l.role ?? "")}, { name: ${JSON.stringify(l.name)} })`
        : `getByRole(${JSON.stringify(l.role ?? "")})`;
    case "label":
      return `getByLabel(${JSON.stringify(l.v ?? "")})`;
    case "placeholder":
      return `getByPlaceholder(${JSON.stringify(l.v ?? "")})`;
    case "text":
      return `getByText(${JSON.stringify(l.v ?? "")})`;
    case "css":
      return `locator(${JSON.stringify(l.v ?? "")})`;
    case "xpath":
      return `locator(${JSON.stringify("xpath=" + (l.v ?? ""))})`;
    default:
      return JSON.stringify(l);
  }
}

export function buildGenerateStepsMessages(ctx: GenerateStepsContext): LlmMessage[] {
  const lines: string[] = [
    `Starting URL: ${ctx.url} (the test already navigates here as its first step — do NOT emit a "goto" step for it; assume the page is already loaded at this URL).`,
  ];
  if (ctx.viewport) {
    lines.push(
      `Browser viewport: ${ctx.viewport.width}x${ctx.viewport.height}. ` +
        `IMPORTANT: the user explicitly selected this window size — the FIRST step in your output must be a "viewport" step with exactly width=${ctx.viewport.width}, height=${ctx.viewport.height}. Do NOT use any other dimensions.`,
    );
  }
  if (ctx.selector) {
    lines.push(
      `User-provided target selector: ${locatorToPrompt(ctx.selector)}. ` +
        `The user pointed at this element on the page — prefer this exact locator for the step that targets it, and use it as the anchor when the description refers to that element.`,
    );
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
