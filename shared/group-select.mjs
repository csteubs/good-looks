// Resolving a test group's membership.
//
// Lives in shared/ because the MCP server will need the SAME answer as the app
// when `run_group` lands: a group that means one set of tests in the sidebar
// and a different set over MCP is the kind of disagreement nobody notices until
// a nightly run has been quietly skipping something for a month.
//
// Pure by the admission rule — no fs, no @glaze/core, no IPC, no process. The
// caller reads tests off disk and hands them in.

/**
 * The tests a group currently contains, in library order.
 *
 * Union of two sources: ids named outright, and every test carrying one of the
 * group's tags. Resolved at read time on purpose — see the `TestGroup` doc
 * comment for why membership is not a stored list.
 *
 * @param {{ testIds?: string[], tags?: string[] } | null | undefined} group
 * @param {Array<{ id: string, tags?: string[] }>} tests every test in the
 *   library, in the order the caller wants results in.
 * @returns {Array<{ id: string, tags?: string[] }>} the matching tests, deduped,
 *   in `tests` order.
 */
export function resolveGroupTests(group, tests) {
  if (!group || !Array.isArray(tests)) return [];

  // Ids are matched against the live library rather than trusted: an id for a
  // deleted test must resolve to nothing, not to a run the runner then fails to
  // start. This is what lets group membership survive a deletion with no
  // cleanup pass — and a cleanup pass that failed to run is exactly how a
  // "self-healing" scheme ends up pointing at a test that isn't there.
  const wanted = new Set(Array.isArray(group.testIds) ? group.testIds : []);

  // Case-insensitive, matching how tags are compared everywhere else. A group
  // asking for "Smoke" must not miss a test tagged "smoke".
  const tagKeys = new Set(
    (Array.isArray(group.tags) ? group.tags : [])
      .filter((t) => typeof t === "string" && t.trim())
      .map((t) => t.trim().toLowerCase()),
  );

  // A group naming nothing resolves EMPTY, never "everything". The opposite
  // default is the dangerous one: an empty group that means the whole library
  // turns one careless click into a full-suite run.
  if (wanted.size === 0 && tagKeys.size === 0) return [];

  const out = [];
  for (const test of tests) {
    if (!test || typeof test.id !== "string") continue;
    if (wanted.has(test.id)) {
      out.push(test);
      continue;
    }
    if (tagKeys.size === 0) continue;
    const tags = Array.isArray(test.tags) ? test.tags : [];
    const hit = tags.some(
      (t) => typeof t === "string" && tagKeys.has(t.trim().toLowerCase()),
    );
    if (hit) out.push(test);
  }
  return out;
}

/**
 * How many tests a group currently resolves to — for a sidebar count, where
 * building the whole list would be wasted work.
 *
 * @param {{ testIds?: string[], tags?: string[] } | null | undefined} group
 * @param {Array<{ id: string, tags?: string[] }>} tests
 * @returns {number}
 */
export function countGroupTests(group, tests) {
  return resolveGroupTests(group, tests).length;
}
