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

/**
 * Resolve a selection plus dataset options into the ordered list of executions.
 *
 * @param {{ testIds: string[], datasetIds?: string[], allDatasets?: boolean }} params
 * @param {(testId: string) => Array<{ id: string, name: string, values: Record<string, string> }>} getDatasets
 * @returns {Array<{ testId: string, datasetId?: string, datasetName?: string, vars?: Record<string, string> }>}
 */
export function buildQueue(params, getDatasets) {
  const wantsSweep = params.allDatasets === true || (params.datasetIds?.length ?? 0) > 0;
  if (!wantsSweep) return params.testIds.map((testId) => ({ testId }));
  const wanted = new Set(params.datasetIds ?? []);
  const out = [];
  for (const testId of params.testIds) {
    const rows = getDatasets(testId).filter(
      (d) => params.allDatasets === true || wanted.has(d.id),
    );
    // A test with no matching rows still runs once, with its declared defaults.
    // Dropping it would turn "sweep my suite" into "silently skip the tests that
    // aren't parameterized yet".
    if (rows.length === 0) {
      out.push({ testId });
      continue;
    }
    for (const row of rows) {
      out.push({ testId, datasetId: row.id, datasetName: row.name, vars: row.values });
    }
  }
  return out;
}
