// Types for batch-queue.mjs. See run-pacing.d.mts for why these are hand-written.

import type { Dataset } from "../main/recorder/types.js";

/** One queued execution: a test, optionally bound to a dataset row. */
export interface BatchEntry {
  testId: string;
  datasetId?: string;
  datasetName?: string;
  vars?: Record<string, string>;
}

export declare function buildQueue(
  params: { testIds: string[]; datasetIds?: string[]; allDatasets?: boolean },
  getDatasets: (testId: string) => Dataset[],
): BatchEntry[];
