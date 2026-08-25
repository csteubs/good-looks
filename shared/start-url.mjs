// What the app actually OPENS when a person types a site to record.
//
// Typing `example.com` in the New recording dialog has always worked — the
// backend prepends the scheme before it navigates. Nothing on screen said so
// (#134): the placeholder disappears at the first keystroke, so the field shows
// `example.com` and the training browser opens something the user was never
// told about. Saying it needs the renderer to know the rule, and a transcribed
// regex is right the day it is written and silently divergent afterwards — so
// the rule moved here rather than being copied. It is the same shape as
// `basic-auth.mjs` and `heal-key.mjs`: the DECISION is shared, the places that
// act on it stay on their own side.
//
// Pure: no fs, no IPC, no process.
//
// ── NOT FOR EVERY URL IN THE APP, AND THE NAME SAYS WHICH ONE ──────────
//
// This is the START url of a recording — an address a person typed, which must
// resolve on its own. A `goto` step's URL is NOT this: since a test's site
// address became a variable, `page.goto("/checkout")` under a `baseUrl` is
// correct and prefixing it would break the test in the one place the failure
// looks like a product bug. Anything reaching the generator stays as recorded.

/** True when the input already names a scheme this app can open. Case-
 *  insensitive, because a pasted `HTTPS://` is still a scheme. */
export function hasScheme(input) {
  return /^https?:\/\//i.test(String(input).trim());
}

/**
 * The address a typed site resolves to.
 *
 * `https` rather than `http` for the obvious reason, and deliberately WITHOUT a
 * fallback: guessing `http` for a host that refuses TLS would mean silently
 * downgrading a connection, and the app cannot know which hosts those are. A
 * user who needs `http://localhost:3000` types the scheme — which is precisely
 * why the resolved address is now shown rather than only computed. The rule is
 * unchanged from the private copy this replaces; only its home is new.
 */
export function normalizeStartUrl(input) {
  const trimmed = String(input).trim();
  return hasScheme(trimmed) ? trimmed : "https://" + trimmed;
}
