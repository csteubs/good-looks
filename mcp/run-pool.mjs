// Bounded concurrency for the MCP server's run_batch tool.
//
// Pure — no filesystem, no process, no Playwright — so `npm run check:run-pool`
// can exercise the sequencing directly, the same way select-tests.mjs is
// checked. The app's batch runner has its own copy of this shape
// (main/services/batch-runner.ts); check:batch-runner pins the two to the same
// behaviour, because a suite that runs differently depending on whether an
// agent or a person started it is worse than one that's slow.
//
// One deliberate difference from the app: there are NO lanes here. The app keys
// a live run by testId (runId === testId) and so must serialize repeat entries
// for one test; the MCP's executeTest mints a fresh uuid per run and never keys
// by testId, so the same test twice in parallel is fine — each run has its own
// PW_OUTPUT_DIR, so they don't share Playwright's scratch directory either.
// Don't "fix" this by adding lanes: it would serialize work that doesn't need
// to be.

/** Ceiling on parallel runs. Mirrors MAX_BATCH_CONCURRENCY in
 *  main/recorder/types.ts — every unit is a Node process plus a browser. */
export const MAX_PARALLEL = 16;

/** Clamp a requested parallelism to [1, min(MAX_PARALLEL, itemCount)].
 *  A non-number, or anything below 1, means one at a time. */
export function clampParallel(requested, itemCount) {
  const max = Math.max(1, Math.min(MAX_PARALLEL, Math.floor(itemCount) || 1));
  if (typeof requested !== "number" || !Number.isFinite(requested)) return 1;
  return Math.max(1, Math.min(max, Math.floor(requested)));
}

/**
 * Run `worker(item, index)` over every item, at most `limit` at a time.
 *
 * Items are CLAIMED in order, so with limit 1 this is exactly a sequential
 * for-loop — the path an agent gets when it doesn't ask for parallelism must
 * not be a parallel path with the dial turned down.
 *
 * A worker that throws does not abort the pool: one failing test is the normal
 * case for a suite run, and taking the rest of the batch down with it is the
 * one behaviour a batch must never have. The caller records outcomes into its
 * own results array by index; this returns nothing.
 */
export async function runPool(items, limit, worker) {
  const count = Math.max(1, Math.floor(limit) || 1);
  let next = 0;
  const drain = async () => {
    for (;;) {
      // No await between the read and the increment, so on a single-threaded
      // event loop two workers can never claim the same index.
      const index = next++;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch {
        // Swallowed on purpose — see above. The worker owns recording it.
      }
    }
  };
  await Promise.all(Array.from({ length: count }, () => drain()));
}
