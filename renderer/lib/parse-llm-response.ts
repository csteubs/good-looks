// Splits an LLM debug response into prose and fenced ```code``` segments so the
// panel can render suggested code changes as distinct, copyable blocks and offer
// to apply a corrected spec. Written to tolerate a still-streaming response.

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
