// THE ONE PLACE A BASE URL BECOMES TRUSTED, wherever it came from.
//
// A parsed `playwright.config`, a field the user typed into the app, and — as
// of R5 — a `--base-url` on the command line all go through this.
//
// ── Why it is shared ─────────────────────────────────────────────────────
// It lived in `main/services/imported-config.ts` while the only ways in were an
// import and an IPC call, both main-process. R5 adds a third: a CLI flag, in
// plain `.mjs` that cannot import compiled TypeScript. The plan asks for the
// override to be "validated through the same `normalizeBaseUrl` gate every
// other path uses", and a transcribed copy of a validator is right the day it
// is written and silently divergent afterwards — the direction it fails being
// the CLI accepting a URL the app refuses.
//
// Pure, so it belongs here: `URL` is a global, and nothing else is touched.
// `imported-config.ts` re-exports it, so its own callers see one module still.
//
// ── What it refuses, and why each ────────────────────────────────────────
//  - a non-string, so a hand-edited JSON store or an IPC caller cannot smuggle
//    an object through;
//  - anything containing `${`, because an un-interpolated variable reference
//    would otherwise be resolved as a literal hostname;
//  - any protocol but http/https. `file://` would make a run read the local
//    disk, and `app://` is this application's own scheme.
//
// It returns the PARSED href rather than the input, so the value stored and the
// value compared are one spelling: `HTTPS://Shop.Example.COM` and
// `https://shop.example.com/` are the same base URL and must not read as two.

/**
 * @param {unknown} value
 * @returns {string | null} the normalized href, or null when it is not a base
 *   URL this application will use.
 */
export function normalizeBaseUrl(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.includes("${")) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}
