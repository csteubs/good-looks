// Types for run-attempts.mjs.
//
// Hand-written, like every .d.mts here: the implementation is plain ESM so the
// CLI and the MCP can import it with no build step, and this file is what keeps
// `npm run type-check` a real gate over the TypeScript callers in `main/` and
// `renderer/`.

/** The most retries any caller may ask for. */
export declare const MAX_RETRIES: number;

/** Coerce a requested retry count, or null when it is not usable — so a caller
 *  can tell "not asked for" from "asked for, badly" and refuse the second. */
export declare function normalizeRetries(value: unknown): number | null;

/** The retry fields a run should record, to be SPREAD into it. Empty when the
 *  run was never retried, so a row that ran once is not made indistinguishable
 *  from one that predates the field. `maxAttempt` is the highest attempt that
 *  reported a step. */
export declare function retryFields(run: { status: string; maxAttempt: number }): {
  attempt?: number;
  passedOnRetry?: boolean;
};

/** What a run contributes to a flake TRANSITION SERIES: `"failed"` for a
 *  retried pass, its own status otherwise. Distinct from the outcome tally,
 *  where the same run counts as passed. */
export declare function flakeSignal(record: { status: string; passedOnRetry?: boolean }): string;

/** Did this run go red at any point, whatever it finally reported? */
export declare function everFailed(record: { status: string; passedOnRetry?: boolean }): boolean;
