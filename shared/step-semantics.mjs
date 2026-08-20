// What a step's predicate MEANS — the one definition, read by both engines.
//
// This file exists because the app had three of them. A recorded step was
// interpreted by the trainer's injected replayer (case-insensitive substring
// almost everywhere, evaluated once), by the generated Playwright spec (exact
// matching, whitespace-normalized, strict mode, retried), and by the UI copy
// that named the step for the user. Nothing compared the three, so they drifted
// until an assertion could be green in the trainer and impossible to pass in a
// run.
//
// The one that shipped: `assert: "url"` — labelled "URL contains" — generated
// `toHaveURL("<value>")`. A STRING argument to `toHaveURL` is an exact,
// whole-URL, case-sensitive equality check, and the field is pre-filled with a
// PATH (`/cart?step=2`), and the generated config declares no `baseURL`. So the
// line asserted `page.url() === "/cart?step=2"`, which is false for every page
// that has ever existed. It passed in the trainer every time. See DECISIONS
// 2026-08-13.
//
// Pure (see the admission rule in run-pacing.mjs): no fs, no IPC, no process,
// no DOM. `shared/` because the two consumers cannot share a `.ts` — the
// generator is compiled TypeScript, and the replayer is a STRING of JavaScript
// injected into an untrusted page. A transcribed copy of a matching rule is
// right the day it is written and silently divergent forever after, which is
// precisely the history this file ends.

/**
 * How an expected value is compared against what the page reports.
 *
 * Three fields, because three are what Playwright itself varies:
 *
 *  • `match` — "exact" | "substring" | "endsWith". The user-facing verb.
 *  • `caseSensitive` — whether A and a are the same character here.
 *  • `normalizeWhitespace` — whether runs of whitespace collapse to one space
 *    and the ends are trimmed, BEFORE comparing.
 *
 * The last two are not style choices. They are what Playwright's matchers do,
 * read out of `serializeExpectedTextValues` in playwright-core: `toHaveTitle`,
 * `toContainText` and `toHaveText` pass `normalizeWhiteSpace: true`;
 * `toHaveURL`, `toHaveValue` and `toHaveAttribute` pass nothing and compare the
 * raw string. Getting these wrong in the replayer is how a step passes live and
 * fails in a run, so they are recorded here rather than rediscovered.
 *
 * @typedef {object} MatchSemantics
 * @property {"exact"|"substring"|"endsWith"} match
 * @property {boolean} caseSensitive
 * @property {boolean} normalizeWhitespace
 */

/** URL comparisons ignore case; content comparisons do not.
 *
 *  Not an inconsistency — the two are different kinds of string. A URL's scheme
 *  and host are case-insensitive by RFC 3986, the recorder pre-fills URL
 *  assertions with a host at a site root, and the forgiving direction is the
 *  right one for a value the user did not type by hand: a recorder whose
 *  assertions fail on `HTTPS://Example.com` has invented a failure the product
 *  does not have. Page TEXT is the opposite — a heading that changed from
 *  "Checkout" to "CHECKOUT" is a real change, and Playwright's own default for
 *  every text matcher is case-sensitive. Both halves are enforced against real
 *  Playwright by the parity harness rather than asserted here. */
const URL_MATCH = { caseSensitive: false, normalizeWhitespace: false };
const TEXT_MATCH = { caseSensitive: true, normalizeWhitespace: true };
const RAW_MATCH = { caseSensitive: true, normalizeWhitespace: false };

/**
 * Every assert kind that compares a string, and how it compares it.
 *
 * Kinds absent from this table (`visible`, `checked`, `count`, `css`, …) do not
 * compare a free-text value against the page, so they have no entry; `css` is
 * the near-miss and is deliberately excluded because its match mode is carried
 * per-step in `cssMatch` rather than fixed by the kind.
 *
 * @type {Record<string, MatchSemantics>}
 */
export const ASSERT_SEMANTICS = {
  // "URL contains" — the label is the contract. Emitted as an unanchored
  // RegExp, which is the only `toHaveURL` argument shape that means "contains".
  url: { match: "substring", ...URL_MATCH },
  urlEndsWith: { match: "endsWith", ...URL_MATCH },
  urlIs: { match: "exact", ...URL_MATCH },

  // "URL path is" — an exact match of the URL's PATH, with the query string
  // and #fragment ignored. `part: "path"` is what says the comparison is not
  // against the whole href; the pattern itself comes from `urlPathPattern`
  // below, never from `textMatchExpr`. This kind exists because the other
  // three all compare the FULL URL, and real URLs carry noise the user never
  // chose: every recorded attempt at a URL assertion in this app's own history
  // failed on a `?variant=` or `utm_*` that differed between the recording and
  // the run. Asserting the path is the assertion those users meant.
  urlPathIs: { match: "exact", part: "path", ...URL_MATCH },

  // "Page title is" — exact, and the replayer was the half that disagreed. It
  // read a case-insensitive SUBSTRING, so "Cart" passed live against a page
  // titled "Cart | Acme" and failed in every run. `titleContains` below exists
  // so that fixing this takes nothing away from the user.
  title: { match: "exact", ...TEXT_MATCH },
  titleContains: { match: "substring", ...TEXT_MATCH },

  text: { match: "substring", ...TEXT_MATCH },
  exactText: { match: "exact", ...TEXT_MATCH },
  value: { match: "exact", ...RAW_MATCH },
  attribute: { match: "exact", ...RAW_MATCH },
};

/**
 * The same table for the `wait` step's predicates and the `if` step's
 * conditions, which share their vocabulary with each other but not quite with
 * the assert kinds (`urlContains` here is spelled `url` there).
 *
 * @type {Record<string, MatchSemantics>}
 */
export const WAIT_SEMANTICS = {
  urlContains: { match: "substring", ...URL_MATCH },
  titleContains: { match: "substring", ...TEXT_MATCH },
  text: { match: "substring", ...TEXT_MATCH },
  value: { match: "exact", ...RAW_MATCH },
};

/** The assert kind a wait/condition predicate shares its semantics with. Used
 *  by the parity harness to prove the two tables agree where they overlap —
 *  "wait until the URL contains X" and "assert the URL contains X" differing by
 *  a case rule would be the same class of bug one level down. */
export const WAIT_TO_ASSERT_KIND = {
  urlContains: "url",
  titleContains: "titleContains",
  text: "text",
  value: "value",
};

/**
 * Compare what the page reports against what the step expects.
 *
 * SELF-CONTAINED ON PURPOSE. `matchSource()` below serializes this function
 * into the replayer's injected script with `Function.prototype.toString`, so it
 * must not reference anything in this module's scope — a closure variable would
 * survive type-check, survive the build, and throw a ReferenceError inside a
 * page the user is watching. It is also written in ES5-compatible syntax for
 * the same reason: it runs in whatever the site's JS engine is, alongside code
 * that may have replaced the globals.
 *
 * @param {string} actual   what the page reports
 * @param {string} expected what the step asks for
 * @param {MatchSemantics} semantics
 * @returns {boolean}
 */
export function matchesValue(actual, expected, semantics) {
  var a = actual == null ? "" : String(actual);
  var b = expected == null ? "" : String(expected);
  if (semantics.normalizeWhitespace) {
    a = a.replace(/\s+/g, " ").replace(/^ | $/g, "");
    b = b.replace(/\s+/g, " ").replace(/^ | $/g, "");
  }
  if (!semantics.caseSensitive) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  if (semantics.match === "exact") return a === b;
  // An empty expectation is `endsWith`'s trap: `"".slice(-0)` is the WHOLE
  // string, not "", so the naive form reports false for every page while the
  // generated `new RegExp("$")` matches every page. Neither is what the user
  // meant, and they disagree — so it is answered explicitly here and refused
  // outright at the generator (see `assertLine`).
  if (semantics.match === "endsWith") return b === "" ? a === "" : a.slice(a.length - b.length) === b;
  return a.indexOf(b) >= 0;
}

/** `matchesValue` as source text, for embedding in the replayer's injected
 *  script.
 *
 *  `toString()` rather than a second hand-written copy, because a second copy
 *  is the exact failure this module exists to end. esbuild may rename the
 *  function's internals when it bundles; the emitted text stays valid
 *  JavaScript, and the injected script calls it under the name it binds here
 *  rather than the function's own. */
export function matchSource() {
  return "var matchesValue = " + matchesValue.toString() + ";";
}

/** Escape regex metacharacters so a literal string can be embedded in a RegExp.
 *
 *  The two that matter for the values this app generates are both in every real
 *  URL: an unescaped `.` matches ANY character (so `example.com` also matches
 *  `exampleXcom` — a false pass), and an unescaped `?` makes the preceding
 *  character optional (so `/cart?step=2` matches neither the literal `?` nor
 *  the path — a failure on every run). */
export function reEscape(s) {
  return String(s == null ? "" : s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The RegExp source a `toHaveURL` / `toHaveTitle` call needs to mean what the
 * step's label says.
 *
 * Here rather than in the generator because THREE places build this string: the
 * generator (what runs), `renderer/lib/describe-step.ts` (what the step list
 * shows the user), and the parity harness (what proves the two agree). Three
 * copies of a rule is the shape of the bug this whole module exists to end, and
 * the display copy silently disagreeing with the emitted one would be the worst
 * of the three — the user reading a correct assertion that never ran.
 *
 * @param {string} value
 * @param {MatchSemantics} semantics
 * @returns {string} JavaScript source, e.g. `new RegExp("/cart\\?step=2", "i")`
 */
export function textMatchExpr(value, semantics) {
  const body = reEscape(value);
  const pattern =
    semantics.match === "exact" ? "^" + body + "$" : semantics.match === "endsWith" ? body + "$" : body;
  return "new RegExp(" + JSON.stringify(pattern) + (semantics.caseSensitive ? "" : ", \"i\"") + ")";
}

/**
 * The RegExp source (pattern only, no flags) for a "URL path is" assertion.
 *
 * One pattern, three readers: the generator embeds it in a `toHaveURL` call,
 * the replayer tests it against `location.href`, and `describe-step` shows it
 * in the step list. The pattern anchors on the URL's structure rather than
 * comparing extracted parts, so both engines can apply it to the same string —
 * the full URL — and cannot disagree about how a path is carved out of it:
 *
 *   ^[a-z][a-z0-9+.-]*://   the scheme
 *   [^/?#]*                 host (+ port, + userinfo) — everything up to the
 *                           path, which cannot contain `/`, `?` or `#`
 *   <the expected path>     regex-escaped literal
 *   /?                      one trailing slash tolerated: /cart and /cart/ are
 *                           the same resource on every server this app has met,
 *                           and servers canonicalize in both directions
 *   (?:[?#]|$)              then the query, the fragment, or the end — which is
 *                           what makes ?variant= and utm_* noise invisible here
 *
 * The expected value is normalized the way a user types paths: a missing
 * leading slash is added, trailing slashes are dropped ("/" itself becomes ""
 * so the root asserts as scheme://host/ with or without the slash). Compared
 * case-insensitively by every caller (the "i" flag), same as the other URL
 * kinds — see URL_MATCH above.
 *
 * SELF-CONTAINED ON PURPOSE, exactly like `matchesValue`: `urlPathSource()`
 * serializes this function into the replayer's injected script, so it inlines
 * the escape rule rather than calling `reEscape` — a module-scope reference
 * would be renamed by esbuild and throw inside the page. A test pins the two
 * escape spellings together.
 *
 * @param {string} value the expected path, e.g. "/cart"
 * @returns {string} RegExp source; test with the "i" flag
 */
export function urlPathPattern(value) {
  var v = String(value == null ? "" : value);
  if (v !== "" && v.charAt(0) !== "/") v = "/" + v;
  while (v.length > 1 && v.charAt(v.length - 1) === "/") v = v.slice(0, v.length - 1);
  if (v === "/") v = "";
  var body = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return "^[a-z][a-z0-9+.-]*://[^/?#]*" + body + "/?(?:[?#]|$)";
}

/** `urlPathPattern` as source text, on the same terms as `matchSource`. */
export function urlPathSource() {
  return "var urlPathPattern = " + urlPathPattern.toString() + ";";
}

/** The `toHaveURL` argument for a "URL path is" assertion, as JavaScript
 *  source — the counterpart of `textMatchExpr` for the one kind whose pattern
 *  is structural rather than a match-mode wrapper around the literal. */
export function urlPathExpr(value) {
  return "new RegExp(" + JSON.stringify(urlPathPattern(value)) + ", \"i\")";
}

/**
 * Playwright's visibility rule, as the replayer must implement it.
 *
 * Named here rather than left in the replayer because it had TWO independent
 * mismatches, in opposite directions, and each produced a different flavour of
 * wrong answer:
 *
 *  • The replayer required `width <= 0 && height <= 0` to call an element
 *    hidden. Playwright's rule is a non-empty bounding box — width OR height of
 *    zero is hidden. A 0×10 element was visible to the trainer and hidden to
 *    the run.
 *  • The replayer treated `opacity: 0` as hidden. Playwright does not consider
 *    opacity at all. A faded-in element was hidden to the trainer and visible
 *    to the run — the reverse failure, which trains the user to ignore a red
 *    step that the run would have passed.
 *
 * @param {{width: number, height: number}} rect
 * @param {{visibility: string, display: string}} style
 * @returns {boolean}
 */
export function isVisibleByRect(rect, style) {
  if (!rect || !style) return false;
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  return style.visibility !== "hidden" && style.display !== "none";
}

/** `isVisibleByRect` as source text, on the same terms as `matchSource`. */
export function visibilitySource() {
  return "var isVisibleByRect = " + isVisibleByRect.toString() + ";";
}
