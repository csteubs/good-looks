// Test selection for the MCP server's run_batch tool.
//
// Pure — no filesystem, no process — so `npm run check:mcp-select` can exercise
// it directly. Selection semantics deliberately mirror the app's Batch view:
// tags match case-insensitively, and hidden tests are excluded from tag/all
// selections (they're removed from the sidebar, so "run everything" shouldn't
// resurrect them) but are still honored when named explicitly by id.

/** Sentinel matching tests that carry no tags at all. */
export const UNTAGGED = "__untagged__";

/** Sentinel matching tests that are in no folder — the top level of the
 *  library rail. Spelled like `UNTAGGED` because it does the same job for the
 *  other axis, and a caller that learned one shape should not have to learn a
 *  second. */
export const UNGROUPED = "__ungrouped__";

function hasTag(test, tag) {
  const key = String(tag).toLowerCase();
  return (test.tags ?? []).some((t) => String(t).toLowerCase() === key);
}

/** A test's folder, trimmed, or `""` for the top level.
 *
 *  Trimmed on READ as well as on write, the same as the rail does: the store
 *  normalises what it is given, but tests.json is a file on disk that a human
 *  can edit, and this process reads it directly. */
function groupOf(test) {
  return typeof test.group === "string" ? test.group.trim() : "";
}

/**
 * Resolve a run_batch selection to an ordered list of tests.
 *
 * @param {Array} tests      every TestRecord from tests.json
 * @param {object} selector  { testIds?: string[], tag?: string, group?: string }
 * @returns {{ tests: Array, missing: string[] }}
 *   `missing` lists explicitly-requested ids that don't exist, so the caller can
 *   report them rather than silently running a shorter batch than asked for.
 *
 * With none of testIds, tag or group, selects every visible test.
 *
 * PRECEDENCE IS ids > group > tag, and it is deliberate rather than incidental.
 * Explicit ids win because the caller was specific. Between the other two, the
 * GROUP wins: a folder is where a test lives and a tag is a label it happens to
 * carry, so "the Checkout folder" is the narrower, more deliberate statement of
 * the two. Passing both is not an error — an agent that sent them meant the
 * one it was more specific about, and refusing the call would be worse than
 * answering it.
 */
export function selectTests(tests, selector = {}) {
  const all = Array.isArray(tests) ? tests : [];
  const { testIds, tag, group } = selector;

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
  // CASE-SENSITIVE, where a tag is not, and the asymmetry is the field's own.
  // A tag is MATCHED — the chip that says `smoke` has to find every spelling —
  // so folding is required there. A group is only ever DISPLAYED, so `Checkout`
  // and `checkout` are two folders in the rail, and a case-insensitive run
  // would sweep up a folder the caller can see is a different one.
  if (typeof group === "string" && group) {
    const matched =
      group === UNGROUPED
        ? visible.filter((t) => groupOf(t) === "")
        : visible.filter((t) => groupOf(t) === group.trim());
    return { tests: matched, missing: [] };
  }
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
