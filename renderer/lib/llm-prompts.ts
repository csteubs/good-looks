// Persona and prompt-construction pipeline shared by every LLM feature in this
// app (currently just "Debug with AI"). Kept separate from the panels that use
// it so the same rules apply if test-step generation is ever added.

import type { LlmMessage } from "./llm-types";
import { ASSERT_KINDS } from "./recorder-types";
import type { Locator, TestSpeed } from "./recorder-types";
// The SAME table the generator and the trainer's replayer read. The prompt used
// to transcribe this — and it drifted: it listed 15 of the 17 kinds, and said
// nothing about `title` being an EXACT whole-title match, so a model asked for
// "the title mentions Checkout" had exactly one expressible answer and it was
// the wrong one. Deriving it means a kind added to the app is a kind the model
// can reach on the same commit.
import { ASSERT_SEMANTICS } from "../../shared/step-semantics.mjs";
import { locatorExpr } from "./describe-step";
import { logRequestProtocol, type LogRequestNeed } from "./ai-log-request";
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
- A page-level URL or title assertion says which match it means through the ARGUMENT SHAPE, and a bare string is the strictest one: expect(page).toHaveURL("/cart") is an EXACT whole-URL match, not "contains", and it cannot pass against a real page when given a path. "Contains" is an unanchored RegExp — expect(page).toHaveURL(new RegExp("/cart", "i")) — "ends with" anchors with $, and exact anchors with ^…$. The same holds for toHaveTitle. Reading a bare string as "contains" is the commonest mistake made against this app's specs.

Playwright runs in STRICT MODE, and "strict mode violation: <locator> resolved to N elements" is a locator that is ambiguous, NOT one that is wrong or missing. Read the rest of that error before asking for anything: Playwright lists the elements it matched and prints a disambiguated locator for each one after the word "aka". Those are generated from the live page at the moment of failure, so prefer one of them over a locator you invent. Narrow by scoping to an ancestor (page.getByTestId("nav").getByRole("link", { name: "Browser" })) rather than by adding .first() or .nth(), which pick by DOM order and break the next time the page reorders.

Task: given the test's Playwright spec and its failing run output, identify the most likely root cause and suggest a concrete fix.

Output format:
- Start with a 1-2 sentence diagnosis of the most likely root cause, in plain prose. Do not use markdown headings (#) or bold (**).
- Put ALL code inside fenced code blocks using triple backticks with a "ts" language tag, so it is clearly separated from your explanation. Never write code inline in a prose sentence.
- When you can suggest a concrete fix, output the COMPLETE corrected spec as a single fenced code block: the entire file from the imports down, ready to save and run — not just the changed lines. Keep everything that was already correct exactly as-is; only change what is needed for the fix. The app shows this block to the user as a one-click "Apply to script", so it must be the whole, self-contained, valid file (it must still contain the imports and the test(...) call).
- If the run output lacks enough detail to diagnose, say what additional information would help instead of guessing, and do NOT output a code block.

Applying your spec REPLACES the user's step list, which is rebuilt by re-reading the file — so keep the shapes the reader understands. Write each action as one self-contained statement (await page.<builder>(...).<action>(...);). A .nth(k) between the builder and the action is fine and is how this app pins one of several matches; .first(), .filter() and .or() are not, and a step written that way is lost on the way back in. Do not bind locators to variables or wrap anything in test.step(...). Leave any "// UNGENERATABLE STEP" comment exactly where it is: it marks a step the user has that this app could not turn into code, and deleting it deletes their step.`;

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
  /** Whether this run recorded the page structure Auto-Heal probed for. Same
   *  rule as logsAvailable, and separately true: Auto-Heal and console
   *  recording are independent settings, so either can be the only one on. */
  structureAvailable?: boolean;
}

/** One item in the "Sending" strip: what is attached, and how big it is. */
export interface SendingItem {
  label: string;
  /** Rough size, in characters of prompt text. `null` for a fact rather than a
   *  payload — the URL is one line, and quoting a byte count for it is noise. */
  chars: number | null;
}

/**
 * What this app is about to send to a model, itemised.
 *
 * A PRIVACY AFFORDANCE, WHICH IS WHY IT SHIPS WITH THE RESKIN RATHER THAN
 * WAITING FOR PHASE C (REDESIGN §B9). "Debug with AI" can send a user's script
 * and a run's console output to a hosted provider, and until now the only way
 * to know what left the machine was to read this function's source. A test
 * script routinely contains staging hostnames, seeded credentials and
 * customer-shaped fixture data; run output contains whatever the page logged.
 * Someone deciding whether to press the button deserves the list.
 *
 * DERIVED FROM THE SAME `ctx` THE PROMPT IS BUILT FROM, deliberately. A
 * hand-maintained second list is a list that eventually describes a prompt the
 * app no longer sends — and an inaccurate privacy disclosure is worse than
 * none, because it is trusted. Guarded by a test that fails when the builder
 * gains a payload this does not name.
 *
 * Sizes are CHARACTERS, not tokens. A token count would be a guess dressed as a
 * measurement — it depends on the tokenizer, which depends on the provider and
 * the model — and the question being answered here is "how much of my stuff",
 * for which characters are honest and sufficient.
 */
export function describeSending(ctx: DebugContext): SendingItem[] {
  const items: SendingItem[] = [
    { label: "Test name", chars: ctx.testName.length },
    { label: "Target URL", chars: null },
    {
      label: ctx.script.length > MAX_SCRIPT_CHARS ? "Test script (truncated)" : "Test script",
      chars: Math.min(ctx.script.length, MAX_SCRIPT_CHARS),
    },
    { label: "Run output", chars: ctx.output.length },
  ];
  // Only when the run actually recorded them AND the model is told it may ask.
  // Listing a capability the prompt does not offer would overstate what leaves
  // the machine, which is the same failure as understating it.
  if (ctx.logsAvailable) {
    items.push({ label: "Console & network, if the model asks for them", chars: null });
  }
  // Page structure is a SEPARATE offer with a separate flag, and it was missing
  // here — so the strip understated what could leave the machine. Its payload is
  // page-authored DOM: ids, class names, aria-labels and up to 120 characters of
  // text per element, for up to 20 elements per failing step. An inaccurate
  // privacy disclosure is worse than none, because it is trusted.
  if (ctx.structureAvailable) {
    items.push({
      label: "Page structure — the elements the failing locator matched, if the model asks",
      chars: null,
    });
  }
  return items;
}

/** Total attached payload, in characters. Separate from the list because the
 *  strip shows one number and the list is behind it. */
export function sendingTotalChars(items: SendingItem[]): number {
  return items.reduce((sum, item) => sum + (item.chars ?? 0), 0);
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

  const available: LogRequestNeed[] = [
    ...(ctx.logsAvailable ? (["console", "network"] as const) : []),
    ...(ctx.structureAvailable ? (["structure"] as const) : []),
  ];
  const protocol = logRequestProtocol(available);

  return [
    {
      role: "system",
      content: protocol ? `${SYSTEM_PROMPT}\n\n${protocol}` : SYSTEM_PROMPT,
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

The trainer replays the step against the live page using the SAME matching rules a real run uses — including Playwright's strict mode — so its verdict is about the step, not about the preview.

Common causes of a single-step replay failure. Match the error text before choosing one; several of these look alike and have opposite fixes:
- "Locator matched N elements (strict mode violation)" — the locator is AMBIGUOUS, not wrong and not missing. It matches too much, so do not propose a different locator for the same element: narrow the one there is, by scoping to an ancestor (page.getByTestId("nav").getByRole("link", { name: "Save" })). An index is the last resort, because it picks by DOM order and breaks when the page reorders. Note this error comes from the trainer, not from Playwright, so it does NOT list the elements it matched or print "aka" alternatives — ask for the page structure if you need to see them.
- "Element is covered by <something>" / "another element is on top of this one" — the element is present and visible; something is drawn over its click point, so a real run fails with "element intercepts pointer events". The named element is usually a cookie banner, a modal or a sticky header. The fix is a step that dismisses or scrolls past it, NOT a wait and NOT a new locator — expect(locator).toBeVisible() will PASS here and change nothing.
- "No option matching ..." — a select step whose option is gone or renamed. The log lists the options the element actually offers; pick from those.
- "Attribute X is not present" — a missing attribute is not an attribute equal to "". Either the attribute went away or the assertion wants a different one.
- The element isn't on the page yet (race condition) — the step ran before the page settled. Suggest a web-first wait (expect(locator).toBeVisible()) or reordering the step.
- The locator no longer matches the page — it resolved to NOTHING (the element's role/label/text changed, or it's behind a shadow root). Suggest a more robust locator for the same element.
- The action itself is wrong for the element (e.g. fill on a non-input, click on a disabled control). Suggest the correct action.
- A navigation the previous step triggered hasn't completed.

If the step's locator ends in .nth(k), it is pinned to the k-th match (0-based). "Matched nothing" for such a locator usually means the page now has FEWER than k+1 matches — the element is not necessarily gone.

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
- A page-level URL or title assertion says which match it means through the ARGUMENT SHAPE, and a bare string is the strictest one: expect(page).toHaveURL("/cart") is an EXACT whole-URL match, not "contains", and it cannot pass against a real page when given a path. "Contains" is an unanchored RegExp — expect(page).toHaveURL(new RegExp("/cart", "i")) — "ends with" anchors with $, and exact anchors with ^…$. The same holds for toHaveTitle. Reading a bare string as "contains" is the commonest mistake made against this app's specs.
- Start every test by navigating to the requested URL with await page.goto(...).
- If a browser viewport is specified in the user message, the very first line inside the test(...) body (before goto) must be await page.setViewportSize({ width: <w>, height: <h> }) using the exact dimensions given. Never substitute your own default viewport size.
- Add assertions that verify the user's intent, not just that actions ran.

The spec is also read back into the app's own step list, which is what the trainer edits and replays. Statements outside the vocabulary below still RUN, but they cannot become steps — so write the flow as a flat sequence of the supported calls:
- Write each action as one self-contained statement: \`await page.<locatorBuilder>(...).<action>(...);\`. Do NOT assign a locator to a variable and act on it later, and do NOT chain refinements like .first(), .nth(), .filter() or .or() onto a locator.
  Bad:  const submit = page.getByRole('button', { name: 'Submit' }); await submit.click();
  Good: await page.getByRole('button', { name: 'Submit' }).click();
- Supported actions: .click(), .fill(), .selectOption(), .check(), .uncheck(), .press(), .hover(), .focus(), .waitFor({ state }). Plus page.goto(), page.setViewportSize(), page.keyboard.press().
- Every expect() must take a locator or \`page\` as its subject: expect(page.getByText('Welcome')).toBeVisible(), expect(page).toHaveURL(...). Never expect() a JavaScript value.
- Do NOT read data out of the page (.textContent(), .allTextContents(), .isVisible() into a variable), and do NOT use if/ternary branching, loops, or intermediate variables to decide what to assert. Assert the expected state directly.
- Do NOT wrap the flow in test.step(...) blocks — write the statements directly in the test body.
- Comments and console.log() calls are welcome and are ignored by the step reader — use them to label the phases of the flow.

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


/** The page-level assert kinds, each with the rule it actually matches by.
 *
 *  Built from `ASSERT_SEMANTICS` rather than written out, so the prompt cannot
 *  describe a match rule the generator does not implement. */
function assertKindRules(): string {
  const verb = (kind: string): string => {
    const s = ASSERT_SEMANTICS[kind];
    if (!s) return "";
    const base =
      s.match === "exact"
        ? "must equal the whole value exactly"
        : s.match === "endsWith"
          ? "must be the END of the value"
          : "must appear ANYWHERE in the value";
    return `${base}, ${s.caseSensitive ? "case-sensitive" : "ignoring case"}`;
  };
  return [
    `      - "urlPathIs": the URL's PATH must equal the value exactly, ignoring case, the query string, the #fragment, and a trailing slash. THE DEFAULT for asserting where a navigation landed: query parameters (tracking, variants) change between runs and cannot fail it. Value is a path like "/cart".`,
    `      - "url": ${verb("url")}. Use a path or host fragment, not the whole URL — the origin differs between environments. Note it also matches against the query string, so prefer "urlPathIs" for "did I land on the right page".`,
    `      - "urlEndsWith": ${verb("urlEndsWith")}. The whole URL, so a query string or #fragment at run time fails it — prefer "urlPathIs" unless you mean the literal end of the URL.`,
    `      - "urlIs": ${verb("urlIs")}. Needs the absolute URL; anything shorter can never pass, and any query-parameter drift fails it.`,
    `      - "title": ${verb("title")}. A page titled "Cart | Acme" does NOT satisfy a "title" of "Cart".`,
    `      - "titleContains": ${verb("titleContains")}. This is the one to use when you mean the title merely mentions something.`,
  ].join("\n");
}

const GENERATE_STEPS_SYSTEM_PROMPT = `You are an expert QA automation engineer embedded in a Playwright test recorder. Turn a natural-language description into an ordered list of test STEPS as JSON, matching the recorder's own step model exactly.

Output format:
- Output ONLY a single fenced code block tagged "json" containing a JSON array of step objects. No prose before or after.
- Each step is an object. Allowed "type" values: "click", "fill", "press", "select", "check", "uncheck", "assert", "wait", "viewport".
- Locators use a "locator" object: { "k": <kind>, "v": <value>, "role": <ariaRole>, "name": <accessibleName> }. Locator kinds ("k"): "testid", "role", "label", "placeholder", "text", "css", "xpath". Prefer "role" (with "name"), "label", "placeholder", "text", or "testid" over "css"/"xpath". A "testid" locator may add "attr": "data-test-id" or "data-test" when the element's test id lives on that attribute instead of data-testid; keep the "attr" of the original locator when proposing a changed value for the same element.
- A locator may carry a "ctx" object pinning down WHICH element it means when the page could have several matches: { "within": <locator>, "withinHasText": <text>, "and": [<locator>, ...] }. "within" is an ancestor the target must live inside — the Save button INSIDE the Billing dialog is "ctx": { "within": { "k": "role", "role": "dialog", "name": "Billing" } }. "withinHasText" is text the CONTAINER must contain (the "which row?" question); it is meaningless without "within" and dropped in that case. "and" lists extra locators the TARGET itself must also match. Locators inside "ctx" cannot carry a "ctx" of their own. Use "ctx" only when the description itself names a container or a distinguishing property — do not invent one.
- Step fields by type:
  - click/check/uncheck: { "type": "click", "locator": {...} }
  - fill/select: { "type": "fill", "locator": {...}, "value": "..." }
  - press: { "type": "press", "value": "Enter", "locator": {...} }  (locator optional)
  - assert: { "type": "assert", "assert": <kind>, "locator": {...}, "text": "...", "value": "...", "attr": "...", "count": 1, "soft": false }
    assert kinds: ${ASSERT_KINDS.map((k) => JSON.stringify(k)).join(", ")}.
    "url"/"urlEndsWith"/"urlIs"/"urlPathIs"/"title"/"titleContains" are page-level and need no locator; use "value" for the expected string. Their match rules are exact and differ — pick by what you actually mean:
${assertKindRules()}
    "text"/"exactText" use "text". "value" uses "value". "attribute" uses "attr"+"value". "count" uses "count". "css" uses "cssProp" (kebab-case) + "value", and "cssMatch": "is" | "contains".
    An assert with an EMPTY expected value is refused outright rather than generated — an empty "contains" matches every page, so it would be a green assertion that tests nothing. Always give a value.
  - wait: { "type": "wait", "waitMs": 1000 }  (or omit waitMs and give a "locator" to wait for it)
    A wait can also block on a condition instead: { "type": "wait", "waitUntil": <kind>, "locator": {...}, "timeoutMs": 10000 }. waitUntil kinds: "visible", "hidden", "exists", "enabled", "disabled", "checked", "unchecked", "text", "value", "count", "urlContains", "titleContains". "text" uses "text"; "value"/"urlContains"/"titleContains" use "value"; "count" uses "count". "urlContains"/"titleContains" are page-level and need no locator. Prefer a conditional wait over a fixed waitMs — a duration that is too short is flaky and one that is too long is slow.
  - viewport: { "type": "viewport", "width": <width>, "height": <height> } — ALWAYS emit a viewport step FIRST (before any action), using the exact width and height from the "Browser viewport" line in the user message. If no viewport is specified, use 1280x800.

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
/**
 * A recorded locator as the Playwright expression the spec actually contains.
 *
 * `.nth(k)` is part of that expression and was silently dropped here, so the
 * model was shown `getByText("Save")` for a step whose line is
 * `getByText("Save").nth(3)`. Two ways that misleads, both of which produce
 * confident wrong advice on the most fragile steps in a suite (an index is only
 * ever written when nothing unique existed):
 *
 *  • The step-debug prompt names a locator that cannot produce the failure.
 *  • The structure payload reports what the REFINED locator matched, so a
 *    `.nth(3)` step on a page that now has three matches reports zero — and
 *    with the index hidden, "matched nothing" reads as "the element is gone"
 *    rather than "the index is one past the end".
 *
 * `ctx` — the user's pinned context — was the same bug a second time: a step
 * whose spec line is
 * `page.getByTestId("billing").filter({ hasText: "Billing" }).getByRole("button", …)`
 * was shown as the bare `getByRole("button", …)`. The commonest failure such a
 * step has is the CONTAINER or its hasText no longer matching, and the model
 * cannot name a clause it was never shown — while the bare target, matching
 * more than the chain does, makes the match report contradict the error being
 * diagnosed.
 *
 * The rendering is `locatorExpr` from describe-step.ts — the step list's
 * mirror of the generator's `locatorExpr` — rather than a copy kept here.
 * This function used to carry its own `locatorBase` transcription and
 * under-rendered on top of it twice (`.nth`, then the `ctx` chain), and the
 * step list grew its full-chain mirror independently in the same release;
 * two renderer copies of the chain grammar is exactly the drift that keeps
 * shipping, so now there is one. Pinned twice: `describe-mirror.test.ts`
 * diffs the mirror against the generator's function, and
 * main/services/__tests__/locator-prompt-parity.test.ts pins THIS function
 * against the line `generateSpec` actually emits, so a prompt-specific
 * rendering added here later inherits the same guard. See DECISIONS
 * 2026-08-21.
 */
export function locatorToPrompt(l: Locator): string {
  return locatorExpr(l);
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
