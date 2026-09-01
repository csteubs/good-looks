// Cross-test propagation — the app-side glue around shared/propagation.mjs.
//
// EVENT-DRIVEN, no timer: the engine runs when donors can have appeared —
// after a run's heals are journalled, after a trainer heal, after a heal is
// accepted, after a manual locator fix — plus one idempotent catch-up sweep
// shortly after launch (the dedupe rules in proposalsFor are what make the
// sweep safe to run twice). Every trigger is best-effort: nothing here may
// throw into a run's teardown or an edit's save path.
//
// The recording probe is INJECTED (main/index.ts wires it) rather than
// imported: recorder-service calls `noteTrainerHeal` on this module, so an
// import back at it would be a cycle. Until the probe is set, every apply is
// refused — a conservative default that only exists for the first seconds of
// launch and for tests that forget to init.
//
// Feedback loops are impossible by construction, not by flag: the manual-edit
// donors come from the tests:updateSteps / recorder:updateStep HANDLERS, and
// the apply below writes through testStore directly — its own writes never
// pass the hooks that mint donors.

import { logger } from "@shell/backend";

import {
  donorFromEdit,
  donorsFromJournal,
  proposalsFor,
  seedsForTest,
  type Donor,
  type Proposal,
  type RunOutcomeLike,
} from "../../shared/propagation.mjs";
import { healKeyFor } from "../../shared/heal-key.mjs";
import { healJournalStore } from "./heal-journal-store.js";
import { propagationStore, type PropagationEntry } from "./propagation-store.js";
import { runHistoryStore } from "./run-history-store.js";
import { recorderSettingsStore } from "./recorder-settings-store.js";
import { testStore } from "./test-store.js";
import { describeStep } from "./script-generator.js";
import { normalizeLocator, type Locator, type Step } from "../recorder/types.js";

interface PropagationDeps {
  /** whether a live recording session is open for this test — the trainer
   *  regenerates the spec when it finishes, so a write underneath it is
   *  silently discarded minutes later (the refuseIfRecording rule). */
  isRecording: (testId: string) => boolean;
}

let deps: PropagationDeps | null = null;

function settingsOn(): boolean {
  const s = recorderSettingsStore.get();
  return s.propagateFixes === true;
}

function labelFor(testId: string, stepId: string): string {
  try {
    const step = testStore.get(testId)?.steps.find((s) => s.id === stepId);
    return step ? describeStep(step) : "";
  } catch {
    return "";
  }
}

function createFrom(proposal: Proposal): PropagationEntry | null {
  return propagationStore.record({
    testId: proposal.testId,
    stepId: proposal.stepId,
    stepLabel: labelFor(proposal.testId, proposal.stepId),
    origin: proposal.origin,
    ...(proposal.donorPageUrl ? { donorPageUrl: proposal.donorPageUrl } : {}),
    fromLocator: proposal.fromLocator as Locator,
    toLocator: proposal.toLocator as Locator,
    donors: proposal.donors,
    confidence: proposal.confidence,
    reasons: proposal.reasons,
    autoApplyEligible: proposal.autoApplyEligible,
  });
}

/** One sweep: journal donors (plus any just-minted manual ones), the plan,
 *  the store writes, then the auto-apply pass. Never throws. */
function sweep(reason: string, extraDonors: Donor[] = []): void {
  try {
    if (!settingsOn()) return;
    const now = Date.now();
    const runs = runHistoryStore.list();
    const runsById: Record<string, RunOutcomeLike> = {};
    const latestRunByTest: Record<string, RunOutcomeLike> = {};
    for (const run of runs) {
      runsById[run.id] = {
        status: run.status,
        ...(run.passedOnRetry ? { passedOnRetry: true } : {}),
      };
      // The latest EXECUTION per test: baseline updates are not runs, and a
      // user-cancelled run's outcome is a keystroke, not evidence.
      if (run.kind !== "baseline-update" && run.endedBy !== "user") {
        latestRunByTest[run.testId] = runsById[run.id];
      }
    }
    const donors = [
      ...donorsFromJournal({ entries: healJournalStore.listAll(), runsById, now }),
      ...extraDonors,
    ];
    const tests = testStore.list();
    const existing = propagationStore.listAll();
    const plan = proposalsFor({ donors, tests, latestRunByTest, existing });

    for (const id of plan.stale) propagationStore.setStatus(id, "stale");
    for (const s of plan.supersede) {
      propagationStore.setStatus(s.id, "superseded");
      createFrom(s.next);
    }
    for (const r of plan.refresh) {
      propagationStore.refresh(r.id, {
        confidence: r.confidence,
        reasons: r.reasons,
        donors: r.donors,
        autoApplyEligible: r.autoApplyEligible,
      });
    }
    for (const p of plan.create) createFrom(p);
    for (const c of plan.conflicts) {
      logger.info("propagation", "Conflicting donors — proposing nothing", c);
    }
    if (
      plan.create.length + plan.refresh.length + plan.supersede.length + plan.stale.length >
      0
    ) {
      logger.info("propagation", "Sweep applied a plan", {
        reason,
        created: plan.create.length,
        refreshed: plan.refresh.length,
        superseded: plan.supersede.length,
        stale: plan.stale.length,
      });
    }

    // ── Auto-apply, for users who already opted machines into writing ──
    // The engine's eligibility bit is advisory; the mode and the live guards
    // are re-checked here, at apply time, and a refused apply just stays
    // pending — the review queue is the fallback, never an error.
    if (recorderSettingsStore.get().autoHealApply === "apply") {
      for (const entry of propagationStore.pending()) {
        if (!entry.autoApplyEligible) continue;
        try {
          propagationService.applyEntry(entry.id, undefined, { via: "auto" });
        } catch (err) {
          logger.info("propagation", "Auto-apply deferred to review", {
            id: entry.id,
            reason: String(err instanceof Error ? err.message : err),
          });
        }
      }
    }
  } catch (err) {
    logger.warn("propagation", "Sweep failed", { reason, err: String(err) });
  }
}

export const propagationService = {
  init(d: PropagationDeps): void {
    deps = d;
  },

  /** Launch: wire nothing else, just the catch-up sweep, off the critical
   *  path — the stores it reads are the same JSON files the launch already
   *  touches, but the first seconds belong to the window. */
  start(): void {
    const t = setTimeout(() => sweep("launch"), 5000);
    t.unref?.();
  },

  /** A run's heals were just journalled (playwright-runner teardown). */
  noteRunHealsCollected(): void {
    sweep("run-heals");
  },

  /** A trainer heal was just journalled (recorder-service). */
  noteTrainerHeal(): void {
    sweep("trainer-heal");
  },

  /** The user accepted a heal — the strongest donor kind just appeared. */
  noteHealAccepted(): void {
    sweep("heal-accepted");
  },

  /** A step list was saved with hand-changed locators. `before` is the step
   *  list as it was; the diff is per step id, so reorders and inserts mint
   *  nothing. Called from the HANDLERS — never from applyEntry's own write. */
  noteManualEdits(input: { testId: string; before: Step[]; after: Step[] }): void {
    try {
      if (!settingsOn()) return;
      const now = Date.now();
      const beforeById = new Map(input.before.map((s) => [s.id, s]));
      const donors: Donor[] = [];
      for (const step of input.after) {
        const prev = beforeById.get(step.id);
        if (!prev?.locator || !step.locator) continue;
        const donor = donorFromEdit({
          testId: input.testId,
          stepId: step.id,
          before: prev.locator,
          after: step.locator,
          at: now,
        });
        if (donor) donors.push(donor);
      }
      if (donors.length > 0) sweep("manual-edit", donors);
    } catch (err) {
      logger.warn("propagation", "Manual-edit donors failed", { err: String(err) });
    }
  },

  /** The seeds one run's heal map should carry for this test — pending
   *  proposals keyed by the heal key the step still uses. Best-effort: a
   *  failure here is a run with no seeds, never a run that does not start. */
  seedsFor(testId: string): Record<string, object[]> {
    try {
      if (!settingsOn()) return {};
      const test = testStore.get(testId);
      if (!test) return {};
      return seedsForTest({ test, proposals: propagationStore.pending(testId) });
    } catch (err) {
      logger.warn("propagation", "Could not derive seeds", { testId, err: String(err) });
      return {};
    }
  },

  /** THE apply path — the IPC accept and the auto-apply pass share it, so
   *  there is exactly one place the guards can be forgotten. The shape is
   *  heals:accept with more refusals; the spread keeps the fingerprint, which
   *  is the "same intended element, new locator" rule. */
  applyEntry(
    id: string,
    locatorOverride?: unknown,
    opts: { via: "user" | "auto" } = { via: "user" },
  ): PropagationEntry {
    const entry = propagationStore.get(id);
    if (!entry) throw new Error("Proposal not found: " + id);
    if (entry.status !== "pending") throw new Error("This proposal is already settled.");
    const rec = testStore.get(entry.testId);
    if (!rec) {
      propagationStore.setStatus(id, "stale");
      throw new Error("That test no longer exists.");
    }
    if (rec.sourceDir) throw new Error("An imported test is never rewritten by propagation.");
    if (rec.scriptEdited) {
      throw new Error("This test's script is hand-edited — apply the change in the script.");
    }
    if (!deps || deps.isRecording(entry.testId)) {
      throw new Error(
        "A recording session for this test is open. Finish it in the trainer first — the trainer regenerates the script when it stops.",
      );
    }
    const idx = rec.steps.findIndex((s) => s.id === entry.stepId);
    if (idx < 0) {
      propagationStore.setStatus(id, "stale");
      throw new Error("That step no longer exists.");
    }
    const current = rec.steps[idx].locator;
    if (!current || healKeyFor(current) !== healKeyFor(entry.fromLocator)) {
      propagationStore.setStatus(id, "stale");
      throw new Error("That step has changed since this was proposed.");
    }
    const chosen = normalizeLocator(locatorOverride ?? entry.toLocator);
    if (!chosen) throw new Error("The proposed locator is not usable.");
    rec.steps[idx] = { ...rec.steps[idx], locator: chosen };
    rec.updatedAt = Date.now();
    if (!rec.scriptEdited) rec.scriptPath = testStore.regenerateScript(rec);
    testStore.save(rec);
    const settled = propagationStore.setStatus(id, "accepted", { applied: true });
    logger.info("propagation", "Applied a propagated fix", {
      id,
      testId: entry.testId,
      stepId: entry.stepId,
      via: opts.via,
    });
    return settled ?? entry;
  },

  /** Put the step back. Mirrors heals:revert: restores only when something
   *  was applied; under suggest the entry was never a change, so reverting is
   *  just declining it. */
  revertEntry(id: string): PropagationEntry {
    const entry = propagationStore.get(id);
    if (!entry) throw new Error("Proposal not found: " + id);
    if (entry.applied && entry.fromLocator) {
      if (!deps || deps.isRecording(entry.testId)) {
        throw new Error(
          "A recording session for this test is open. Finish it in the trainer first.",
        );
      }
      const rec = testStore.get(entry.testId);
      const idx = rec ? rec.steps.findIndex((s) => s.id === entry.stepId) : -1;
      if (rec && idx >= 0) {
        rec.steps[idx] = { ...rec.steps[idx], locator: entry.fromLocator };
        rec.updatedAt = Date.now();
        if (!rec.scriptEdited) rec.scriptPath = testStore.regenerateScript(rec);
        testStore.save(rec);
      }
    }
    const settled = propagationStore.setStatus(id, "reverted");
    return settled ?? entry;
  },
};
