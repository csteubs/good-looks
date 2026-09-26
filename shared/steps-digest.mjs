// WHAT A RUN EXECUTED, as one short comparable token.
//
// ── Why this file exists ───────────────────────────────────────────────────
// A `RunRecord` recorded everything ABOUT a run — engine, pacing, budget,
// capture, dataset row — and nothing about the thing it ran. So the run
// summary panel's "Recovered" state, which answers "it failed, then it passed,
// what was different?", compared six settings and reported flake when they all
// matched. A test rewritten in the trainer between the two runs matched all six,
// and the panel asserted flake over the one variable it could not see.
//
// This is the missing variable. It rides the record so it outlives the edit:
// the failing run's steps are gone the moment somebody saves new ones, and the
// artifact snapshot that would hold them is written only on capture runs and
// pruned by retention.
//
// ── Here rather than beside the runner ─────────────────────────────────────
// TWO PROCESSES WRITE RUN RECORDS — `main/services/playwright-runner.ts` and
// `mcp/run-tests.mjs` (which is also the CLI's and the Action's run path). A
// digest one of them computes differently is worse than no digest at all: the
// panel would report "the test changed" for every unattended run of a test
// nobody had touched. Same argument as `heal-key.mjs` and `run-attempts.mjs`.
//
// ── Two schemes, and why the tag is not decoration ─────────────────────────
// `s1:` digests the STEP LIST. `x1:` digests the SPEC FILE'S BYTES. Which one a
// run uses is decided by what the executed spec was generated from, and the
// caller decides because only the caller knows:
//
//   • a replay run, and an ordinary app-generated test → `s1`, because the spec
//     is generated from those steps immediately before it runs;
//   • a hand-edited spec (`scriptEdited`) or an imported project (`sourceDir`)
//     → `x1`, because the file is the source of truth and its step list may be
//     a stale parse of it. Digesting the steps there would let the panel report
//     "the same steps" about a script somebody rewrote.
//
// App-generated tests digest STEPS rather than the generated source on purpose.
// Generator output is not stable across releases, so an `x1` everywhere would
// report every test in the library as changed the day a version shipped that
// touched emission — a false claim, in the voice of a finding.
//
// The tag is what makes both of those safe to store in ONE field. A comparison
// across schemes is UNKNOWN, never "different": two runs that straddle a test
// becoming script-edited have not been shown to differ, and a future `s2:`
// (should the canonical form below ever change) must not turn every library's
// history into a wall of edits on upgrade day.
//
// ── Sixteen hex characters, not sixty-four ─────────────────────────────────
// The only comparison anyone makes is between two runs OF ONE TEST, so the
// bound is 2^-64 per comparison rather than a birthday bound over a corpus.
// `run-history.json` is capped at 50,000 records and is read whole on every
// write; a full SHA-256 would add ~3.9MB to that file for a field two rows at a
// time are ever read from.
//
// Pure (see the admission rule in run-pacing.mjs): no fs, no IPC, no process,
// no DOM. `node:crypto` only, which `branch-paths.mjs` already imports — and
// that is why the READING half lives in `run-digest.mjs`, not here. This file
// is the WRITERS' (both runners); the renderer compares digests and never
// hashes one, and a renderer import of this file pulls `node:crypto` into a
// browser, where Vite's dev server serves it as a stub that throws on first
// touch. `check:renderer-builtins` pins that no renderer path reaches it.

import { createHash } from "node:crypto";

import { DIGEST_HEX_LENGTH, SOURCE_SCHEME, STEPS_SCHEME } from "./run-digest.mjs";

// The reading half, re-exported so a writer needs one import for the whole
// feature. The renderer must import `./run-digest.mjs` directly.
export {
  DIGEST_HEX_LENGTH,
  SOURCE_SCHEME,
  STEPS_SCHEME,
  comparableDigests,
  isRunDigest,
} from "./run-digest.mjs";

/**
 * Step fields that are dropped before hashing, each because it moves without
 * the test's meaning moving:
 *
 *   • `fingerprint` — what the target element looked like when the step was
 *     recorded. Auto-Heal and propagation rewrite it in place; a healed run is
 *     reported by the `healed` panel, not this one.
 *   • `timestamp` — when the step was recorded. Metadata about the recording
 *     session, not an instruction to the browser.
 *   • `varRefs` — derived on write by `collectVarRefs`, never hand-maintained,
 *     so it can only move when a field it is derived from already has.
 *
 * Everything else counts, `id` and `disabled` included: a step deleted and
 * re-recorded IS an edit, and a disabled step is a step that did not run.
 */
export const IGNORED_STEP_FIELDS = ["fingerprint", "timestamp", "varRefs"];

/**
 * Which scheme a run of this test should digest under.
 *
 * HERE RATHER THAN IN EITHER RUNNER because both of them ask, and the answer
 * going two ways is the failure this whole module exists against: the app would
 * digest one thing, the CLI the other, and every test run by both would compare
 * as UNKNOWN forever — which reads, on screen, as the feature not working.
 *
 * Three conditions send a test to `"source"`, and they are the three ways the
 * step list stops being what runs:
 *
 *   • `scriptEdited` — somebody edited the spec by hand; it is the record now.
 *   • `sourceDir` — an imported project; the spec was never ours.
 *   • `stepsDiverged` — the steps and the script disagree, either because an
 *     edit was saved without regenerating (`"unapplied"`) or because the script
 *     could not be parsed back into steps (`"parse"`). Neither runner
 *     regenerates before running, so in both cases the FILE is what executes.
 *
 * A replay overrides all three: its spec is written from the recorded steps
 * immediately before it runs, so those steps are exactly what executed.
 *
 * @param {unknown} test the TestRecord, as read from the store
 * @param {boolean} [replaying] this run generates its spec from recorded steps
 * @returns {"steps" | "source"}
 */
export function digestSchemeFor(test, replaying) {
  if (replaying) return "steps";
  if (!test || typeof test !== "object") return "source";
  const t = /** @type {Record<string, unknown>} */ (test);
  return t.scriptEdited || t.sourceDir || t.stepsDiverged ? "source" : "steps";
}

/**
 * JSON with object keys in a stable order, all the way down.
 *
 * `JSON.stringify` preserves insertion order, and two stores can hold the same
 * step with its keys written in different orders — a record round-tripped
 * through `normalizeStep` is rebuilt key by key, and a hand edit is not. Two
 * spellings of one step would read as an edit nobody made.
 *
 * `undefined` is dropped rather than encoded, so an absent field and a field
 * explicitly set to undefined are the same step.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = /** @type {Record<string, unknown>} */ (value);
  const parts = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + canonicalJson(obj[key]));
  }
  return "{" + parts.join(",") + "}";
}

/**
 * The canonical text a step list hashes as. Exported for the tests, which is
 * the only way to see WHY two step lists digested the same.
 *
 * @param {unknown} steps
 * @returns {string | null} null when the input is not a step list at all
 */
export function canonicalSteps(steps) {
  if (!Array.isArray(steps)) return null;
  const stripped = steps.map((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return step;
    const out = /** @type {Record<string, unknown>} */ ({});
    for (const key of Object.keys(/** @type {Record<string, unknown>} */ (step))) {
      if (IGNORED_STEP_FIELDS.indexOf(key) >= 0) continue;
      out[key] = /** @type {Record<string, unknown>} */ (step)[key];
    }
    return out;
  });
  return canonicalJson(stripped);
}

/**
 * @param {string} scheme
 * @param {string} text
 * @returns {string}
 */
function tagged(scheme, text) {
  return scheme + ":" + createHash("sha256").update(text, "utf8").digest("hex").slice(0, DIGEST_HEX_LENGTH);
}

/**
 * The digest of a step list, or undefined when there is no list to digest.
 *
 * UNDEFINED IS THE HONEST ANSWER, never a digest of nothing: absent means the
 * run did not record what it executed, and every reader treats that as unknown
 * rather than as "unchanged" (the same rule `speed` and `healFailedSteps`
 * already stand on).
 *
 * @param {unknown} steps
 * @returns {string | undefined}
 */
export function digestSteps(steps) {
  const text = canonicalSteps(steps);
  return text === null ? undefined : tagged(STEPS_SCHEME, text);
}

/**
 * The digest of a spec file's source, for a test whose file is the source of
 * truth. The caller reads the file; this module stays pure.
 *
 * @param {unknown} source
 * @returns {string | undefined}
 */
export function digestSource(source) {
  return typeof source === "string" ? tagged(SOURCE_SCHEME, source) : undefined;
}

