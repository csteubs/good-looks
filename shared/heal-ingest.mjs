// A HEAL FROM ANOTHER MACHINE, made safe to journal here.
//
// ── Why this exists ────────────────────────────────────────────────────────
// `docs/plans/preemptive-updates.md` §1.3 named the gap and recorded the fix
// under Later: the donor corpus is built from heals this machine journalled,
// and a suite that runs forty times a week in a container heals forty times
// where nobody can see it. Worse than invisible — mcp/run-tests.mjs COUNTED
// those heals and dropped them, because journalling on a CI runner writes into
// a library that dies with the container. So the runs that exercise a site
// most often contributed nothing to what the app knows about that site.
//
// The runner now writes them as evidence (`run-heals.json`, one per run,
// beside the failures it already wrote), and `good-looks ingest` promotes them
// into the journal on the machine that owns it. This module is the boundary
// they cross, and it is the same boundary `shared/run-ingest.mjs` guards for
// run records — read that file's header first; the reasoning is identical and
// this one only adds what is different about a heal.
//
// ── What is different about a heal ─────────────────────────────────────────
// A run record is read. A HEAL IS A LOCATOR, and a locator is one accepted
// click away from being generated source that Playwright executes in Node:
//
//     ingested heal → donor (shared/propagation.mjs)
//                   → proposal → accept → step.locator
//                   → generateSpec → executed
//
// That is the capture boundary's path, entered from a JSON file a CI job
// produced. Three consequences, all load-bearing:
//
//   1. Everything is REBUILT from named keys. Nothing is spread, so a field
//      added to the fixture's event later cannot ride along unreviewed.
//   2. The locators are validated STRUCTURALLY here — a plain object, bounded,
//      no functions, no prototype games — and the app's own `normalizeLocator`
//      remains the authority. `heal-journal-store.ts` normalizes on READ as of
//      this change, so a locator that reaches the journal by any route (this
//      one, or a hand-edited file) is narrowed before anything reads it. The
//      capture-boundary rule, applied where it was missing: fixing the writer
//      is not enough on its own.
//   3. The page URL goes through the app's own `normalizeHealPageUrl` — the
//      same module, not a copy — because eliding a token-bearing URL is a
//      privacy rule that must not depend on which machine healed.
//
// ── What the ingesting machine decides, not the container ─────────────────
// Four fields are NOT taken from the incoming event, for the reason
// `run-ingest.mjs` refuses to carry `logFile`: a value is only meaningful on
// the machine that wrote it.
//
//   - `id` is minted locally. A foreign id can collide with a local entry's,
//     and every accept/revert in the app is keyed by it.
//   - `testId` and `runId` come from the ENVELOPE the artifact was found in,
//     which the caller has already matched to a run record it decided to
//     ingest. An event naming its own test could attach a heal to a test it
//     never touched.
//   - `applied` is always false. Nothing on this machine was changed by a heal
//     that happened in a container: `applied: true` would offer the user a
//     revert that would write a locator their test never had. It costs the
//     donor nothing — `donorsFromJournal` accepts a run heal whose RUN passed,
//     and the run record carrying that outcome is ingested alongside.
//
// ── And what is deliberately dropped ──────────────────────────────────────
// `candidates` — the other elements the probe thought resembled the target.
// The app's Heals view offers them as "use this one instead", i.e. as a menu
// of page-authored locators to write into a test. For a local heal that menu
// was produced by a page this user's own trainer or run visited. Carrying a
// foreign one widens the door well past the fix itself for no gain the
// propagation engine can use (it corroborates against the TARGET's own
// fingerprint, never the donor's candidate list). An ingested heal states its
// one claim: this locator was substituted for that one, and the run passed.

import { normalizeHealPageUrl, normalizeHealRect } from "./heal-evidence.mjs";

/** The most a free-text field on an ingested heal may be. Matches
 *  `INGEST_MAX_TEXT`, and generously over a real step label. */
export const HEAL_INGEST_MAX_TEXT = 500;

/** How deep a locator may nest. A locator is a small record — a role, a name,
 *  maybe a `ctx` with a `within` inside it, maybe a `frame` chain. Anything
 *  deeper is not a locator this app produced, and a bound is what stops a
 *  crafted file from making the app's own reader walk forever. */
const MAX_LOCATOR_DEPTH = 6;

/** How many keys a locator object may carry at any level. */
const MAX_LOCATOR_KEYS = 24;

/** True when the string holds a C0 control character or DEL. A scan rather
 *  than a regex literal, so the class cannot be silently mangled by an edit —
 *  see `shared/heal-evidence.mjs`. */
function hasControlChars(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/** A short, control-free string, or null. */
function text(value, max = HEAL_INGEST_MAX_TEXT) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  if (hasControlChars(value)) return null;
  return value;
}

/**
 * A locator, rebuilt value by value.
 *
 * STRUCTURAL, not semantic: this says "a plain JSON record of strings,
 * numbers, booleans, arrays and nested records, within bounds". Whether `k`
 * is a strategy this build knows is the app's `normalizeLocator` to answer,
 * on read, where it answers it for every other route into the journal too.
 *
 * Rebuilt rather than validated-in-place so nothing survives that this
 * function did not copy: no prototype, no getters, no functions.
 */
function plainValue(value, depth) {
  if (depth > MAX_LOCATOR_DEPTH) return undefined;
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return text(value) === null ? undefined : value;
  if (Array.isArray(value)) {
    if (value.length > MAX_LOCATOR_KEYS) return undefined;
    const out = [];
    for (const item of value) {
      const clean = plainValue(item, depth + 1);
      if (clean === undefined) return undefined;
      out.push(clean);
    }
    return out;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.length > MAX_LOCATOR_KEYS) return undefined;
    const out = {};
    for (const key of keys) {
      if (text(key, 64) === null) return undefined;
      // `__proto__` and friends: a key that would change what the rebuilt
      // object IS rather than what it holds.
      if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
      const clean = plainValue(value[key], depth + 1);
      if (clean === undefined) return undefined;
      out[key] = clean;
    }
    return out;
  }
  return undefined;
}

/** A locator object, or null. Must be a record — an array or a bare string is
 *  not a locator, whatever else it might be. */
export function normalizeIngestedLocator(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const clean = plainValue(input, 0);
  return clean === undefined || clean === null ? null : clean;
}

/**
 * One heal event from another machine, as a journal entry this library can
 * store — minus the `id`, which the caller mints.
 *
 * Returns null when the event cannot be trusted to mean anything: no step, no
 * locator on either side, no timestamp. Required fields are refused whole,
 * optional ones refuse only themselves — the `run-ingest.mjs` rule, so one
 * unreadable field does not throw away a real heal.
 *
 * @param {unknown} event one entry of a `run-heals.json` envelope
 * @param {{testId: string, runId: string}} context from the envelope, not the event
 */
export function normalizeIngestedHeal(event, context) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const testId = text(context?.testId, 200);
  const runId = text(context?.runId, 200);
  if (!testId || !runId) return null;

  const stepId = text(event.stepId, 200);
  if (!stepId) return null;

  const originalLocator = normalizeIngestedLocator(event.originalLocator);
  const appliedLocator = normalizeIngestedLocator(event.appliedLocator);
  // Both, not either: the entry's whole claim is "this became that", and the
  // undo the app offers is the original. Half of it is not a heal.
  if (!originalLocator || !appliedLocator) return null;

  const stepIndex =
    typeof event.stepIndex === "number" && Number.isInteger(event.stepIndex) && event.stepIndex >= 0
      ? event.stepIndex
      : null;
  if (stepIndex === null) return null;

  const at = typeof event.at === "number" && Number.isFinite(event.at) ? event.at : null;
  if (at === null) return null;

  const pageUrl = normalizeHealPageUrl(event.url);
  const rect = normalizeHealRect(event.rect);
  const stepLabel = text(event.stepLabel) ?? "";

  return {
    testId,
    stepId,
    stepIndex,
    stepLabel,
    // A heal that happened during a run, which is what this was — the source
    // the app's own runner records, so every reader treats it the same way.
    source: "run",
    runId,
    originalLocator,
    appliedLocator,
    candidates: [],
    applied: false,
    status: "pending",
    at,
    ...(pageUrl ? { pageUrl } : {}),
    ...(rect ? { rect } : {}),
    // Stamped so a reader can tell a heal that happened HERE from one carried
    // back: the Heals view says where it came from, and nothing has to infer
    // it from a runId it cannot resolve.
    ingested: true,
  };
}

/** The key that makes ingest idempotent. Not the foreign id — that is minted
 *  locally — and not the locator, which would collapse a step that heals on
 *  every run into one entry and hide exactly the decay `list_heals` reports.
 *  One heal per step per run is what actually happened. */
export function healIngestKey(entry) {
  return `${entry.runId}::${entry.stepId}`;
}

/**
 * What to journal out of one run's heal evidence.
 *
 * Mirrors `planIngest`: normalized here rather than by the caller, so
 * "unusable" and "already present" are counted apart and can be reported in
 * different sentences. Duplicates are detected within the incoming batch as
 * well as against what is stored — a fixture that flushed twice, or two
 * artifact zips unpacked over each other, is a real thing.
 *
 * @param {Iterable<string>} existingKeys `healIngestKey` of every stored heal
 * @param {unknown[]} incoming raw events from a `run-heals.json` envelope
 * @param {{testId: string, runId: string}} context
 */
export function planHealIngest(existingKeys, incoming, context) {
  const seen = new Set(existingKeys);
  const fresh = [];
  let duplicate = 0;
  let unusable = 0;

  for (const candidate of Array.isArray(incoming) ? incoming : []) {
    const entry = normalizeIngestedHeal(candidate, context);
    if (!entry) {
      unusable++;
      continue;
    }
    const key = healIngestKey(entry);
    if (seen.has(key)) {
      duplicate++;
      continue;
    }
    seen.add(key);
    fresh.push(entry);
  }

  return { fresh, duplicate, unusable };
}
