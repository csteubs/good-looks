// Types for run-pool.mjs.
//
// The MCP server is plain ESM JavaScript on purpose — it runs standalone via
// `node mcp/server.mjs`, with no build step and without the app. This
// declaration exists so TypeScript checks (notably check:batch-runner, which
// imports both of these to pin app↔MCP concurrency parity) can consume it with
// types instead of `any`.

/** Ceiling on parallel runs. Mirrors MAX_BATCH_CONCURRENCY in main/recorder/types.ts. */
export declare const MAX_PARALLEL: number;

/** Clamp a requested parallelism to [1, min(MAX_PARALLEL, itemCount)].
 *  Anything that isn't a finite number means one at a time. */
export declare function clampParallel(requested: unknown, itemCount: number): number;

/** Run `worker` over every item, at most `limit` at a time, claiming items in
 *  order. A worker that throws does not abort the pool. */
export declare function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<unknown> | unknown,
): Promise<void>;
