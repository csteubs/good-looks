// The host side of ghost text: what gets sent, and when to stop asking.
//
// The editor extension (`renderer/main/ghost-text.ts`) asks a source once
// per pause in typing with the whole document split at the caret. This
// bounds that — a 2000-line spec is more context than a fill-in-the-middle
// model uses and more than an `/api/generate` call wants per keystroke — and
// backs off from a server that is not answering, so an Ollama that is not
// running costs one failed request every BACKOFF_MS rather than one per
// pause.
//
// Pure, so its rules can be tested without an editor.

export interface FimCall {
  (params: { prefix: string; suffix: string; maxTokens?: number }): Promise<{ text: string }>;
}

export const PREFIX_CHARS = 6000;
export const SUFFIX_CHARS = 2000;
export const MAX_TOKENS = 96;
export const BACKOFF_MS = 15_000;

export function boundedWindow(prefix: string, suffix: string): { prefix: string; suffix: string } {
  // Cut the prefix at a line start so the model never sees half a token
  // of a line it has no beginning for; the suffix at a line end likewise.
  let p = prefix.length > PREFIX_CHARS ? prefix.slice(prefix.length - PREFIX_CHARS) : prefix;
  if (p.length < prefix.length) {
    const nl = p.indexOf("\n");
    if (nl !== -1 && nl < p.length - 1) p = p.slice(nl + 1);
  }
  let s = suffix.length > SUFFIX_CHARS ? suffix.slice(0, SUFFIX_CHARS) : suffix;
  if (s.length < suffix.length) {
    const nl = s.lastIndexOf("\n");
    if (nl > 0) s = s.slice(0, nl);
  }
  return { prefix: p, suffix: s };
}

/** Build a ghost-text source over the app's `llm:fim` call. `now` is
 *  injectable for the backoff's clock. */
export function makeGhostSource(fim: FimCall, now: () => number = () => Date.now()) {
  let quietUntil = 0;
  return async (prefix: string, suffix: string, signal: AbortSignal): Promise<string> => {
    if (now() < quietUntil) return "";
    const window = boundedWindow(prefix, suffix);
    try {
      const res = await fim({ ...window, maxTokens: MAX_TOKENS });
      if (signal.aborted) return "";
      quietUntil = 0;
      return res.text;
    } catch {
      // Offline server, no model assigned, a hosted slot refused: all of
      // them the same from here — stop asking for a while.
      quietUntil = now() + BACKOFF_MS;
      return "";
    }
  };
}
