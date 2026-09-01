// Cross-test heal propagation — the PURE core (PR 2 of
// docs/plans/preemptive-updates.md).
//
// One question, answered deterministically: a locator fix was confirmed on one
// test — which steps in which OTHER tests on the same site should get the same
// fix, with how much confidence, and which runs should be protected in the
// meantime? Everything here is plain data in, plain data out: the stores, the
// disk, describeStep and the IPC all stay on the app's side (PR 3), and the
// MCP/CLI runner reaches `seedsForTest` from plain .mjs — which is why this
// file cannot be compiled TypeScript.
//
// The identity that joins tests is `healKeyFor` — the heal engine's own
// spelling of a locator, context-aware and deliberately nth-insensitive, so an
// indexed step matches the unindexed sibling a heal was recorded against.
// Grouping is by ORIGIN (shared/origin.mjs), preferring the heal's recorded
// page URL over the test's start URL, which mid-test navigation makes a lie.
//
// Three rules with teeth, each tested in both directions:
//   • A REVERTED heal is anti-evidence, not a donor — the user put it back.
//   • Donors that DISAGREE on the fix for one element produce no proposal at
//     all: a conflicted fix is not a fix.
//   • A settled decision is respected: once a proposal for the same
//     step + from + to has been dismissed (or applied and reverted), the same
//     fix is not proposed again.
//
// Pure only: no fs, no IPC, no process, no Date.now() — `now` is an input.

import { healKeyFor } from "./heal-key.mjs";
import { originOf } from "./origin.mjs";
import { flakeSignal } from "./run-attempts.mjs";

/** Donors older than this create no new proposals. A fix confirmed a month
 *  ago describes a page that has had a month to change again. */
export const PROPAGATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Confidence floor for writing a pending proposal at all. */
export const PROPOSE_MIN = 0.6;

/** Confidence floor for auto-apply (which additionally requires the strong
 *  fingerprint corroboration or at least two agreeing donors, and refuses
 *  the PROPOSE_ONLY step types — see `proposalsFor`). */
export const AUTO_APPLY_MIN = 0.85;

/** Seed locators offered per heal-map key. The heal fixture tries at most
 *  three probe candidates for the same reason: a list longer than what will
 *  be tried is a list that only slows the failure down. */
export const MAX_SEEDS_PER_KEY = 3;

/** Step types whose proposals are NEVER auto-applied, whatever the
 *  confidence. The common property: these steps CONSUME the element silently
 *  — success does not prove the element was right, and nothing downstream
 *  fails loudly if it wasn't. An assert against the wrong element checks
 *  something nobody asked about (the heal fixture refuses to heal assertions
 *  for exactly this reason); an `if` silently reroutes the test; a `capture`
 *  reads the wrong value into a variable. An action, by contrast, tends to
 *  fail visibly when it lands on the wrong element — and its heal-review
 *  machinery already exists for when it doesn't. */
export const PROPOSE_ONLY_TYPES = Object.freeze(["assert", "if", "capture"]);

/** Every status a proposal can hold, in lifecycle order. HERE rather than in
 *  the store because two processes now read it: the app normalizes an entry
 *  against this list (an unknown status DROPS the entry), and the MCP's
 *  `list_propagations` filters by it. Two spellings would mean a status the
 *  app writes and the MCP silently reports nothing for. */
export const PROPAGATION_STATUSES = Object.freeze([
  "pending",
  "accepted",
  "dismissed",
  "reverted",
  "superseded",
  "stale",
]);

/** Every reason code a proposal may carry. Codes, not copy: the renderer maps
 *  each to a fixed sentence (the insights-view rule — the engine contributes
 *  facts, never labels), and a code outside this list is a bug. */
export const REASON_CODES = Object.freeze([
  "donor-accepted",
  "donor-manual",
  "donor-run-passed",
  "donor-trainer",
  "donors-agree",
  "fingerprint-key-match",
  "fingerprint-similar",
  "target-failing",
]);

/** Base confidence per donor kind. A human decision (accepting a heal, fixing
 *  a locator by hand) outranks a machine inference; a run-validated heal
 *  outranks a trainer one only because the whole run stayed green around it. */
const KIND_BASE = {
  "heal-accepted": 0.75,
  "manual-edit": 0.75,
  "heal-run-passed": 0.6,
  "heal-trainer": 0.55,
};

const KIND_REASON = {
  "heal-accepted": "donor-accepted",
  "manual-edit": "donor-manual",
  "heal-run-passed": "donor-run-passed",
  "heal-trainer": "donor-trainer",
};

function keyOf(locator) {
  if (!locator || typeof locator !== "object") return null;
  try {
    return healKeyFor(locator);
  } catch {
    return null;
  }
}

/**
 * Turn heal-journal entries into donors.
 *
 * The evidence gates, entry by entry:
 *   • `reverted` is ANTI-evidence — the user looked and put it back. Not a
 *     donor, whatever else is true.
 *   • `accepted` is the strongest gate: an explicit human decision.
 *   • a pending run heal counts only when something independent of the heal's
 *     own success vouches for it — `applied` (the apply-mode writeback, which
 *     is itself gated on the run passing) or the run's recorded outcome being
 *     "passed". A mis-heal usually SUCCEEDS at the step, so step success is
 *     exactly the signal that proves nothing; the run's outcome is the usable
 *     one. This is the same rule `collectRunHeals` applies before writing to
 *     disk, read from the other side.
 *   • a trainer heal happened live under the user's eyes — middling.
 *   • no `originalLocator` means no from-identity to match; skipped.
 *   • unchanged key (heal to a different SPELLING of the same identity, e.g.
 *     an nth change) proposes nothing; skipped.
 *   • older than `PROPAGATION_WINDOW_MS`; skipped.
 *
 * @param {{ entries: Array<object>, runsById?: Record<string, { status?: string }>, now: number }} input
 * @returns {Array<object>} donors
 */
export function donorsFromJournal({ entries, runsById = {}, now }) {
  const donors = [];
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.status === "reverted") continue;
    if (typeof entry.at !== "number" || entry.at < now - PROPAGATION_WINDOW_MS) continue;
    const fromKey = keyOf(entry.originalLocator);
    const toKey = keyOf(entry.appliedLocator);
    if (!fromKey || !toKey || fromKey === toKey) continue;

    let kind = null;
    if (entry.status === "accepted") {
      kind = "heal-accepted";
    } else if (entry.source === "run") {
      const run = entry.runId ? runsById[entry.runId] : undefined;
      if (entry.applied === true || (run && run.status === "passed")) kind = "heal-run-passed";
    } else if (entry.source === "trainer") {
      kind = "heal-trainer";
    }
    if (!kind) continue;

    donors.push({
      kind,
      testId: entry.testId,
      stepId: entry.stepId,
      healEntryId: entry.id,
      runId: entry.runId,
      fromKey,
      fromLocator: entry.originalLocator,
      toKey,
      toLocator: entry.appliedLocator,
      pageUrl: typeof entry.pageUrl === "string" ? entry.pageUrl : undefined,
      at: entry.at,
    });
  }
  return donors;
}

/**
 * A manual locator fix as a donor — the user changed a step's locator by
 * hand, which is the strongest evidence there is. The caller (the app's
 * update handlers, never the propagation apply path — that exclusion is what
 * prevents feedback loops) detects the edit; this only shapes and gates it.
 *
 * @param {{ testId: string, stepId: string, before?: object, after?: object, at: number }} input
 * @returns {object | null}
 */
export function donorFromEdit({ testId, stepId, before, after, at }) {
  const fromKey = keyOf(before);
  const toKey = keyOf(after);
  if (!fromKey || !toKey || fromKey === toKey) return null;
  if (typeof at !== "number") return null;
  return {
    kind: "manual-edit",
    testId,
    stepId,
    fromKey,
    fromLocator: before,
    toKey,
    toLocator: after,
    at,
  };
}

/** Whether two element fingerprints plausibly describe the same element.
 *  Deliberately a handful of blunt, explainable checks rather than a tuned
 *  model: equal non-empty own text, equal non-empty neighbour text, two or
 *  more equal identifying attributes, or centres within a tenth of the
 *  viewport on both axes. Exported so every arm is testable both ways. */
export function fingerprintsSimilar(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  if (text(a.text) && text(a.text) === text(b.text)) return true;
  if (text(a.neighborText) && text(a.neighborText) === text(b.neighborText)) return true;
  const attrsA = a.attributes ?? {};
  const attrsB = b.attributes ?? {};
  const IDENTIFYING = ["id", "name", "role", "aria-label", "placeholder", "type", "href"];
  let equal = 0;
  for (const key of IDENTIFYING) {
    const va = text(attrsA[key]);
    if (va && va === text(attrsB[key])) equal += 1;
  }
  if (equal >= 2) return true;
  const ra = a.rect;
  const rb = b.rect;
  if (ra && rb) {
    const dx = Math.abs(ra.x + ra.w / 2 - (rb.x + rb.w / 2));
    const dy = Math.abs(ra.y + ra.h / 2 - (rb.y + rb.h / 2));
    if (dx <= 0.1 && dy <= 0.1) return true;
  }
  return false;
}

function testOrigin(test) {
  if (!test) return null;
  return originOf(test.url ?? "") ?? originOf(test.baseUrl ?? "");
}

function eligibleTest(test) {
  return !!test && !test.sourceDir && !test.scriptEdited && !test.stepsDiverged;
}

function eligibleStep(step) {
  if (!step || step.disabled || !step.locator) return false;
  const frame = step.locator.frame;
  if (Array.isArray(frame) && frame.length > 0) return false;
  return true;
}

/** Confidence for one donor group against one target step. Returns
 *  { confidence, reasons } — reasons are codes from REASON_CODES, and the
 *  score is a sum of named contributions capped at 1, so every point of
 *  confidence has a sentence behind it. */
function scoreTarget({ donors, donorFingerprint, targetStep, latestRun }) {
  const reasons = [];
  let confidence = 0;

  let base = 0;
  let baseReason = null;
  for (const donor of donors) {
    const kindBase = KIND_BASE[donor.kind] ?? 0;
    if (kindBase > base) {
      base = kindBase;
      baseReason = KIND_REASON[donor.kind];
    }
  }
  if (baseReason) reasons.push(baseReason);
  confidence += base;

  if (donors.length >= 2) {
    reasons.push("donors-agree");
    confidence += Math.min(0.2, 0.1 * (donors.length - 1));
  }

  const fp = targetStep.fingerprint;
  const candidateKeys = Array.isArray(fp?.candidates) ? fp.candidates.map(keyOf) : [];
  if (candidateKeys.includes(donors[0].toKey)) {
    // The target's own recorder saw this exact identity on this element at
    // record time — the strongest corroboration available.
    reasons.push("fingerprint-key-match");
    confidence += 0.2;
  } else if (fingerprintsSimilar(donorFingerprint, fp)) {
    reasons.push("fingerprint-similar");
    confidence += 0.1;
  }

  if (latestRun && flakeSignal(latestRun) === "failed") {
    // Urgency more than correctness: the test is already going red, so the
    // proposal is the likely fix rather than a precaution.
    reasons.push("target-failing");
    confidence += 0.05;
  }

  return { confidence: Math.min(1, confidence), reasons };
}

function tripleKey(testId, stepId, fromKey) {
  return JSON.stringify([testId, stepId, fromKey]);
}

/**
 * The whole computation: donors in, a plan of store writes out.
 *
 * @param {{
 *   donors: Array<object>,
 *   tests: Array<object>,
 *   latestRunByTest?: Record<string, { status?: string, passedOnRetry?: boolean }>,
 *   existing?: Array<object>,
 * }} input
 * @returns {{
 *   create: Array<object>,
 *   refresh: Array<object>,
 *   supersede: Array<object>,
 *   stale: string[],
 *   conflicts: Array<object>,
 * }}
 */
export function proposalsFor({ donors, tests, latestRunByTest = {}, existing = [] }) {
  const testsById = new Map((tests ?? []).map((t) => [t.id, t]));

  // ── Group agreeing donors by (origin, fromKey); refuse conflicted groups ──
  const groups = new Map();
  const conflicts = [];
  for (const donor of donors ?? []) {
    const origin = originOf(donor.pageUrl ?? "") ?? testOrigin(testsById.get(donor.testId));
    if (!origin) continue;
    const groupKey = JSON.stringify([origin, donor.fromKey]);
    const group = groups.get(groupKey) ?? { origin, fromKey: donor.fromKey, donors: [] };
    group.donors.push(donor);
    groups.set(groupKey, group);
  }
  for (const [groupKey, group] of [...groups.entries()]) {
    const toKeys = [...new Set(group.donors.map((d) => d.toKey))];
    if (toKeys.length > 1) {
      conflicts.push({ origin: group.origin, fromKey: group.fromKey, toKeys });
      groups.delete(groupKey);
    }
  }

  // ── Index what already exists ──
  // One live pending entry per (testId, stepId, fromKey). A settled decision
  // about the same triple + toKey blocks recreation: dismissed means "asked
  // and answered", reverted means "tried and taken back", and accepted means
  // the fix already landed — if the step later carries the old locator again,
  // that was a person's edit, not a question to re-ask. `superseded` and
  // `stale` do not block: both were the engine's own housekeeping.
  const pendingByTriple = new Map();
  const settledBlocked = new Set();
  for (const entry of existing) {
    const fromKey = keyOf(entry.fromLocator);
    if (!fromKey) continue;
    const triple = tripleKey(entry.testId, entry.stepId, fromKey);
    if (entry.status === "pending") {
      pendingByTriple.set(triple, entry);
    } else if (entry.status === "dismissed" || entry.status === "reverted" || entry.status === "accepted") {
      const toKey = keyOf(entry.toLocator);
      if (toKey) settledBlocked.add(triple + "::" + toKey);
    }
  }

  const create = [];
  const refresh = [];
  const supersede = [];
  const matchedPendingIds = new Set();

  for (const group of groups.values()) {
    const newest = [...group.donors].sort((a, b) => b.at - a.at)[0];
    const donorTest = testsById.get(newest.testId);
    const donorStep = donorTest?.steps?.find((s) => s.id === newest.stepId);
    const donorFingerprint = donorStep?.fingerprint;
    const donorStepIds = new Set(group.donors.map((d) => d.testId + "::" + d.stepId));

    for (const test of testsById.values()) {
      if (!eligibleTest(test)) continue;
      if (testOrigin(test) !== group.origin) continue;
      for (const step of test.steps ?? []) {
        if (!eligibleStep(step)) continue;
        // The donor's own step is already fixed; siblings in the same test
        // with the same key are stale too and stay in.
        if (donorStepIds.has(test.id + "::" + step.id)) continue;
        if (keyOf(step.locator) !== group.fromKey) continue;

        const { confidence, reasons } = scoreTarget({
          donors: group.donors,
          donorFingerprint,
          targetStep: step,
          latestRun: latestRunByTest[test.id],
        });
        if (confidence < PROPOSE_MIN) continue;

        const proposal = {
          testId: test.id,
          stepId: step.id,
          origin: group.origin,
          donorPageUrl: newest.pageUrl,
          // The undo and the staleness check are the TARGET's own locator —
          // same key as the donor's, possibly a different spelling (an nth,
          // a context) that must be restorable exactly.
          fromLocator: step.locator,
          toLocator: newest.toLocator,
          donors: group.donors.map((d) => ({
            kind: d.kind,
            testId: d.testId,
            stepId: d.stepId,
            healEntryId: d.healEntryId,
            runId: d.runId,
            at: d.at,
          })),
          confidence,
          reasons,
          autoApplyEligible:
            confidence >= AUTO_APPLY_MIN &&
            (reasons.includes("fingerprint-key-match") || group.donors.length >= 2) &&
            !PROPOSE_ONLY_TYPES.includes(step.type),
        };

        const triple = tripleKey(test.id, step.id, group.fromKey);
        if (settledBlocked.has(triple + "::" + newest.toKey)) continue;

        const pending = pendingByTriple.get(triple);
        if (!pending) {
          create.push(proposal);
          continue;
        }
        matchedPendingIds.add(pending.id);
        if (keyOf(pending.toLocator) === newest.toKey) {
          // Same fix, possibly better evidence: update in place, but only
          // when something actually moved — an idempotent sweep must not
          // churn the store.
          const changed =
            Math.abs((pending.confidence ?? 0) - confidence) > 0.001 ||
            (pending.donors?.length ?? 0) !== proposal.donors.length ||
            JSON.stringify(pending.reasons ?? []) !== JSON.stringify(reasons);
          if (changed) {
            refresh.push({
              id: pending.id,
              confidence,
              reasons,
              donors: proposal.donors,
              autoApplyEligible: proposal.autoApplyEligible,
            });
          }
        } else {
          // A different fix for the same element: the old proposal is not
          // edited (an edited proposal is one the user never saw) — it is
          // superseded and the new one stands on its own.
          supersede.push({ id: pending.id, next: proposal });
        }
      }
    }
  }

  // ── Staleness: pending entries whose target moved under them ──
  // An APPLIED pending entry is the exception: its step carries `toLocator`
  // BY DESIGN — the apply-mode writeback awaiting review — so it holds while
  // the step still does, and goes stale only when the step matches neither
  // its undo nor its fix.
  const stale = [];
  for (const [, pending] of pendingByTriple) {
    const test = testsById.get(pending.testId);
    const step = test?.steps?.find((s) => s.id === pending.stepId);
    const fromKey = keyOf(pending.fromLocator);
    const stepKey = step?.locator ? keyOf(step.locator) : null;
    const holds =
      stepKey !== null &&
      (stepKey === fromKey ||
        (pending.applied === true && stepKey === keyOf(pending.toLocator)));
    if (!test || !step || !holds) stale.push(pending.id);
  }

  return { create, refresh, supersede, stale, conflicts };
}

/**
 * The seeds one run's heal map should carry: for each of this test's heal
 * keys with a pending proposal, the proposed locators, best-first, capped.
 * The fixture tries a seed only after the old locator has ACTUALLY failed on
 * the live page, and a working seed records an ordinary heal event — so a
 * seed never touches the stored test and never hides that the page changed.
 *
 * @param {{ test: object, proposals: Array<object> }} input
 * @returns {Record<string, Array<object>>} heal-map key → seed locators
 */
export function seedsForTest({ test, proposals }) {
  const seeds = {};
  if (!test || !Array.isArray(proposals)) return seeds;
  const stepsById = new Map((test.steps ?? []).map((s) => [s.id, s]));
  const byKey = new Map();
  for (const entry of proposals) {
    if (entry.testId !== test.id || entry.status !== "pending") continue;
    const step = stepsById.get(entry.stepId);
    if (!eligibleStep(step)) continue;
    const fromKey = keyOf(entry.fromLocator);
    const toKey = keyOf(entry.toLocator);
    if (!fromKey || !toKey) continue;
    // The step moved under the proposal — a seed keyed on a locator the step
    // no longer uses would never fire, and one keyed on its new locator
    // would fire for the wrong reason.
    if (keyOf(step.locator) !== fromKey) continue;
    const bucket = byKey.get(fromKey) ?? new Map();
    const kept = bucket.get(toKey);
    if (!kept || (entry.confidence ?? 0) > (kept.confidence ?? 0)) {
      bucket.set(toKey, entry);
    }
    byKey.set(fromKey, bucket);
  }
  for (const [fromKey, bucket] of byKey) {
    const ranked = [...bucket.values()]
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, MAX_SEEDS_PER_KEY)
      .map((entry) => entry.toLocator);
    if (ranked.length > 0) seeds[fromKey] = ranked;
  }
  return seeds;
}
