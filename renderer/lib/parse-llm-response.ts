// Splits an LLM debug response into prose and fenced ```code``` segments so the
// panel can render suggested code changes as distinct, copyable blocks and offer
// to apply a corrected spec. Written to tolerate a still-streaming response.

import type { AssertKind, LocatorKind, RawStep, StepType } from "./recorder-types";

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
  "title",
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
