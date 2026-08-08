// Splits an LLM debug response into prose and fenced ```code``` segments so the
// panel can render suggested code changes as distinct, copyable blocks and offer
// to apply a corrected spec. Written to tolerate a still-streaming response.

import { CAPTURE_SOURCES, ELEMENT_STATES } from "./recorder-types";
import type {
  AssertKind,
  CaptureSource,
  ConditionKind,
  CookieAction,
  CssMatch,
  ElementState,
  LocatorKind,
  RawStep,
  StepType,
  WaitUntilKind,
} from "./recorder-types";

export type ResponseSegment =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string; closed: boolean };

/**
 * Tokenize a (possibly still-streaming) markdown-ish response into prose and
 * fenced code segments. An unterminated fence at the end is returned as a code
 * segment with `closed: false` so partial streamed output still renders as code.
 */
export function parseResponse(text: string): ResponseSegment[] {
  const segments: ResponseSegment[] = [];
  const lines = text.split("\n");
  let buffer: string[] = [];
  let inCode = false;
  let lang = "";

  const flushText = () => {
    const content = buffer.join("\n").replace(/^\n+|\n+$/g, "");
    if (content.trim()) segments.push({ type: "text", content });
    buffer = [];
  };

  for (const line of lines) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      if (!inCode) {
        flushText();
        inCode = true;
        lang = fence[1].trim();
      } else {
        segments.push({ type: "code", lang, content: buffer.join("\n"), closed: true });
        buffer = [];
        inCode = false;
        lang = "";
      }
    } else {
      buffer.push(line);
    }
  }

  if (inCode) {
    segments.push({ type: "code", lang, content: buffer.join("\n"), closed: false });
  } else {
    flushText();
  }
  return segments;
}

/**
 * Remove a reasoning model's inline thinking from a response.
 *
 * Two spellings are in the wild — `<think>` (DeepSeek's, which several local
 * runtimes echo) and `<thinking>` — and they arrive INSIDE the answer text,
 * which is a different channel from the `reasoning_content` / `reasoning` SSE
 * fields llm-service already splits out. An unterminated block runs to the end
 * of what we have: a stream cut mid-thought must not leave the whole tail
 * looking like an answer.
 *
 * Extraction only. The panel still RENDERS the raw text, because hiding a
 * model's reasoning from the person reading it is not this function's job —
 * the problem is that reasoning routinely contains bracketed prose, and
 * `extractStepsJson`'s widest-`[...]`-span fallback would happily span from a
 * bracket inside the thinking to the real answer's closing one and parse
 * neither. Stripping inside fenced code too is deliberate: a Playwright spec
 * containing a literal `<think>` tag is not a real case, and the alternative
 * (fence-aware stripping) is more machinery than the risk deserves.
 */
export function stripThinking(text: string): string {
  let out = text;
  for (const tag of ["think", "thinking"]) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*$`, "i"), "");
  }
  return out;
}

/**
 * Return the corrected full spec from a completed response, or null when the
 * response has no code block that plausibly represents a complete, applyable
 * Playwright spec. We require a *closed* fence containing both an `import` and a
 * `test(` call so we never overwrite the user's script with an illustrative
 * snippet or a partial file.
 */
export function extractCorrectedScript(text: string): string | null {
  const blocks = parseResponse(stripThinking(text)).filter(
    (s): s is Extract<ResponseSegment, { type: "code" }> => s.type === "code" && s.closed,
  );
  const candidates = blocks.filter((b) => /\btest\s*\(/.test(b.content) && /\bimport\b/.test(b.content));
  if (candidates.length === 0) return null;
  // Prefer the largest block — the full file rather than an excerpt.
  const best = candidates.reduce((a, b) => (b.content.length > a.content.length ? b : a));
  return `${best.content.trim()}\n`;
}

// ── Structured step extraction (AI "generate steps") ───────────────────

// EVERY step type the app has, not a subset. While this list held ten of the
// sixteen, the model could not produce a conditional, a cookie, a capture, a
// flow call or a pseudo-state step AT ALL — a valid one was dropped here and
// the user was told the response contained no usable steps, which reads as the
// model being bad at the job rather than the parser refusing the answer.
//
// This list is ADVISORY. `normalizeRawStep` (main/recorder/types.ts) is the
// authority and re-checks everything on the way in through `insertStep`; the
// job here is to drop what the app could not act on before it reaches the
// preview the user is asked to approve.
const STEP_TYPES = new Set<StepType>([
  "goto",
  "click",
  "fill",
  "press",
  "select",
  "check",
  "uncheck",
  "assert",
  "wait",
  "viewport",
  "if",
  "endif",
  "cookie",
  "capture",
  "runFlow",
  "state",
]);
/** Predicates an `if` step may carry. Deliberately its own list rather than a
 *  reuse of WAIT_UNTIL_KINDS — the backend keeps them separate for the same
 *  reason, so widening what a wait accepts cannot widen what a condition does. */
const CONDITION_KINDS = new Set<ConditionKind>([
  "visible",
  "hidden",
  "exists",
  "enabled",
  "disabled",
  "checked",
  "unchecked",
  "urlContains",
  "titleContains",
]);
const COOKIE_ACTIONS = new Set<CookieAction>(["set", "delete", "clearAll"]);
// These two already ship as exported arrays; a transcribed copy would be right
// the day it was written and silent forever after.
const CAPTURE_SOURCE_SET = new Set<CaptureSource>(CAPTURE_SOURCES);
const ELEMENT_STATE_SET = new Set<ElementState>(ELEMENT_STATES);
// All sixteen. `urlEndsWith`, `urlIs` and `css` were missing while the
// generate-steps PROMPT was already telling the model it could emit the first
// two — so a model that followed its instructions exactly had the step dropped
// here and never heard why.
const ASSERT_KINDS = new Set<AssertKind>([
  "visible",
  "hidden",
  "text",
  "exactText",
  "enabled",
  "disabled",
  "checked",
  "unchecked",
  "value",
  "attribute",
  "count",
  "url",
  "urlEndsWith",
  "urlIs",
  "title",
  "css",
]);
const CSS_MATCHES = new Set<CssMatch>(["is", "contains"]);
const WAIT_UNTIL_KINDS = new Set<WaitUntilKind>([
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
]);
const LOCATOR_KINDS = new Set<LocatorKind>([
  "testid",
  "role",
  "label",
  "placeholder",
  "text",
  "css",
  "xpath",
]);

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function validateStep(raw: unknown): RawStep | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const type = o.type as StepType;
  if (!STEP_TYPES.has(type)) return null;

  const step: RawStep = { type };
  const loc = o.locator as Record<string, unknown> | undefined;
  if (loc && typeof loc === "object" && LOCATOR_KINDS.has(loc.k as LocatorKind)) {
    step.locator = {
      k: loc.k as LocatorKind,
      v: str(loc.v),
      role: str(loc.role),
      name: str(loc.name),
    };
  }
  const value = str(o.value);
  if (value !== undefined) step.value = value;
  const url = str(o.url);
  if (url !== undefined) step.url = url;
  const text = str(o.text);
  if (text !== undefined) step.text = text;
  const label = str(o.label);
  if (label !== undefined) step.label = label;
  if (ASSERT_KINDS.has(o.assert as AssertKind)) step.assert = o.assert as AssertKind;
  if (o.soft === true) step.soft = true;
  const attr = str(o.attr);
  if (attr !== undefined) step.attr = attr;
  const count = num(o.count);
  if (count !== undefined) step.count = count;
  const width = num(o.width);
  if (width !== undefined) step.width = width;
  const height = num(o.height);
  if (height !== undefined) step.height = height;
  const waitMs = num(o.waitMs);
  if (waitMs !== undefined) step.waitMs = waitMs;
  if (WAIT_UNTIL_KINDS.has(o.waitUntil as WaitUntilKind)) step.waitUntil = o.waitUntil as WaitUntilKind;
  const timeoutMs = num(o.timeoutMs);
  if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;

  // A CSS assertion's property name is checked for shape, and STRICTLY than
  // the backend's `isCssPropName` on one point: a standard property must be
  // kebab-case. Playwright reads it through getPropertyValue(), which answers
  // "" for `backgroundColor`, so a camelCase name — the mistake a model
  // writing JavaScript all day is most likely to make — produces an assertion
  // that compares the expected value against an empty string and fails for a
  // reason nothing on screen explains. Better to drop it here, where the count
  // of generated steps is the only thing that changes. Custom properties are
  // exempt: `--fooBar` is case-sensitive and legitimately mixed-case.
  const cssProp = str(o.cssProp);
  const cssPropOk =
    cssProp !== undefined &&
    cssProp.length <= 100 &&
    (cssProp.startsWith("--")
      ? /^--[a-zA-Z][a-zA-Z0-9-]*$/.test(cssProp)
      : /^-?[a-z][a-z0-9-]*$/.test(cssProp));
  if (cssPropOk) step.cssProp = cssProp;
  if (CSS_MATCHES.has(o.cssMatch as CssMatch)) step.cssMatch = o.cssMatch as CssMatch;
  if (CONDITION_KINDS.has(o.cond as ConditionKind)) step.cond = o.cond as ConditionKind;
  if (ELEMENT_STATE_SET.has(o.elementState as ElementState)) {
    step.elementState = o.elementState as ElementState;
  }
  if (COOKIE_ACTIONS.has(o.cookieAction as CookieAction)) {
    step.cookieAction = o.cookieAction as CookieAction;
  }
  const cookie = o.cookie as Record<string, unknown> | undefined;
  if (cookie && typeof cookie === "object" && str(cookie.name)) {
    // Only the fields a generated cookie step actually needs. The backend
    // normalizer rebuilds this again (sameSite vocabulary, expiry bounds); the
    // point here is to carry a cookie the user can SEE in the preview.
    step.cookie = {
      name: str(cookie.name) as string,
      value: str(cookie.value),
      domain: str(cookie.domain),
      path: str(cookie.path),
      url: str(cookie.url),
    };
  }
  const captureVar = str(o.captureVar);
  if (captureVar !== undefined) step.captureVar = captureVar;
  const captureAttr = str(o.captureAttr);
  if (captureAttr !== undefined) step.captureAttr = captureAttr;
  if (CAPTURE_SOURCE_SET.has(o.captureFrom as CaptureSource)) {
    step.captureFrom = o.captureFrom as CaptureSource;
  }
  const flowId = str(o.flowId);
  if (flowId !== undefined) step.flowId = flowId;
  const flowArgs = o.flowArgs as Record<string, unknown> | undefined;
  if (flowArgs && typeof flowArgs === "object" && !Array.isArray(flowArgs)) {
    const args: Record<string, string> = {};
    for (const k of Object.keys(flowArgs)) {
      const v = str(flowArgs[k]);
      if (v !== undefined) args[k] = v;
    }
    if (Object.keys(args).length > 0) step.flowArgs = args;
  }

  // Steps that can't do anything without their key field are dropped. A step
  // kept without one reaches the preview looking real and then generates a
  // line that does nothing (or names `undefined`), which is worse than the
  // model being told it produced one fewer step.
  if (type === "assert" && !step.assert) return null;
  // A css assertion with no property compares nothing at all.
  if (type === "assert" && step.assert === "css" && !step.cssProp) return null;
  if (type === "goto" && !step.url) return null;
  if ((type === "click" || type === "fill" || type === "select" || type === "check" || type === "uncheck") && !step.locator) {
    return null;
  }
  // An `if` needs its predicate; the element ones additionally need something
  // to resolve, while urlContains/titleContains read `value` instead.
  if (type === "if") {
    if (!step.cond) return null;
    const pageCond = step.cond === "urlContains" || step.cond === "titleContains";
    if (pageCond ? step.value === undefined : !step.locator) return null;
  }
  // `clearAll` takes no cookie; set/delete are meaningless without one.
  if (type === "cookie") {
    if (!step.cookieAction) return null;
    if (step.cookieAction !== "clearAll" && !step.cookie) return null;
  }
  if (type === "capture" && (!step.captureVar || !step.locator)) return null;
  if (type === "runFlow" && !step.flowId) return null;
  if (type === "state" && (!step.elementState || !step.locator)) return null;
  return step;
}

/**
 * Extract a validated list of trainer steps from a (completed) LLM response.
 * Looks for a JSON array — preferring a fenced ```json block, else the widest
 * [...] span in the text — parses it, and keeps only entries that validate
 * against the step schema. Returns null when nothing usable is found.
 */
export function extractStepsJson(text: string): RawStep[] | null {
  // A reasoning model's inline thinking is prose, and prose contains brackets.
  // The widest-span fallback below would span from a bracket inside the
  // thinking to the answer's closing one and parse neither.
  const source = stripThinking(text);
  const candidates: string[] = [];

  // 1) Prefer closed fenced code blocks whose content looks like a JSON array.
  for (const seg of parseResponse(source)) {
    if (seg.type === "code" && seg.closed && seg.content.trim().startsWith("[")) {
      candidates.push(seg.content.trim());
    }
  }
  // 2) Fall back to the widest bracketed span in the raw text.
  const first = source.indexOf("[");
  const last = source.lastIndexOf("]");
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (!Array.isArray(parsed)) continue;
      const steps = parsed
        .map(validateStep)
        .filter((s): s is RawStep => s !== null);
      if (steps.length > 0) return steps;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
