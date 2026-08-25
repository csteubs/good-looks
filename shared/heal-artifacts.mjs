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
