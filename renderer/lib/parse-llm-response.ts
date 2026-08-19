// Splits an LLM debug response into prose and fenced ```code``` segments so the
// panel can render suggested code changes as distinct, copyable blocks and offer
// to apply a corrected spec. Written to tolerate a still-streaming response.

import {
  ASSERT_KINDS as ALL_ASSERT_KINDS,
  LOCATOR_KINDS as ALL_LOCATOR_KINDS,
  WAIT_UNTIL_KINDS as ALL_WAIT_UNTIL_KINDS,
} from "./recorder-types";
import type {
  AssertKind,
  Locator,
  LocatorContext,
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
 * Return the corrected full spec from a completed response, or null when the
 * response has no code block that plausibly represents a complete, applyable
 * Playwright spec. We require a *closed* fence containing both an `import` and a
 * `test(` call so we never overwrite the user's script with an illustrative
 * snippet or a partial file.
 */
export function extractCorrectedScript(text: string): string | null {
  const blocks = parseResponse(text).filter(
    (s): s is Extract<ResponseSegment, { type: "code" }> => s.type === "code" && s.closed,
  );
  const candidates = blocks.filter((b) => /\btest\s*\(/.test(b.content) && /\bimport\b/.test(b.content));
  if (candidates.length === 0) return null;
  // Prefer the largest block — the full file rather than an excerpt.
  const best = candidates.reduce((a, b) => (b.content.length > a.content.length ? b : a));
  return `${best.content.trim()}\n`;
}

// ── Structured step extraction (AI "generate steps") ───────────────────

// Deliberately a SUBSET of the real `STEP_TYPES`, unlike the three lists below.
// The AI-steps flow generates a flat sequence of actions and assertions; `if`,
// `endif`, `cookie`, `capture`, `runFlow` and `state` are composed in the
// trainer and are not the model's to emit. Narrow on purpose, so a check that
// pins the others must not pin this one.
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
]);
// Derived from the mirror lists, NOT hand-written.
//
// These were three transcribed copies, and the assert one had drifted: it
// omitted `urlEndsWith`, `urlIs` and `css` while the prompt actively told the
// model to emit `urlEndsWith`. `validateStep` drops an assert step with no
// recognised kind, so those steps vanished with no error and no count — the
// user got fewer steps than the model wrote and nothing said why.
const ASSERT_KINDS = new Set<AssertKind>(ALL_ASSERT_KINDS);
const WAIT_UNTIL_KINDS = new Set<WaitUntilKind>(ALL_WAIT_UNTIL_KINDS);
const LOCATOR_KINDS = new Set<LocatorKind>(ALL_LOCATOR_KINDS);

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Rebuild a locator out of checked values — same discipline as
 * `normalizeLocator` in main/recorder/types.ts: known fields only, never a
 * spread, so an unknown key from the model cannot ride through to a step.
 * `allowContext` is the recursion guard, not a feature flag: `ctx` holds
 * locators of its own, so the type is self-referential, and one level is all
 * the picker produces and all the generator emits — the inner calls pass
 * `false` and a `ctx` on a context locator is dropped rather than recursed
 * into.
 */
function validateLocator(raw: unknown, allowContext: boolean): Locator | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const loc = raw as Record<string, unknown>;
  if (!LOCATOR_KINDS.has(loc.k as LocatorKind)) return undefined;
  // `nth` carried through, because the model is now told it may pin down
  // which of several matches it means. Without it a step against a page with
  // two "Save" buttons is a strict-mode failure the model had no way to avoid.
  const nth = num(loc.nth);
  const out: Locator = {
    k: loc.k as LocatorKind,
    v: str(loc.v),
    role: str(loc.role),
    name: str(loc.name),
    ...(nth !== undefined && nth >= 0 ? { nth: Math.trunc(nth) } : {}),
  };
  if (allowContext) {
    const ctx = validateLocatorContext(loc.ctx);
    if (ctx) out.ctx = ctx;
  }
  return out;
}

/**
 * Rebuild a locator's element context, mirroring `normalizeLocatorContext`:
 * `withinHasText` filters the CONTAINER, so without `within` it is dropped
 * rather than reinterpreted as a filter on the target, and a context that
 * validates to nothing is `undefined` rather than `{}` — absent and empty
 * must stay the same value.
 */
function validateLocatorContext(raw: unknown): LocatorContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const out: LocatorContext = {};
  const within = validateLocator(c.within, false);
  if (within) {
    out.within = within;
    const hasText = str(c.withinHasText);
    if (hasText !== undefined) out.withinHasText = hasText;
  }
  if (Array.isArray(c.and)) {
    const and: Locator[] = [];
    for (const p of c.and) {
      const loc = validateLocator(p, false);
      if (loc) and.push(loc);
    }
    if (and.length > 0) out.and = and;
  }
  return out.within || out.and ? out : undefined;
}

function validateStep(raw: unknown): RawStep | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const type = o.type as StepType;
  if (!STEP_TYPES.has(type)) return null;

  const step: RawStep = { type };
  const locator = validateLocator(o.locator, true);
  if (locator) step.locator = locator;
  const value = str(o.value);
  if (value !== undefined) step.value = value;
  const url = str(o.url);
  if (url !== undefined) step.url = url;
  const text = str(o.text);
  if (text !== undefined) step.text = text;
  const cssProp = str(o.cssProp);
  if (cssProp !== undefined) step.cssProp = cssProp;
  if (o.cssMatch === "is" || o.cssMatch === "contains") step.cssMatch = o.cssMatch;
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

  // Steps that can't do anything without their key field are dropped.
  if (type === "assert" && !step.assert) return null;
  if (type === "goto" && !step.url) return null;
  if ((type === "click" || type === "fill" || type === "select" || type === "check" || type === "uncheck") && !step.locator) {
    return null;
  }
  return step;
}

/**
 * Extract a validated list of trainer steps from a (completed) LLM response.
 * Looks for a JSON array — preferring a fenced ```json block, else the widest
 * [...] span in the text — parses it, and keeps only entries that validate
 * against the step schema. Returns null when nothing usable is found.
 */
export function extractStepsJson(text: string): RawStep[] | null {
  const candidates: string[] = [];

  // 1) Prefer closed fenced code blocks whose content looks like a JSON array.
  for (const seg of parseResponse(text)) {
    if (seg.type === "code" && seg.closed && seg.content.trim().startsWith("[")) {
      candidates.push(seg.content.trim());
    }
  }
  // 2) Fall back to the widest bracketed span in the raw text.
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

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
