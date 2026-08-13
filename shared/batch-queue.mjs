// Expanding a batch selection into the queue that actually executes.
//
// Pure (see the admission rule in run-pacing.mjs). Moved out of
// main/services/batch-runner.ts so the MCP's `run_batch` sweeps datasets with
// the SAME semantics the app's Batch view does, rather than a second
// implementation that agrees until the day one of them changes.
//
// This is where a sweep gets its meaning: without dataset options the queue is
// exactly the selection (so nothing about existing batches changes), and with
// them the same test appears once per matching row, in the order the rows are
// declared.
//
// TWO things multiply a test's entries: dataset rows, and the Batch view's
// per-row engine multi-select (`perTest`). Both expand ENGINE-MAJOR INSIDE the
// test and never across tests, because the app's runner groups the queue into
// lanes by testId and a test's entries must stay contiguous for that grouping
// to reproduce queue order. The MCP's `run_batch` passes no `perTest`, so its
// queues are byte-identical to what they were; `run_routine` does pass one,
// built by `routineRunPlan`, which is the whole reason that expansion lives
// here rather than in the two callers that need it.

/**
 * Resolve a selection plus dataset options into the ordered list of executions.
 *
 * The selection is DEDUPED first. The Batch view's selection is a Set so it
 * can't produce a repeat, but IPC and the MCP can, and a repeated id is what
 * breaks the queue's one structural guarantee: that all of a test's entries sit
 * together. `["a", "b", "a"]` would otherwise interleave, and the app's runner
 * groups the queue into lanes (see `buildLanes`), which would reorder it.
 * Running one test twice in a single batch with identical options has no
 * meaning anyway; running it once per dataset row does, and that still works.
 *
 * `perTest` entries arrive already validated, deduped and RUN_BROWSERS-ordered
 * by the `batch:run` IPC handler — this module is shared with the MCP and so
 * cannot import the app's types to re-check them. A test absent from `perTest`
 * contributes one entry with no engine of its own, which is exactly what every
 * caller produced before per-row options existed.
 *
 * @param {{ testIds: string[], datasetIds?: string[], allDatasets?: boolean, perTest?: Array<{ testId: string, browsers: string[], headless: boolean }> }} params
 * @param {(testId: string) => Array<{ id: string, name: string, values: Record<string, string> }>} getDatasets
 * @returns {Array<{ testId: string, datasetId?: string, datasetName?: string, vars?: Record<string, string>, browser?: string, headless?: boolean }>}
 */
export function buildQueue(params, getDatasets) {
  const testIds = [...new Set(params.testIds)];
  const wantsSweep = params.allDatasets === true || (params.datasetIds?.length ?? 0) > 0;
  const wanted = new Set(params.datasetIds ?? []);
  const byTest = new Map();
  for (const p of params.perTest ?? []) byTest.set(p.testId, p);

  const out = [];
  for (const testId of testIds) {
    // No per-row entry → one undefined "engine", so the test takes the
    // batch-wide browser exactly as it did before per-row options existed.
    // That is the MCP path and every stored batch replayed from it.
    const engines = byTest.get(testId)?.browsers ?? [undefined];
    const headless = byTest.get(testId)?.headless;
    const rows = wantsSweep
      ? getDatasets(testId).filter((d) => params.allDatasets === true || wanted.has(d.id))
      : [];
    for (const browser of engines) {
      const base = {
        testId,
        ...(browser ? { browser } : {}),
        ...(headless !== undefined ? { headless } : {}),
      };
      // A test with no matching rows still runs once, with its declared
      // defaults. Dropping it would turn "sweep my suite" into "silently skip
      // the tests that aren't parameterized yet".
      if (rows.length === 0) {
        out.push(base);
        continue;
      }
      for (const row of rows) {
        out.push({ ...base, datasetId: row.id, datasetName: row.name, vars: row.values });
      }
    }
  }
  return out;
}
