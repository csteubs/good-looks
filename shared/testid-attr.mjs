// How a testid locator's ATTRIBUTE is spelled — the one definition.
//
// ── Why this file exists ───────────────────────────────────────────────────
// The recorder accepts three test-id attributes (data-testid, data-test-id,
// data-test) as one "testid" locator kind, but Playwright's `getByTestId`
// resolves only the configured attribute — data-testid, since nothing in this
// repo sets `testIdAttribute`. So a locator recorded off either other
// attribute must spell that attribute out, as `locator('[data-test-id="v"]')`,
// and the SAME selector string is then load-bearing in four worlds:
//
//   • `locatorBase` in main/services/script-generator.ts writes it into the
//     spec a run executes;
//   • `healKeyBase` in main/services/playwright-runner.ts keys the heal map
//     with `css|<selector>`, which must equal the key the run-time fixture
//     derives from the `locator()` factory's ARGUMENT — i.e. from this very
//     string as the generator wrote it;
//   • `baseFromModel` in the heal fixture (a raw JS string Playwright loads)
//     rebuilds a live locator from the model when it applies a heal, via
//     `testIdSelectorSource()` below;
//   • the renderer's step list, refine dialog and LLM prompts render the call
//     the generated script will contain, and their copy being different is a
//     user reading one locator while the run executes another.
//
// Two spellings of this selector mean a heal-map lookup that silently misses,
// or a parser that drops the step a hand edit touches. Same argument, same
// technique as `shared/heal-key.mjs`.
//
// Pure (see the admission rule in run-pacing.mjs): no fs, no IPC, no process,
// no DOM.

/** The attribute `getByTestId` resolves with this repo's (absent) Playwright
 *  config. A locator that matched THIS attribute carries no `attr` field —
 *  absent and default must be the same value, or one locator would have two
 *  spellings and two heal-map keys. */
export const DEFAULT_TESTID_ATTRIBUTE = "data-testid";

/** The test-id attributes the recorder ALWAYS probes beyond the default —
 *  the ones that need spelling out because `getByTestId` cannot resolve
 *  them. The default attribute is deliberately NOT in this list;
 *  `normalizeLocator` drops it to absent. User-configured extras (Settings →
 *  Recording) extend this set at capture time; `testIdOverride` below admits
 *  any grammar-valid data-* attribute so a step recorded off an extra stays
 *  valid even after the setting changes. */
export const TESTID_ATTRIBUTE_OVERRIDES = ["data-test-id", "data-test"];

/**
 * Whether a string may serve as a test-id attribute at all: lowercase
 * `data-*`, the conservative HTML data-attribute grammar, bounded — and
 * never the default (absent and default must stay the same spelling). The
 * name lands inside an attribute SELECTOR in executed source, so this is a
 * boundary rule, not a style preference.
 *
 * @param {unknown} v
 * @returns {v is string}
 */
export function isTestIdAttributeName(v) {
  return (
    typeof v === "string" &&
    v.length <= 50 &&
    v !== DEFAULT_TESTID_ATTRIBUTE &&
    /^data-[a-z][a-z0-9-]*$/.test(v)
  );
}

/**
 * Canonicalize the user-configured EXTRA attributes (Settings → Recording):
 * grammar-checked, deduped, the default and the always-on pair filtered out,
 * capped. Both the settings store and the capture-script injection go
 * through this — the list is interpolated into an injected script, so
 * nothing unvalidated may ride it.
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeTestIdAttributes(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (!isTestIdAttributeName(raw)) continue;
    if (TESTID_ATTRIBUTE_OVERRIDES.indexOf(raw) >= 0) continue;
    if (out.indexOf(raw) >= 0) continue;
    out.push(raw);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * The validated override attribute, or null.
 *
 * Every emitter guards with this rather than trusting the field: steps
 * recorded before `normalizeLocator` learned `attr` are regenerated from disk,
 * and the heal probe's candidates reach the fixture from a page-controlled
 * evaluation — so "the type says so" is not a reason here any more than it was
 * for `nth`.
 *
 * Self-contained (embedded by `testIdSelectorSource`), so the grammar is a
 * literal here rather than a call to `isTestIdAttributeName` — the two must
 * agree, and testid-attributes.dom.test.ts pins that they do.
 *
 * @param {unknown} attr
 * @returns {string | null}
 */
export function testIdOverride(attr) {
  return typeof attr === "string" &&
    attr !== "data-testid" &&
    attr.length <= 50 &&
    /^data-[a-z][a-z0-9-]*$/.test(attr)
    ? attr
    : null;
}

/**
 * The attribute selector a non-default testid locator emits and resolves by:
 * `[data-test-id="v"]`, with the value escaped for the inside of a
 * double-quoted CSS string (quote and backslash escaped, control characters as
 * hex escapes — a raw newline is a parse error in a CSS string).
 *
 * Self-contained on purpose: `testIdSelectorSource()` embeds it by
 * `toString()`, so it must not close over anything.
 *
 * @param {string} attr
 * @param {string} value
 * @returns {string}
 */
export function testIdSelector(attr, value) {
  var v = String(value == null ? "" : value)
    .replace(/[\\"]/g, "\\$&")
    // eslint-disable-next-line no-control-regex -- the control characters ARE the check
    .replace(/[\u0000-\u001f\u007f]/g, function (c) {
      return "\\" + c.charCodeAt(0).toString(16) + " ";
    });
  return "[" + attr + '="' + v + '"]';
}

/**
 * The inverse: read `{attr, value}` back off a selector `testIdSelector`
 * emitted, or null for anything else.
 *
 * Deliberately narrow — exactly one attribute equality, double-quoted, one of
 * the override attributes. A hand-written `[data-testid="v"]` stays a css
 * locator: it resolves identically everywhere (the oracle scans the selector,
 * the heal key is `css|` + itself), so reading it back as a testid would be a
 * relabel with no behaviour behind it. The unescape handles the general CSS
 * string grammar (`\<hex> ` and `\<char>`) rather than only this module's own
 * output, so a hand edit that over-escapes still parses back to the value it
 * means; the next regeneration normalizes the spelling.
 *
 * @param {string} selector
 * @returns {{ attr: string, value: string } | null}
 */
export function parseTestIdSelector(selector) {
  var m = /^\[(data-[a-z][a-z0-9-]*)="((?:[^"\\]|\\[\s\S])*)"\]$/.exec(String(selector));
  if (!m) return null;
  // The default stays a css locator (see the doc above), and the grammar's
  // length bound applies on the way back in too.
  if (m[1] === "data-testid" || m[1].length > 50) return null;
  var value = m[2].replace(/\\([0-9a-fA-F]{1,6}) ?|\\([\s\S])/g, function (_all, hex, ch) {
    return hex ? String.fromCodePoint(parseInt(hex, 16)) : ch;
  });
  return { attr: m[1], value: value };
}

/**
 * `testIdOverride` and `testIdSelector` as source text, for embedding in the
 * heal fixture — `toString()` rather than a transcribed copy, for the same
 * reason as `healKeyOperatorSource()`. Bound to explicit names because esbuild
 * may rename internals when it bundles.
 *
 * @returns {string}
 */
export function testIdSelectorSource() {
  return [
    "var testIdOverride = " + testIdOverride.toString() + ";",
    "var testIdSelector = " + testIdSelector.toString() + ";",
  ].join("\n");
}
