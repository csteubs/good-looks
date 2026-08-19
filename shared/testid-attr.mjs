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

/** The test-id attributes a Locator's `attr` field may name — the ones that
 *  need spelling out because `getByTestId` cannot resolve them. The default
 *  attribute is deliberately NOT in this list; `normalizeLocator` drops it to
 *  absent. */
export const TESTID_ATTRIBUTE_OVERRIDES = ["data-test-id", "data-test"];

/**
 * The validated override attribute, or null.
 *
 * Every emitter guards with this rather than trusting the field: steps
 * recorded before `normalizeLocator` learned `attr` are regenerated from disk,
 * and the heal probe's candidates reach the fixture from a page-controlled
 * evaluation — so "the type says so" is not a reason here any more than it was
 * for `nth`.
 *
 * @param {unknown} attr
 * @returns {"data-test-id" | "data-test" | null}
 */
export function testIdOverride(attr) {
  return attr === "data-test-id" || attr === "data-test" ? attr : null;
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
 * @returns {{ attr: "data-test-id" | "data-test", value: string } | null}
 */
export function parseTestIdSelector(selector) {
  var m = /^\[(data-test-id|data-test)="((?:[^"\\]|\\[\s\S])*)"\]$/.exec(String(selector));
  if (!m) return null;
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
