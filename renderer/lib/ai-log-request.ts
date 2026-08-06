// Detecting that the model has ASKED for more data.
//
// The model can request the run's recorded console and network logs by ending
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
export type LogRequestNeed = "console" | "network";

export const ALL_NEEDS: LogRequestNeed[] = ["console", "network"];

export interface LogRequest {
  need: LogRequestNeed[];
  /** The model's stated reason, shown to the user so the ask is judgeable. */
  why: string;
}

/** The instruction appended to the debug system prompt. Exported so the prompt
 *  and the parser can't drift into describing different formats. */
export const LOG_REQUEST_PROTOCOL = [
  "If you need the page's console output or network activity to diagnose this,",
  "you may ask for it. End your reply with a fenced block exactly like this and",
  "write nothing after it:",
  "",
  "```glaze-request",
  '{"need": ["console", "network"], "why": "one short sentence"}',
  "```",
  "",
  'Use only "console" and/or "network". Ask ONLY if the data would change your',
  "diagnosis — the user has to approve the request and it costs them a round trip.",
  "Do not ask for anything else, and do not use this block for any other purpose.",
].join("\n");

const FENCE = /```glaze-request\s*\n([\s\S]*?)```/g;

function normalizeNeed(value: unknown): LogRequestNeed | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "console" || v === "network" ? v : null;
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

/** Human phrasing for what was asked for. */
export function describeNeed(need: LogRequestNeed[]): string {
  if (need.length === 2) return "the console output and network activity";
  return need[0] === "console" ? "the console output" : "the network activity";
}
