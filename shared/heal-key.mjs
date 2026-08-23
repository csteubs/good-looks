// How a locator's heal-map key is SPELLED — the one definition.
//
// ── Why this file exists ───────────────────────────────────────────────────
// Run-time Auto-Heal works by tagging every Playwright locator with the app's
// own canonical key as it is created (`__glazeKey`), and looking the failing
// step up by that key. Two pieces of code produce those keys and they run in
// different worlds:
//
//   • `healKeyFor` in main/services/playwright-runner.ts — compiled TypeScript,
//     building a key from the app's `Locator` MODEL when the map is written.
//   • the factory patches in main/services/heal-fixture-source.ts — a raw
//     JavaScript string written next to the specs and loaded by Playwright's
//     own Babel transform, building a key from the ARGUMENTS a locator factory
//     was called with, at run time.
//
// They cannot share a `.ts`, and the comment on `healKeyFor` already states the
// consequence of their drifting: "every lookup misses and healing silently
// stops happening with no error". It is the quietest failure in this codebase —
// nothing throws, no run changes outcome, the feature is simply off.
//
// ── What changed, and why a shared file became necessary ───────────────────
// Until element context, a key came from ONE factory call, so both sides were a
// flat switch and the drift risk was a spelling. Context makes a locator a
// CHAIN — a container, an optional text filter on it, the target, and any
// number of `and` predicates — so a key is now COMPOSED, and the composition
// has an order and a set of separators that both sides must agree on exactly.
// That is a grammar, and a transcribed grammar is right the day it is written
// and silently divergent afterwards.
//
// So the three operators live here, and the fixture gets them as SOURCE TEXT
// via `healKeyOperatorSource()` rather than as a second implementation —
// the same technique, for the same reason, as `matchSource()` in
// step-semantics.mjs.
//
// Pure (see the admission rule in run-pacing.mjs): no fs, no IPC, no process,
// no DOM.

/**
 * The key for a target locator scoped inside a container.
 *
 * `in(<container>)><target>` — the container is parenthesized because its own
 * key contains the `|` separator, and an unbracketed concatenation would make
 * `in(testid|a)>role|button` and `in(testid|a>role)|button` indistinguishable.
 *
 * @param {string} containerKey
 * @param {string} targetKey
 * @returns {string}
 */
export function healKeyWithin(containerKey, targetKey) {
  return "in(" + containerKey + ")>" + targetKey;
}

/**
 * The key for a container narrowed by `.filter({ hasText })`.
 *
 * Applied to the CONTAINER's key before it is wrapped by `healKeyWithin`,
 * because that is the order the generator emits and therefore the order the
 * fixture observes: `page.getByTestId("card").filter({…}).getByRole(…)`.
 *
 * @param {string} containerKey
 * @param {string} text
 * @returns {string}
 */
export function healKeyHasText(containerKey, text) {
  return containerKey + "^hasText=" + String(text == null ? "" : text);
}

/**
 * The key for a text locator — substring (`text|…`) or exact (`text!|…`).
 *
 * Two keys, because they are two locators: `getByText("Save")` and
 * `getByText("Save", { exact: true })` resolve different sets, so a heal
 * recorded for one must not apply to the other. The `!` sits before the
 * separator so the prefix stays a distinct token from `text|` rather than a
 * value that happens to start with a bang.
 *
 * @param {string} value
 * @param {boolean} exact
 * @returns {string}
 */
export function healKeyText(value, exact) {
  return (exact ? "text!|" : "text|") + String(value == null ? "" : value);
}

/**
 * The key for a locator narrowed by `.and(<predicate>)`.
 *
 * Repeatable, and ORDER-SENSITIVE by construction: two `and` predicates applied
 * in the other order produce a different key. That is correct rather than
 * unfortunate — the map only needs keys to be equal when the locators are, and
 * the generator emits predicates in the order they are stored, so the same step
 * always produces the same key.
 *
 * @param {string} baseKey
 * @param {string} predicateKey
 * @returns {string}
 */
export function healKeyAnd(baseKey, predicateKey) {
  return baseKey + "&and(" + predicateKey + ")";
}

/**
 * The three operators as source text, for embedding in the heal fixture.
 *
 * `toString()` rather than a second hand-written copy, because a second copy is
 * the exact failure this module exists to end. Each is bound to an explicit
 * name rather than relying on the function's own: esbuild may rename a
 * function's internals when it bundles, and the fixture calls these by the
 * names bound here.
 *
 * @returns {string}
 */
export function healKeyOperatorSource() {
  return [
    "var healKeyWithin = " + healKeyWithin.toString() + ";",
    "var healKeyHasText = " + healKeyHasText.toString() + ";",
    "var healKeyAnd = " + healKeyAnd.toString() + ";",
    "var healKeyText = " + healKeyText.toString() + ";",
  ].join("\n");
}
