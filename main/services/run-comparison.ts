// Then-vs-now comparison for a re-executed run.
//
// The comparison itself MOVED to shared/run-comparison.mjs on 2026-08-07, so
// the MCP server can serve the same verdicts the app shows rather than a second
// implementation of them. What stays here is the app's half: reading the two
// replay models through the artifact store, which reaches @glaze/core/backend
// and therefore cannot live in shared/.
//
// See the shared module for the reasoning behind each delta — in particular why
// a step that passed then and fails now is reported as "changed since" rather
// than as a regression.

import { artifactStore } from "./artifact-store.js";
import { compareReplays } from "../../shared/run-comparison.mjs";
import type { RunComparison } from "../../shared/run-comparison.mjs";

export type { StepDelta, StepComparison, RunComparison } from "../../shared/run-comparison.mjs";

/** Compare a past run with a re-run of it. Returns null when either replay is
 *  missing (e.g. pruned by retention). */
export function compareRuns(
  testId: string,
  baseRunId: string,
  replayRunId: string,
): RunComparison | null {
  return compareReplays(
    artifactStore.readReplay(testId, baseRunId),
    artifactStore.readReplay(testId, replayRunId),
  );
}
