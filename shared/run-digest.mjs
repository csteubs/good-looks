// WHAT TWO RUNS' DIGESTS SAY ABOUT EACH OTHER — the reading half of
// `steps-digest.mjs`.
//
// Split out because it has a reader the writing half must never reach: the
// renderer. `renderer/lib/run-summary.ts` compares a failing run's digest
// against the passing run's to decide whether "Recovered" means flake or a
// changed test. Hashing needs `node:crypto`, and Vite's dev server serves a
// Node builtin to a browser as a stub that throws when it is touched — so while
// the comparison lived beside `createHash`, the browser preview and the
// renderer under `npm run dev` died at load. The production bundle survived
// only because tree-shaking happened to drop the hash; that is not a property
// anyone chose. `check:renderer-builtins` pins the split.
//
// Everything a digest's SHAPE depends on lives here (length, scheme tags, the
// stored pattern), so the writer and the reader cannot drift: steps-digest.mjs
// imports its constants from this file.
//
// Pure (see the admission rule in run-pacing.mjs), and stricter than
// steps-digest.mjs: no Node builtins at all.

/** Hex characters kept from the SHA-256. See steps-digest.mjs's header. */
export const DIGEST_HEX_LENGTH = 16;

/** The step-list scheme. Bump the number if `canonicalSteps` (steps-digest.mjs) ever
 *  changes what it feeds the hash — an old digest and a new one must then
 *  compare as UNKNOWN rather than as a difference nobody made. */
export const STEPS_SCHEME = "s1";

/** The spec-source scheme, for tests whose file is the source of truth. */
export const SOURCE_SCHEME = "x1";

/** A digest as stored: `<scheme>:<hex>`. Bounded and anchored — it crosses the
 *  ingest boundary from another machine (shared/run-ingest.mjs). */
const DIGEST_RE = /^[a-z][0-9]{1,2}:[0-9a-f]{16}$/;

/**
 * Whether a stored value is a digest steps-digest.mjs could have written. The gate
 * `shared/run-ingest.mjs` applies to a record arriving from another machine,
 * and the guard every reader applies to a record written by a newer version.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isRunDigest(value) {
  return typeof value === "string" && DIGEST_RE.test(value);
}

/**
 * What two runs' digests say about each other.
 *
 * THE ONE PLACE THE SCHEME RULE LIVES, so that no caller can reach for `a === b`
 * and quietly compare a step digest against a source digest. Three answers,
 * because "we cannot tell" is a real one and is the answer for every run
 * recorded before this field existed:
 *
 *   "same"      — both present, same scheme, same hash
 *   "different" — both present, same scheme, different hash
 *   "unknown"   — either absent or malformed, or the schemes differ
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {"same" | "different" | "unknown"}
 */
export function comparableDigests(a, b) {
  if (!isRunDigest(a) || !isRunDigest(b)) return "unknown";
  if (a.slice(0, a.indexOf(":")) !== b.slice(0, b.indexOf(":"))) return "unknown";
  return a === b ? "same" : "different";
}
