// Detecting that the model has ASKED for more data.
//
// The model can request the run's recorded console output, network activity, or
// the page structure Auto-Heal captured around the failing step, by ending
// its reply with a fenced block tagged `glaze-request`. Detection is
// deliberately strict, because the cost of the two failure directions is wildly
// asymmetric:
//
//   • A miss is harmless — the user reads the reply and can ask again.
//   • A FALSE POSITIVE offers to send page console text and request URLs to a
//     model (a hosted one, potentially) on the strength of the model merely
//     mentioning logs in prose. "You should check the console for errors" is a
//     completely ordinary sentence for it to write, and it must never arm a
//     send button.
//
// So: a fenced block, tagged exactly `glaze-request`, containing valid JSON,
// with a `need` array of known values. Nothing else counts — not a bare JSON
// object, not an untagged fence, not the words in prose.

/** Kinds of data the model may ask for. */
export type LogRequestNeed = "console" | "network" | "structure";

export const ALL_NEEDS: LogRequestNeed[] = ["console", "network", "structure"];

export interface LogRequest {
  need: LogRequestNeed[];
  /** The model's stated reason, shown to the user so the ask is judgeable. */
  why: string;
}

/** What each need gets described as inside the protocol block. */
const NEED_DESCRIPTIONS: Record<LogRequestNeed, string> = {
  console: '"console" — everything the page logged, including uncaught errors',
  network: '"network" — the requests the page made, with status and timing',
  structure:
    '"structure" — every element the failing locator actually matched, each with' +
    " its tag, attributes, text, scoping ancestors and whether it was visible," +
    " plus any similar elements Auto-Heal found nearby. This is what to ask for" +
    " when a locator matched the wrong element or matched several, and it is the" +
    " only way to see the page: you cannot be sent a screenshot or raw HTML.",
};

/**
 * The instruction appended to the debug system prompt. Exported so the prompt
 * and the parser can't drift into describing different formats.
 *
 * Takes the needs this run can actually supply. Advertising one the app cannot
 * answer teaches the model to ask for things nobody can hand over, which costs
 * the user a round trip to find out — the same reason the protocol is only
 * appended at all when the run recorded something.
 */
export function logRequestProtocol(available: LogRequestNeed[]): string {
  const needs = ALL_NEEDS.filter((n) => available.includes(n));
  if (needs.length === 0) return "";
  const example = JSON.stringify({ need: needs, why: "one short sentence" });
  return [
    "If you need more data about the run to diagnose this, you may ask for it.",
    "End your reply with a fenced block exactly like this and write nothing after it:",
    "",
    "```glaze-request",
    example,
    "```",
    "",
    "Available values:",
    ...needs.map((n) => `- ${NEED_DESCRIPTIONS[n]}`),
    "",
    "Ask ONLY if the data would change your diagnosis — the user has to approve",
    "the request and it costs them a round trip. Do not ask for anything else and",
    "do not use this block for any other purpose.",
    "",
    "This REPLACES asking in prose. The instruction above to say what additional",
    "information would help applies only to data not listed here: if what you need",
    "is one of the values above, ask for it with this block instead of describing",
    "it, and never ask the user to paste in a screenshot or HTML by hand.",
  ].join("\n");
}

const FENCE = /```glaze-request\s*\n([\s\S]*?)```/g;

function normalizeNeed(value: unknown): LogRequestNeed | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (ALL_NEEDS as string[]).includes(v) ? (v as LogRequestNeed) : null;
}

/**
 * Extract a log request from a model reply, or null.
 *
 * The LAST matching block wins: a model that reconsiders mid-reply, or that
 * echoes the protocol's example before writing its real request, should be
 * taken at its final word.
 */
export function parseLogRequest(response: string): LogRequest | null {
  if (!response) return null;
  const matches = [...response.matchAll(FENCE)];
  if (matches.length === 0) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    const body = matches[i][1]?.trim();
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // A malformed block is not a request. Guessing at intent here would
      // reintroduce exactly the looseness this parser exists to avoid.
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as { need?: unknown; why?: unknown };
    const rawNeed: unknown[] = Array.isArray(obj.need) ? obj.need : [];
    if (rawNeed.length === 0) continue;
    // De-duplicated, and ordered canonically rather than however the model
    // happened to list them, so downstream comparisons are stable.
    const need = ALL_NEEDS.filter((n) => rawNeed.some((raw) => normalizeNeed(raw) === n));
    if (need.length === 0) continue;
    const why = typeof obj.why === "string" ? obj.why.trim() : "";
    return { need, why };
  }
  return null;
}

/** Strip the request block from a reply so the prose can be rendered without
 *  the machine-readable tail the user has no reason to read. */
export function stripLogRequest(response: string): string {
  return response.replace(FENCE, "").replace(/\n{3,}$/, "\n").trimEnd();
}

/** Phrased without the article, so combinations read as one noun phrase under
 *  a single "the" rather than repeating it per item. */
const NEED_PHRASES: Record<LogRequestNeed, string> = {
  console: "console output",
  network: "network activity",
  structure: "page structure around the failing step",
};

/** Human phrasing for what was asked for. */
export function describeNeed(need: LogRequestNeed[]): string {
  // Canonical order, so the sentence doesn't change with the model's phrasing.
  const phrases = ALL_NEEDS.filter((n) => need.includes(n)).map((n) => NEED_PHRASES[n]);
  if (phrases.length === 0) return "more data";
  const last = phrases[phrases.length - 1];
  return phrases.length === 1 ? `the ${last}` : `the ${phrases.slice(0, -1).join(", ")} and ${last}`;
}
