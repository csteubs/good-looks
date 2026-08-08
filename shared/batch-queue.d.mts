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
}

/** One test's engines and headedness, as sent by the Batch view. Validated,
 *  deduped and RUN_BROWSERS-ordered by the `batch:run` handler before it gets
 *  here; `browsers` is never empty. */
export interface PerTestRunOption {
  testId: string;
  browsers: RunBrowser[];
  headless: boolean;
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
