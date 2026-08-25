// WHEN a URL field should say what it will actually open, and what it says.
//
// The scheme rule itself lives in `shared/start-url.mjs` — both processes need
// it and neither may transcribe it. What lives here is the display decision on
// top of it, which is a renderer question and has exactly one right answer for
// every field that takes a typed site: say something only when the app is
// ADDING something the user did not type.
//
// A note that repeats the field back ("Opens https://example.com" under
// `https://example.com`) is noise, and noise beside a field is how people stop
// reading the one time it matters. Two dialogs ask this question — New
// recording and Generate test — so the answer is written once.

import { normalizeStartUrl } from "../../shared/start-url.mjs";

/**
 * The address to show under the field, or null when there is nothing worth
 * saying — empty input, or an input that already names its own scheme.
 *
 * `http://localhost:3000` therefore shows nothing, which is correct twice
 * over: it opens exactly as typed, and the absence of a note is what tells the
 * user their scheme survived rather than being upgraded behind their back.
 */
export function startUrlHint(typed: string): string | null {
  const trimmed = typed.trim();
  if (!trimmed) return null;
  const resolved = normalizeStartUrl(trimmed);
  return resolved === trimmed ? null : resolved;
}
