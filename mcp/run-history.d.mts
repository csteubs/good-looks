// Types for run-history.mjs.
//
// Hand-written like the other .d.mts files here: the server is plain ESM with no
// build step, and this exists so `check:mcp-run-history` consumes these with
// types rather than `any`.

import type { RunRecord } from "../main/recorder/types.js";
import type { PrunedTally } from "../shared/run-history-rules.mjs";

export declare const RUN_HISTORY_FILE: string;
export declare const PRUNED_TALLY_FILE: string;

export declare function listRuns(dataDir: string): RunRecord[];

/** Append a run and prune to the SHARED cap, folding every dropped run into the
 *  pruned tally the app maintains. */
export declare function saveRunRecord(
  dataDir: string,
  record: RunRecord,
  logText: string,
): void;

export type { PrunedTally };
