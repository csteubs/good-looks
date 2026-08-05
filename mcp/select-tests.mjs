// Test selection for the MCP server's run_batch tool.
//
// Pure — no filesystem, no process — so `npm run check:mcp-select` can exercise
// it directly. Selection semantics deliberately mirror the app's Batch view:
// tags match case-insensitively, and hidden tests are excluded from tag/all
// selections (they're removed from the sidebar, so "run everything" shouldn't
// resurrect them) but are still honored when named explicitly by id.

/** Sentinel matching tests that carry no tags at all. */
export const UNTAGGED = "__untagged__";

function hasTag(test, tag) {
  const key = String(tag).toLowerCase();
  return (test.tags ?? []).some((t) => String(t).toLowerCase() === key);
}

/**
 * Resolve a run_batch selection to an ordered list of tests.
 *
 * @param {Array} tests      every TestRecord from tests.json
 * @param {object} selector  { testIds?: string[], tag?: string }
 * @returns {{ tests: Array, missing: string[] }}
 *   `missing` lists explicitly-requested ids that don't exist, so the caller can
 *   report them rather than silently running a shorter batch than asked for.
 *
 * With neither testIds nor tag, selects every visible test.
 */
export function selectTests(tests, selector = {}) {
  const all = Array.isArray(tests) ? tests : [];
  const { testIds, tag } = selector;

  if (Array.isArray(testIds) && testIds.length > 0) {
    const byId = new Map(all.map((t) => [t.id, t]));
    const picked = [];
    const missing = [];
    // Preserve the caller's order — a batch is a sequence, and the requester
    // may well care which test runs first.
    for (const id of testIds) {
      const found = byId.get(id);
      if (found) picked.push(found);
      else missing.push(id);
    }
    return { tests: picked, missing };
  }

  const visible = all.filter((t) => !t.hidden);
  if (typeof tag === "string" && tag) {
    const matched =
      tag === UNTAGGED
        ? visible.filter((t) => (t.tags ?? []).length === 0)
        : visible.filter((t) => hasTag(t, tag));
    return { tests: matched, missing: [] };
  }

  return { tests: visible, missing: [] };
}

/** Aggregate per-test outcomes into the same summary shape the app uses. */
export function summarizeResults(results, durationMs) {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  return {
    total: results.length,
    passed,
    failed,
    skipped,
    // Matches the app: something ran and nothing failed. All-skipped is not ok.
    ok: failed === 0 && passed > 0,
    durationMs,
  };
}
