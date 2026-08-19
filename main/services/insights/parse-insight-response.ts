// Model text → a validated report body, or an honest prose fallback.
//
// The response crosses a trust boundary: it was steered by test names and
// error text a web page can influence, and its actions drive buttons. So
// nothing here is spread or trusted — candidates are parsed, then rebuilt
// field-by-field through the normalizers in main/recorder/types.ts, and an
// action naming a test the model was never shown is dropped before it is ever
// persisted.
//
// Candidate strategy mirrors the generate-steps parser
// (renderer/lib/parse-llm-response.ts `extractStepsJson`, which cannot be
// imported across the process boundary): fenced code blocks first — models
// follow the "one fenced json block" instruction most of the time — then the
// widest {...} span for the ones that chat around it. If nothing parses, the
// answer is kept as a DEGRADED prose report rather than thrown away: a
// scheduled feature that discards a paid completion because the model chatted
// has nothing to show for the period, which reads as "it didn't run".

import {
  MAX_INSIGHT_ACTIONS,
  MAX_INSIGHT_HEADLINE_CHARS,
  MAX_INSIGHT_SECTIONS,
  normalizeInsightAction,
  normalizeInsightSection,
  type InsightAction,
  type InsightSection,
} from "../../recorder/types.js";

export interface ParsedInsightResponse {
  headline: string;
  sections: InsightSection[];
  actions: InsightAction[];
  degraded: boolean;
}

/** Fenced code blocks, contents only. Tolerates an unclosed trailing fence —
 *  a model cut off mid-answer still yields its block. */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  let inFence = false;
  let current: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (inFence) {
        blocks.push(current.join("\n"));
        current = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) current.push(line);
  }
  if (inFence && current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

function jsonCandidates(text: string): string[] {
  const candidates = fencedBlocks(text)
    .map((b) => b.trim())
    .filter((b) => b.startsWith("{"));
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  return candidates;
}

function clampHeadline(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > MAX_INSIGHT_HEADLINE_CHARS
    ? `${s.slice(0, MAX_INSIGHT_HEADLINE_CHARS - 1)}…`
    : s;
}

/** One candidate → a report body, or null when it isn't one. */
function tryCandidate(
  candidate: string,
  knownTestIds: ReadonlySet<string>,
): Omit<ParsedInsightResponse, "degraded"> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  const headline = clampHeadline(raw.headline);
  if (!headline) return null;
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .slice(0, MAX_INSIGHT_SECTIONS)
    .map(normalizeInsightSection)
    .filter((s): s is InsightSection => s !== null);
  const actions = (Array.isArray(raw.actions) ? raw.actions : [])
    .slice(0, MAX_INSIGHT_ACTIONS)
    .map((a) => normalizeInsightAction(a, knownTestIds))
    .filter((a): a is InsightAction => a !== null);
  return { headline, sections, actions };
}

export function parseInsightResponse(
  text: string,
  knownTestIds: ReadonlySet<string>,
): ParsedInsightResponse {
  for (const candidate of jsonCandidates(text)) {
    const parsed = tryCandidate(candidate, knownTestIds);
    if (parsed) return { ...parsed, degraded: false };
  }
  // Prose fallback. No actions — a button parsed out of free text is a guess
  // with side effects, and the label under the report says why it has none.
  const trimmed = text.trim();
  const firstLine =
    trimmed
      .split("\n")
      .map((l) => l.replace(/^[#*>\s`-]+/, "").trim())
      .find((l) => l.length > 0) ?? "Report";
  return {
    headline: clampHeadline(firstLine),
    sections: trimmed ? [{ title: "Report", body: trimmed.slice(0, 4000) }] : [],
    actions: [],
    degraded: true,
  };
}
