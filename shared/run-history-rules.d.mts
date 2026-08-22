// Types for run-history-rules.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so `mcp/server.mjs` can import it with no build step, and this file is
// what keeps `npm run type-check` a real gate over the TypeScript caller
// (main/services/run-history-store.ts).

/** One day's worth of runs the cap has dropped. */
export interface PrunedDay {
  /** local midnight of the day the runs started, epoch ms */
  dayStart: number;
  runs: number;
  passed: number;
  failed: number;
}

/** The lifetime record of what the cap has discarded — what keeps "Total runs"
 *  true once `run-history.json` is full. */
export interface PrunedTally {
  runs: number;
  passed: number;
  failed: number;
  days: PrunedDay[];
  /** Whether the one-time seed from the metrics DB has run. Recorded because
   *  the seed would otherwise repeat on every launch, resurrecting history the
   *  user asked the app to forget. */
  adopted: boolean;
}

/** How many run records `run-history.json` keeps — a cache size, not a history
 *  length. Both writers must agree; see the module header for what happened the
 *  one time they did not. */
export declare const RUN_HISTORY_CAP: number;

export declare const PRUNED_DAYS_KEPT: number;

export declare function dayStartOf(ms: number): number;

export declare function emptyPrunedTally(): PrunedTally;

/** Narrow a tally PARSED off disk, or answer zeroes. All-or-none. */
export declare function readPrunedTally(parsed: unknown): PrunedTally;

/** Fold one pruned run into a tally, in place. Returns whether it counted —
 *  a baseline-update record is an event, not a run. */
export declare function foldPrunedRun(
  tally: PrunedTally,
  rec: { startedAt: number; status: string; kind?: string },
): boolean;
