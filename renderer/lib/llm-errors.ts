// Adds "…and here is where to fix it" to an LLM failure message.
//
// The backend (llm-service.ts, via llm/provider-errors.ts) already produces one
// actionable sentence. This only appends the pointer to the setting that fixes
// it — and which pointer to append is decided by the error's KIND, which
// travels with it from the code that knows.
//
// It used to be decided by regex-matching the message text, which misfires the
// moment a message legitimately contains a trigger word. It did: an
// empty-response message reading "…so this is not a connection or timeout
// problem" matched /timeout/ and had "Open Settings → AI provider to check the
// connection" appended, contradicting itself in the same paragraph. Text
// matching cannot be made safe here, because the messages quote providers and
// describe transport problems by name.

import type { LlmErrorKind } from "./llm-types";

const SETTINGS_HINT = "Open Settings (⌘,) → AI provider";

function hintFor(kind: LlmErrorKind): string | null {
  switch (kind) {
    case "no-model":
      return `${SETTINGS_HINT} to pick one.`;
    case "auth":
      return `${SETTINGS_HINT} to update your API key.`;
    case "connection":
      return `${SETTINGS_HINT} to check the connection.`;
    case "model-unavailable":
      // The message already says to load/pull it or choose another, and the
      // model is changeable from the dialog title — Settings is the wrong place
      // to send someone, and the connection is fine.
      return "You can change the model from the title of this window.";
    case "empty-response":
      // Nothing is misconfigured: the request completed. Any pointer here is
      // an invitation to change a setting that was never the problem.
      return null;
    case "provider":
      return null;
    default: {
      const never: never = kind;
      throw new Error(`Unhandled LLM error kind: ${String(never)}`);
    }
  }
}

/** Legacy path: classify by text when no kind travelled with the error.
 *
 *  Only reached for errors raised before kinds existed (a session restored from
 *  disk) or by a caller that doesn't forward one. Ordered most-specific first,
 *  and it deliberately refuses to offer connection advice to a message that
 *  says the request completed. */
function guessKind(message: string): LlmErrorKind | null {
  if (/no model selected/i.test(message)) return "no-model";
  if (/couldn't load the model|failed to load model|model not found|model_not_found/i.test(message)) {
    return "model-unavailable";
  }
  if (/invalid api key|rejected the api key|add your anthropic api key/i.test(message)) return "auth";
  if (/completed normally|not a connection/i.test(message)) return "empty-response";
  if (/could not reach|make sure it is running|check your internet/i.test(message)) return "connection";
  if (/abort|timeout|econnrefused|fetch failed|network/i.test(message)) return "connection";
  return null;
}

export function friendlyError(message: string, kind?: LlmErrorKind | null): string {
  const resolved = kind ?? guessKind(message);
  if (!resolved) return message;
  const hint = hintFor(resolved);
  return hint ? `${message} ${hint}` : message;
}
