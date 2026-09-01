// WHAT A RUN'S HEAL MAP AND HEAL EVIDENCE ARE CALLED — the one spelling.
//
// ── The failure that put this here (R49) ──────────────────────────────────
// Auto-Heal is two halves that never meet in the same process. The runner
// WRITES a map — canonical locator key → the step it belongs to, plus a probe
// script — and the heal fixture, running inside a Playwright worker, READS it
// back through `GLAZE_HEAL_MAP` and heals nothing at all for a key it cannot
// find. The two are joined by a filename and by nothing else.
//
// So when a second runner appeared, it named the file itself. The app writes
// `<runId>.heal-map.json`; the MCP/CLI path pointed `GLAZE_HEAL_MAP` at
// `<testId>.heal.json`, which no code in this repository has ever written.
// Nothing failed. `GLAZE_HEAL=1` was set, the fixture installed itself, patched
// every locator factory, and then took the `!entry` arm on every single action
// — so every unattended run reported healing as ON while healing nothing, and
// recorded no evidence of having tried. The gate could not see it because
// nothing tied the SWITCH to the MAP.
//
// A filename is exactly the shape `shared/` exists for: one definition, both
// processes, and no way to write a second one that is right the day it is
// written and silent afterwards. `check:ci-fixtures` asserts that these are the
// only heal-artifact names in the repository.
//
// ── Why keyed by RUN and not by test ──────────────────────────────────────
// Two runs of one test can be in flight at once (`run_batch` runs several, and
// the app can re-run while a batch is going). A per-test name means the second
// run overwrites the first's map mid-flight, and the first then heals against
// the wrong steps — the same collision `test-results/<runId>` already exists to
// avoid one directory over.

/** The heal map for one run: what the fixture reads through `GLAZE_HEAL_MAP`. */
export function healMapFileName(runId) {
  return `${runId}.heal-map.json`;
}

/** The directory the fixture writes its evidence into (`heals.json`,
 *  `matches.json`), pointed at by `GLAZE_HEAL_DIR`. Named off the same run so
 *  the map and what it produced sort together on disk. */
export function healDirName(runId) {
  return `${runId}.heal`;
}

// ── The fixture's scratch files, and what a run makes of them ─────────────
//
// The heal fixture writes two files into `GLAZE_HEAL_DIR` as it goes, and the
// runner that started the run turns them into the two artifacts every reader
// asks for. Three processes and one set of names again: the fixture (a string
// Playwright loads) writes them, and BOTH runners read them.

/** What the fixture writes each heal and failed attempt into. */
export const HEAL_EVENTS_FILE = "heals.json";

/** What the fixture writes each failing locator's real match set into. */
export const HEAL_MATCHES_FILE = "matches.json";

/** A heal that happened: a candidate was applied and the step got past.
 *
 *  `?? "healed"` because the outcome field postdates the first heals written;
 *  an entry from before it carries an applied locator and nothing else. */
export function isHeal(event) {
  return (event?.outcome ?? "healed") === "healed" && !!event?.appliedLocator;
}

/** A failed attempt. Keyed on the outcomes that EXIST rather than on "not a
 *  heal", so a value this build does not recognise is dropped from both counts
 *  instead of silently inflating the failure one. */
export function isHealFailure(event) {
  return event?.outcome === "exhausted" || event?.outcome === "no-candidates";
}

/**
 * What an unattended run writes its SUCCESSFUL heals into, beside the run's
 * other evidence.
 *
 * The app has somewhere to put these — its heal journal, which is what makes a
 * heal reviewable and what the propagation engine reads donors from. An
 * unattended run has nowhere: journalling on a CI runner writes into a library
 * that dies with the container, which is why `collectHealEvidence` counted
 * these events and then dropped them. So every heal a CI run performed was
 * invisible to the machine that owns the library — including to the donor
 * corpus, which is the gap `docs/plans/preemptive-updates.md` recorded under
 * Later.
 *
 * They travel as EVIDENCE, in the run's artifact directory, and become journal
 * entries only on the machine that ingests them (`good-looks ingest`, through
 * `shared/heal-ingest.mjs`). That split is deliberate: a container writing a
 * primary store it does not own is the thing the original comment was right to
 * refuse. Failures already travel this way as `heal-failures.json`; this is the
 * other half of the same run's story.
 */
export const RUN_HEALS_FILE = "run-heals.json";

/** The envelope `heal-failures.json`, `step-matches.json` and `run-heals.json`
 *  are written in. Spelled once because the app writes it through its artifact
 *  store and an unattended run writes it directly — and `mcp/artifacts.mjs`
 *  reads whichever produced it, so a second shape is a run whose evidence is
 *  simply not found. */
export function healArtifactEnvelope(testId, runId, entries) {
  return { testId, runId, entries };
}
