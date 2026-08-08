// Gathering the inputs flake analysis needs, from the three places they live.
//
// Kept separate from flake-analysis.ts on purpose: that module is pure and
// therefore testable against synthetic histories, which is the only way to
// exercise cases like "alternates on every run for twenty runs" without
// twenty real runs. This module is the I/O half — run logs, replay models and
// the heal journal — and does nothing but assemble.

import { logger } from "@glaze/core/backend";

import { artifactStore } from "./artifact-store.js";
import { healJournalStore } from "./heal-journal-store.js";
import { runHistoryStore } from "./run-history-store.js";
import type { RunDetail } from "../../shared/flake-analysis.mjs";
import type { RunRecord } from "../recorder/types.js";

/**
 * How many recent runs to analyse.
 *
 * The history cap is 1000, and reading a log per failed run is the expensive
 * part. 200 is enough for any verdict this produces to be well-founded while
 * keeping the panel instant. The number of runs actually analysed is reported
 * back, so a truncated window is visible rather than implied.
 */
export const ANALYSIS_WINDOW = 200;

/**
 * Pull the first line that looks like the actual failure out of a run log.
 *
 * Playwright's `line` reporter puts a lot before and after it. This is
 * deliberately simple — it looks for the recognised error shapes and gives up
 * rather than guessing, because a wrong "error" would silently become a
 * clustering key and split or merge real groups.
 */
export function extractError(log: string): string | undefined {
  const lines = log.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Playwright assertion failures and thrown errors.
    if (/^Error:/.test(line)) return line;
    if (/^\s*\d+\)\s/.test(raw) && /Error|expect/.test(line)) return line;
    if (/^(TimeoutError|AssertionError|TypeError|ReferenceError):/.test(line)) return line;
    if (/^expect\(.*\)\s/.test(line)) return line;
    if (/Timeout .* exceeded/i.test(line)) return line;
  }
  return undefined;
}

/** Assemble the per-run detail for a set of runs. Logs are read only for
 *  FAILED runs — a passing run has no failure to cluster, and reading its log
 *  would be the bulk of the cost for none of the value. */
export function gatherRunDetails(runs: readonly RunRecord[]): RunDetail[] {
  // One journal read per test rather than per run.
  const healsByTest = new Map<string, ReturnType<typeof healJournalStore.list>>();
  const out: RunDetail[] = [];

  for (const run of runs) {
    const detail: RunDetail = { runId: run.id };

    // Which step failed — from the replay, when this run captured one.
    try {
      const replay = artifactStore.readReplay(run.testId, run.id);
      if (replay && replay.failedIndex !== null) {
        const step = replay.steps[replay.failedIndex];
        if (step) {
          detail.failedStepId = step.stepId;
          detail.failedStepLabel = step.label;
        }
      }
    } catch (err) {
      logger.warn("flake", "Could not read a replay", { runId: run.id, err: String(err) });
    }

    if (run.status === "failed") {
      try {
        detail.error = extractError(runHistoryStore.readLog(run.id));
      } catch {
        // A pruned or unreadable log just means this run can't be clustered.
      }
    }

    if (run.healedSteps) {
      let heals = healsByTest.get(run.testId);
      if (!heals) {
        heals = healJournalStore.list(run.testId);
        healsByTest.set(run.testId, heals);
      }
      const ids = heals.filter((h) => h.runId === run.id).map((h) => h.stepId);
      if (ids.length > 0) detail.healedStepIds = ids;
    }

    out.push(detail);
  }
  return out;
}

/** The recent runs to analyse, newest-first as stored.
 *
 *  listLive, so a deleted test cannot appear in Stability. Two reasons, and the
 *  second is the one that bites: the panel names the test in every row, and its
 *  detail is enriched from `artifactStore.readReplay` and the heal journal —
 *  both of which the delete really does remove — so an orphan would render as a
 *  named row with the explanation stripped out of it. */
export function analysisWindow(): RunRecord[] {
  return runHistoryStore.listLive().slice(0, ANALYSIS_WINDOW);
}
