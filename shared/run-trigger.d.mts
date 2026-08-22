// Types for run-trigger.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so `mcp/server.mjs` can import it with no build step, and this file is
// what keeps `npm run type-check` a real gate over the TypeScript callers (the
// run-history store, the runner, the batch runner, and the renderer's chip).

/** Who or what started a run. See RUN_TRIGGERS for why `replay` is not one of
 *  these — it is a different axis, already recorded as `replayOfRunId`. */
export type RunTrigger = "manual" | "schedule" | "mcp";

export declare const RUN_TRIGGERS: readonly RunTrigger[];

/** Narrow an unknown value to a known trigger, or `undefined`. Absent is
 *  UNKNOWN, never `manual` — see the implementation for why. */
export declare function normalizeRunTrigger(value: unknown): RunTrigger | undefined;

export declare const RUN_TRIGGER_DESCRIPTIONS: Record<RunTrigger, string>;
