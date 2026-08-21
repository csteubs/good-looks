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

/**
 * How a VARIABLE's value is compared against an expected one.
 *
 * A separate vocabulary from the tables above, and deliberately so: those
 * describe what a step asks of the PAGE, and Playwright's web-first matchers
 * fix their own case and whitespace rules. This one describes a comparison
 * between two plain strings the run already holds — a captured value, a JSON
 * field an API step pulled out, a dataset cell — so the semantics are the ones
 * the emitted matcher really has, which is:
 *
 *   RAW. Case-sensitive, no whitespace normalization.
 *
 * That is not a preference, it is a reading of `toBe`, `toContain` and
 * `toMatch`, none of which normalize anything. Choosing kinder semantics here
 * would put this file back in the position it exists to end: a rule the
 * generated spec does not actually implement. The consequence worth knowing is
 * that a value captured from `textContent` carries the page's own whitespace,
 * so `contains` is the forgiving operator and `eq` is not.
 *
 * @typedef {"eq"|"neq"|"contains"|"notContains"|"startsWith"|"notStartsWith"|"endsWith"|"notEndsWith"|"gt"|"lt"|"gte"|"lte"|"matches"} CompareOp
 */

/** Every comparison, in the order the pickers offer them. */
export const COMPARE_OPS = [
  "eq",
  "neq",
  "contains",
  "notContains",
  "startsWith",
  "notStartsWith",
  "endsWith",
  "notEndsWith",
  "gt",
  "lt",
  "gte",
  "lte",
  "matches",
];

/** The four that compare NUMBERS. Both sides go through `Number()`, and a side
 *  that is not a number becomes NaN — which every comparison below reports as
 *  false, and which the emitted matcher reports as a FAILURE naming the value.
 *  Silence there would be the worst outcome: `"abc" > 3` quietly false reads
 *  exactly like a real, meaningful comparison that did not hold. */
export const NUMERIC_COMPARE_OPS = ["gt", "lt", "gte", "lte"];

/** Human phrasing, for step rows and pickers. One spelling, so the trainer's
 *  list and the composer's dropdown cannot describe an operator differently. */
export const COMPARE_OP_LABEL = {
  eq: "equals",
  neq: "does not equal",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  notStartsWith: "does not start with",
  endsWith: "ends with",
  notEndsWith: "does not end with",
  gt: "is greater than",
  lt: "is less than",
  gte: "is at least",
  lte: "is at most",
  matches: "matches regex",
};

/**
 * Apply a comparison. THE one definition — read by the generator's condition
 * expression through the emitted runtime, by the trainer's injected replayer
 * through `compareSource()`, and by the renderer's step list for its wording.
 *
 * SELF-CONTAINED, ES5, no closure references, for the same reason
 * `matchesValue` is: `compareSource()` serializes it with `toString()` into a
 * script injected beside an untrusted page.
 *
 * A `matches` pattern that does not compile is FALSE rather than an exception.
 * The pattern is a value the user typed; a step that throws a SyntaxError deep
 * inside a run reports as a crash rather than as an assertion that did not
 * hold, and the generated matcher — where `new RegExp` is built by Playwright
 * rather than here — surfaces it properly anyway.
 *
 * @param {string} actual
 * @param {CompareOp} op
 * @param {string} expected
 * @returns {boolean}
 */
export function compareValues(actual, op, expected) {
  var a = actual == null ? "" : String(actual);
  var b = expected == null ? "" : String(expected);
  if (op === "gt" || op === "lt" || op === "gte" || op === "lte") {
    var na = Number(a);
    var nb = Number(b);
    // Every comparison against NaN is false, INCLUDING the negated readings —
    // which is why there are no negated numeric operators to get wrong.
    if (op === "gt") return na > nb;
    if (op === "lt") return na < nb;
    if (op === "gte") return na >= nb;
    return na <= nb;
  }
  if (op === "matches") {
    try {
      return new RegExp(b).test(a);
    } catch (err) {
      return false;
    }
  }
  if (op === "eq") return a === b;
  if (op === "neq") return a !== b;
  if (op === "contains") return a.indexOf(b) >= 0;
  if (op === "notContains") return a.indexOf(b) < 0;
  if (op === "startsWith") return a.slice(0, b.length) === b;
  if (op === "notStartsWith") return a.slice(0, b.length) !== b;
  // `"".slice(-0)` is the WHOLE string, not "" — the same trap `matchesValue`
  // documents, and the reason both ends are spelled out rather than inferred.
  if (op === "endsWith") return b === "" ? true : a.slice(a.length - b.length) === b;
  if (op === "notEndsWith") return b === "" ? false : a.slice(a.length - b.length) !== b;
  return false;
}

/** `compareValues` as source text, for embedding in the replayer's injected
 *  script and in the emitted runtime. `toString()` rather than a second copy,
 *  for the reason this whole module exists. */
export function compareSource() {
  return "var compareValues = " + compareValues.toString() + ";";
}

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
 * Escape text for the inside of an EMITTED template literal: backslashes
 * doubled (template cooking halves them again when the spec is parsed as
 * JavaScript), backticks escaped, and `${` escaped so a literal dollar-brace
 * in the user's value cannot open an interpolation.
 *
 * Applied to the STATIC chunks of a variable-bearing pattern, AFTER reEscape:
 * reEscape's own backslashes have to survive the template context they are
 * emitted into, or `example\.com` reaches the RegExp as `example.com` and the
 * dot goes back to matching any character.
 *
 * @param {string} s
 * @returns {string}
 */
export function escapeForTemplate(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** A `${name}` reference to a declared variable. Same grammar as the backend's
 *  VAR_REF_RE — deliberately narrow, so a literal `${9.99}` is left alone. */
const PATTERN_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The regex-pattern SOURCE for a value that may reference variables.
 *
 * Without a declared reference this is byte-identical to what this module
 * always emitted — a JSON string literal of the reEscape'd value — so every
 * spec already on disk regenerates unchanged.
 *
 * WITH one, it emits a template literal whose static chunks are reEscape'd
 * here, at generation time, and whose references become
 * `${glazeReEscape(V.name)}` — escaped at RUN time, because the value is not
 * known now. That run-time escape is the whole reason this could not simply
 * reuse `valueExpr`: a variable holding `a.b` must match the literal text
 * `a.b`, and interpolating it raw would put an unescaped `.` in a pattern,
 * where it matches any character and quietly widens the assertion.
 *
 * `prefix`/`suffix` are pattern text (anchors, or the URL-path frame), already
 * regex-safe and never escaped as data.
 *
 * @param {string} value
 * @param {ReadonlySet<string> | undefined} varNames declared variable names
 * @param {string} [prefix] pattern text before the value
 * @param {string} [suffix] pattern text after it
 * @returns {string} JavaScript source for the RegExp's first argument
 */
export function regexPatternExpr(value, varNames, prefix, suffix) {
  const pre = prefix || "";
  const post = suffix || "";
  const text = String(value == null ? "" : value);
  const refs =
    varNames && varNames.size > 0
      ? [...text.matchAll(PATTERN_VAR_RE)].filter((m) => varNames.has(m[1]))
      : [];
  if (refs.length === 0) return JSON.stringify(pre + reEscape(text) + post);
  let out = "`" + escapeForTemplate(pre);
  let last = 0;
  for (const m of refs) {
    const at = m.index ?? 0;
    out += escapeForTemplate(reEscape(text.slice(last, at)));
    out += "${glazeReEscape(V." + m[1] + ")}";
    last = at + m[0].length;
  }
  return out + escapeForTemplate(reEscape(text.slice(last)) + post) + "`";
}

/**
 * A template literal that interpolates variables RAW, with no escaping.
 *
 * For the one caller whose pattern is built entirely at run time:
 * `urlPathExpr` hands the finished path text to `glazeUrlPathPattern`, which
 * normalises the slashes AND regex-escapes the whole string — so escaping the
 * references here as well would double-escape them.
 *
 * @param {string} value
 * @param {ReadonlySet<string> | undefined} varNames declared variable names
 * @returns {string} JavaScript source: a template literal, or a JSON string
 *                   when nothing is interpolated
 */
export function rawTemplateExpr(value, varNames) {
  const text = String(value == null ? "" : value);
  const refs =
    varNames && varNames.size > 0
      ? [...text.matchAll(PATTERN_VAR_RE)].filter((m) => varNames.has(m[1]))
      : [];
  if (refs.length === 0) return JSON.stringify(text);
  let out = "`";
  let last = 0;
  for (const m of refs) {
    const at = m.index ?? 0;
    out += escapeForTemplate(text.slice(last, at));
    out += "${V." + m[1] + "}";
    last = at + m[0].length;
  }
  return out + escapeForTemplate(text.slice(last)) + "`";
}

/**
 * The inverse of `regexPatternExpr`'s template branch: read an emitted
 * template literal back into pattern text with `${name}` restored.
 *
 * It lives HERE, next to the emitter, rather than in `spec-parser.ts`, for the
 * reason this whole module exists — a second spelling of the template's shape
 * would be right the day it was written and silently wrong afterwards, and the
 * direction it fails is a hand-edited spec whose assertion silently disappears
 * from the step list.
 *
 * Only the template shape: a plain quoted pattern is an ordinary JS string
 * literal, which the parser already knows how to read, and duplicating that
 * here would be the same mistake in the other direction.
 *
 * Returns null for anything this module did not emit — a template with no
 * reference, an interpolation that is not our runtime escape, an unterminated
 * one. Null means "not ours", and the caller falls back to skipping the
 * statement rather than half-reading it into a step that means something else.
 *
 * @param {string} source the RegExp's first argument, verbatim from the spec
 * @returns {string | null} pattern text with `${name}` references restored
 */
export function regexPatternFromTemplate(source) {
  const src = String(source == null ? "" : source);
  if (src.length < 2 || src.charAt(0) !== "`" || src.charAt(src.length - 1) !== "`") return null;
  const inner = src.slice(1, -1);
  let out = "";
  let sawRef = false;
  let i = 0;
  while (i < inner.length) {
    const c = inner.charAt(i);
    // A backslash escapes exactly one character in a template literal, and
    // undoing that is what turns the emitted `\\.` back into the pattern's
    // `\.` — which `reUnescape` then turns back into the user's `.`.
    if (c === "\\") {
      if (i + 1 >= inner.length) return null;
      out += inner.charAt(i + 1);
      i += 2;
      continue;
    }
    if (c === "$" && inner.charAt(i + 1) === "{") {
      const close = inner.indexOf("}", i + 2);
      if (close < 0) return null;
      // Two emitted forms, one inverse. `glazeReEscape(V.x)` is a value
      // escaped at run time before it joins a pattern; a bare `V.x` is one
      // whose pattern is BUILT at run time (urlPathExpr), where the escaping
      // happens to the finished string instead.
      const expr = inner.slice(i + 2, close);
      const m = expr.match(/^(?:glazeReEscape\(V\.([A-Za-z_][A-Za-z0-9_]*)\)|V\.([A-Za-z_][A-Za-z0-9_]*))$/);
      if (!m) return null;
      out += "${" + (m[1] || m[2]) + "}";
      sawRef = true;
      i = close + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  // No reference means this template is not one of ours: the emitter uses a
  // quoted literal whenever there is nothing to interpolate.
  return sawRef ? out : null;
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
export function textMatchExpr(value, semantics, varNames) {
  const pre = semantics.match === "exact" ? "^" : "";
  const post = semantics.match === "exact" || semantics.match === "endsWith" ? "$" : "";
  return (
    "new RegExp(" +
    regexPatternExpr(value, varNames, pre, post) +
    (semantics.caseSensitive ? "" : ", \"i\"") +
    ")"
  );
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

/** The structural frame `urlPathPattern` wraps a path in. Named because THREE
 *  readers must agree on it byte for byte: the pattern builder above, the
 *  var-aware `urlPathExpr`, and the parser, which recognises a "URL path is"
 *  assertion by exactly these ends. `urlPathPattern` keeps them inline because
 *  its whole body is `toString()`d into the injected replayer, where a
 *  module-level const would not be in scope. */
export const URL_PATH_PREFIX = "^[a-z][a-z0-9+.-]*://[^/?#]*";
export const URL_PATH_SUFFIX = "/?(?:[?#]|$)";

/** The slash rules a path value carries before it becomes a pattern: a leading
 *  slash added, trailing ones dropped, and the site root spelled as empty.
 *  Split out of `urlPathPattern` so the var-aware path can apply the SAME
 *  rules to text it must not regex-escape wholesale. */
export function normalizeUrlPath(value) {
  var v = String(value == null ? "" : value);
  if (v !== "" && v.charAt(0) !== "/") v = "/" + v;
  while (v.length > 1 && v.charAt(v.length - 1) === "/") v = v.slice(0, v.length - 1);
  if (v === "/") v = "";
  return v;
}

/** `urlPathPattern` as source text, on the same terms as `matchSource`. */
export function urlPathSource() {
  return "var urlPathPattern = " + urlPathPattern.toString() + ";";
}

/** The `toHaveURL` argument for a "URL path is" assertion, as JavaScript
 *  source — the counterpart of `textMatchExpr` for the one kind whose pattern
 *  is structural rather than a match-mode wrapper around the literal. */
export function urlPathExpr(value, varNames) {
  const text = String(value == null ? "" : value);
  const hasRef =
    varNames && varNames.size > 0
      ? [...text.matchAll(PATTERN_VAR_RE)].some((m) => varNames.has(m[1]))
      : false;
  // Without a reference the pattern is fully known now: unchanged, byte for
  // byte, from before variables could appear here at all.
  if (!hasRef) return "new RegExp(" + JSON.stringify(urlPathPattern(text)) + ", \"i\")";
  // With one, the WHOLE pattern is built at run time by the same function the
  // trainer's replayer calls, on the same finished string.
  //
  // Normalising here instead would be wrong, and subtly: the slash rules read
  // the ENDS of the path, and a reference is opaque text at generation time.
  // A value of `${path}` does not start with "/", so the leading-slash rule
  // added one — and then a variable holding "/" produced a pattern demanding
  // "//" after the host. The run failed while the trainer, which resolves
  // first and normalises after, passed. Deferring the whole thing makes the
  // two agree by construction rather than by a rule kept in step twice.
  return "new RegExp(glazeUrlPathPattern(" + rawTemplateExpr(text, varNames) + "), \"i\")";
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
