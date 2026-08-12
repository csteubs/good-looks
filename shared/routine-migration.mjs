// Turning today's one implicit Batch into a named Routine. ROUTINES.md.
//
// THE MIGRATION IS THE RISKY PART OF CAPABILITY 1, not the store. A store that
// is wrong is empty; a migration that is wrong silently changes what somebody's
// suite does — and the suite is the thing they built this app to trust. So the
// conversion is pure, lives here, and is tested against the shapes the settings
// file actually contains rather than the shape it is supposed to.
//
// WHAT IT PRESERVES, and each of these is a way it could quietly lie:
//
//   • ORDER. `batchOrder` is what the user dragged rows into. A Routine whose
//     steps come out in `Object.keys` order looks identical in a list and runs
//     a different suite.
//   • SELECTION. `batchTestOptions[id].selected` is a real "run this" flag, and
//     an entry can exist with `selected: false` — that is a row the user
//     deliberately turned OFF. Carrying it in as a step would add tests to the
//     nightly job nobody asked for.
//   • ENGINES AND HEADEDNESS, per row rather than globally, because that is how
//     they are stored and a Routine is supposed to be stable against later
//     changes to a test's own defaults (ROUTINES.md open question 1).
//   • FAILURE POLICY. "continue" for every step, because that is Batch's
//     current unwritten behaviour — a failing test never aborts it. Any other
//     default changes what the migrated job does on its first scheduled run.
//
// PURE and in `shared/` for the usual reason: the app performs the migration
// and the MCP will need to read the result, and a second transcription of these
// rules is right the day it is written and silently divergent after.

/** Failure policies, ROUTINES.md. `continue` FIRST and default — see above. */
export const FAILURE_POLICIES = ["continue", "stopRoutine", "skipGroup"];

/** The name the migrated Routine gets. Deliberately the word the user already
 *  knows: they did not create a Routine, they had a Batch, and calling it
 *  something new would make their own suite look like somebody else's. */
export const MIGRATED_NAME = "Batch";

/**
 * Build a Routine's steps from the Batch settings.
 *
 * `order` drives the result and `options` decorates it. An id in `options` but
 * NOT in `order` is included at the end — the two keys drift (an id can be
 * written into options by a row that was never dragged), and dropping such a
 * test would silently shrink the suite, which ROUTINES.md names as the same
 * class of bug as the batch running fewer tests than it said.
 */
export function stepsFromBatchSettings(order, options, knownTestIds) {
  const opts = options && typeof options === "object" ? options : {};
  const known = knownTestIds ? new Set(knownTestIds) : null;

  const ordered = Array.isArray(order) ? order.filter((id) => typeof id === "string") : [];
  const seen = new Set();
  const ids = [];
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  // The drift case: options carry an id the order never mentioned.
  for (const id of Object.keys(opts)) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const steps = [];
  for (const testId of ids) {
    // A test that no longer exists is DROPPED here rather than carried in as a
    // broken step. This is the one moment the Routine is being created, and
    // starting a brand-new saved job with a broken step in it reads as the
    // migration having failed. A test deleted AFTER this point is a different
    // story and does become a broken step — see `routineStore.markTestDeleted`.
    if (known && !known.has(testId)) continue;
    // AN ABSENT ENTRY IS NOT SELECTED, and this is the fact the whole migration
    // turns on. `defaultRow` in `batch-run-plan.ts` returns `selected: false`,
    // so a test with no stored row is a test the user never ticked — it is in
    // the library, not in the batch.
    //
    // The first draft of this had it the other way round, reasoning that an
    // untouched row must be a working default. That would have migrated a
    // Routine containing EVERY TEST IN THE LIBRARY for every user who had ever
    // opened Batch, which is precisely the "silently changes what somebody's
    // suite does" failure this file's header is about. Checked against
    // `defaultRow` rather than assumed.
    const row = opts[testId];
    if (!row || typeof row !== "object" || row.selected !== true) continue;
    const browsers = Array.isArray(row.browsers)
      ? row.browsers.filter((b) => typeof b === "string")
      : [];
    steps.push({
      kind: "test",
      testId,
      // An entry with no engines at all cannot run; it falls back rather than
      // producing a step that silently does nothing.
      browsers: browsers.length > 0 ? browsers : ["chromium"],
      headless: row.headless === true,
      onFailure: "continue",
    });
  }
  return steps;
}

/**
 * The whole migrated Routine, or null when there is nothing to migrate.
 *
 * NULL RATHER THAN AN EMPTY ROUTINE. A user who never ticked a row should not
 * find a saved job named "Batch" with no steps in it — that is an artefact of
 * the upgrade appearing in their library as if they had made it. Given the
 * selection rule above, this is also the ordinary outcome for anyone who has
 * never opened the Batch view at all.
 */
export function routineFromBatchSettings(settings, knownTestIds, now) {
  const steps = stepsFromBatchSettings(
    settings?.batchOrder,
    settings?.batchTestOptions,
    knownTestIds,
  );
  if (steps.length === 0) return null;
  return {
    id: "routine-migrated-batch",
    name: MIGRATED_NAME,
    createdAt: now,
    updatedAt: now,
    steps,
    defaults: {
      // Read from the settings the Batch view actually used, so the migrated
      // job runs the way the batch did rather than the way a fresh Routine
      // would.
      captureArtifacts: settings?.defaultCaptureArtifacts === true,
      concurrency: normalizeConcurrency(settings?.defaultBatchConcurrency),
    },
  };
}

/** Batch's default concurrency, carried across.
 *
 *  NO SECOND CEILING HERE, deliberately. The first draft clamped to 1–8 with a
 *  default of 2, both invented. Batch's own bound is `MAX_BATCH_CONCURRENCY`
 *  (16) and its own default is 1, so that draft would have quietly halved a
 *  user's twelve lanes and doubled the default for everyone else — a migration
 *  changing what the job does, which is the one thing this file exists not to
 *  do. `recorderSettingsStore.read()` already clamps this value at its own
 *  boundary; re-clamping here only creates a number that can disagree with it.
 *  Rejecting a value that is not a usable lane count is all that is left. */
export const MIGRATED_CONCURRENCY = 1;

export function normalizeConcurrency(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return MIGRATED_CONCURRENCY;
  return Math.floor(raw);
}
