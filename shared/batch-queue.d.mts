// Types for batch-queue.mjs. See run-pacing.d.mts for why these are hand-written.

import type { Dataset, RunBrowser } from "../main/recorder/types.js";

/** One queued execution: a test, optionally bound to a dataset row and/or a
 *  specific engine. `browser`/`headless` absent means "use the batch-wide
 *  option", which is what every pre-per-row caller produces. */
export interface BatchEntry {
  testId: string;
  datasetId?: string;
  datasetName?: string;
  vars?: Record<string, string>;
  browser?: RunBrowser;
  headless?: boolean;
  /** What this entry failing does to the rest of the batch. Absent means
   *  "continue", which is what every caller without Routines produces. */
  onFailure?: "continue" | "stopRoutine" | "skipGroup";
  /** The Routine group this entry came from. Absent for a top-level step and
   *  for every non-Routine caller; `skipGroup` on an entry with no group has
   *  no rest-of-group to skip, so it continues. */
  groupId?: string;
  /** Which side of the Routine's barriers this entry falls on. Absent means
   *  segment 0 — one segment, which is what every non-Routine caller gets. */
  segment?: number;
}

/** One test's engines and headedness, as sent by the Batch view. Validated,
 *  deduped and RUN_BROWSERS-ordered by the `batch:run` handler before it gets
 *  here; `browsers` is never empty. */
export interface PerTestRunOption {
  testId: string;
  browsers: RunBrowser[];
  headless: boolean;
  /** Normalised by whoever built this — `routineRunPlan` for a Routine, the
   *  `batch:run` handler for anything off the wire. The runner acts on it, so
   *  it must never arrive as a raw stored or wire value. */
  onFailure?: "continue" | "stopRoutine" | "skipGroup";
  /** The Routine group these entries belong to, stamped by `routineRunPlan`. */
  groupId?: string;
  /** Which side of the Routine's barriers these entries fall on. */
  segment?: number;
}

export declare function buildQueue(
  params: {
    testIds: string[];
    datasetIds?: string[];
    allDatasets?: boolean;
    perTest?: PerTestRunOption[];
  },
  getDatasets: (testId: string) => Dataset[],
): BatchEntry[];
