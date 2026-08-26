// WHO started a run — the one definition of the vocabulary.
//
// ── Why this file exists ───────────────────────────────────────────────────
// `RunRecord` records what a run DID in exhaustive detail and nothing at all
// about what caused it to happen. Every run therefore reads as though a person
// pressed Run, which is how a scheduled routine firing at 03:00 and a person
// clicking Run at their desk become the same evidence.
//
// The field cannot be backfilled. A run already on disk was started by
// something that left no trace, so every row written before this exists is
// unclassifiable forever — which is the whole argument for adding it now,
// ahead of the consumer that will want it (see docs/plans/
// test-runner-improvements.md, R33 and §10).
//
// It lives in shared/ because there are ALREADY TWO WRITERS IN TWO PROCESSES:
// the app's run-history-store and `saveRunRecord` in mcp/server.mjs, which
// writes into the same run-history.json without importing a line of the app.
// The CLI (R3/R4) is a third writer, and adding its value here rather than in
// three places is what this module exists for. It landed as `cli` rather than
// the "ci" this note used to promise — see RUN_TRIGGERS for why.
// A transcribed literal is right the day it is written and silent afterwards.
//
// Pure (see the admission rule in run-pacing.mjs): no fs, no IPC, no process,
// no DOM.

/**
 * The triggers a run may record, in the order a UI should offer them.
 *
 * ONE AXIS ONLY: who or what initiated this run. Deliberately NOT a place to
 * record what the run executed — a re-run of a past run is `replayOfRunId` on
 * the same record, which says more (it names the run) and stays true whoever
 * pressed the button. Folding "replay" in here would cost the field the one
 * question it exists to answer, because a replay started by a person and a
 * replay started by an MCP client would then be the same value.
 *
 * - `manual`   a person, in the app: Run, Re-run, Run batch, or Run on a Routine.
 * - `schedule` the Routine scheduler's timer, including the launch prompt that
 *              accepts an occurrence missed while the app was closed — that
 *              path deliberately goes through the same `fireRoutine`, because
 *              two routes to "the schedule ran this" are two chances to forget
 *              that a scheduled run is always headless.
 * - `mcp`      an MCP client, which may well be an agent rather than a person.
 * - `cli`      the `good-looks` command line, wherever it was invoked from.
 *
 * ── Why the CLI's value is `cli` and not `ci` ──────────────────────────────
 * This module's own note used to promise "ci", written before the CLI existed.
 * The CLI exists now and it runs in two places: a pipeline, and a developer's
 * terminal — the documentation tells you to try it locally first. A run started
 * by hand on a laptop recorded as "ci" is invented evidence, which is precisely
 * what the `undefined`-not-`manual` rule below exists to prevent, and it would
 * be invented in the direction that matters: a CI-only filter would show runs
 * that were never on a runner.
 *
 * `cli` is never wrong, and it keeps this axis the one it has always been. Read
 * the four values back and they are all the same kind of answer — WHICH ENTRY
 * POINT started this: the app's UI, the app's scheduler, the MCP server, the
 * command line. "Was it CI?" is a different question with its own field, and it
 * is answerable properly: `provenance` (R6) carries the commit, branch and job
 * URL, so a consumer asks that rather than inferring from the entry point.
 */
export const RUN_TRIGGERS = ["manual", "schedule", "mcp", "cli"];

/**
 * Narrow an unknown value to a known trigger, or `undefined`.
 *
 * ABSENT IS NOT `manual`. A run recorded before this field could have been
 * started by any of the three — MCP and scheduled runs have been writing to
 * this store for months — so defaulting on read would invent evidence for
 * exactly the comparison the field exists to support. Same rule as `speed`,
 * and deliberately not the `runBrowser` rule: every pre-picker run really did
 * use chromium, and no such fact is available here.
 *
 * An unrecognised value narrows to `undefined` rather than being carried
 * through. This is a store shared by processes that ship on their own
 * schedules — a packaged app can read run-history.json written by a newer MCP
 * server — and "a trigger I do not know" is honestly unknown, whereas passing
 * it along would put an unvalidated string into every surface that renders one.
 *
 * @param {unknown} value
 * @returns {"manual" | "schedule" | "mcp" | "cli" | undefined}
 */
export function normalizeRunTrigger(value) {
  return typeof value === "string" && RUN_TRIGGERS.includes(value)
    ? /** @type {"manual" | "schedule" | "mcp" | "cli"} */ (value)
    : undefined;
}

/**
 * What each trigger MEANS, as a sentence.
 *
 * The only naming table here, deliberately: the Stats row marks a trigger with
 * a glyph rather than a word (its cell is a strip of icons, not a column of
 * chips), so the sentence IS the label — it is what the icon carries for hover
 * and for assistive tech. A short "Scheduled" would have been a second name for
 * the same thing with nothing reading it.
 */
export const RUN_TRIGGER_DESCRIPTIONS = {
  manual: "Started by hand, in the app",
  schedule: "Started by a Routine's schedule",
  mcp: "Started by an MCP client",
  cli: "Started from the command line",
};
