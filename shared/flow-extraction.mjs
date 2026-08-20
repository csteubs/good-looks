// When a selection of trainer steps may become a flow — the ONE spelling of
// the rule, imported by the renderer (to enable the button and word the
// refusal) and by the recorder service (to re-validate what arrives over IPC).
// Two copies would fail the way every duplicated rule here fails: the button
// allows what the backend refuses, and the user reads that as a broken button.
//
// Pure, like everything in shared/: it takes step shapes and answers with a
// verdict. Three refusals, each carrying the sentence the UI shows. Contiguity
// because extraction REPLACES a run of steps with one call — a gapped
// selection has no single place for the call to stand. Block balance because
// an `if` without its `endif` generates an unclosed brace in the flow and a
// stray one in the caller; the same scan refuses a selection that starts
// inside a block it doesn't own (`endif` before any `if`). A nested `runFlow`
// inside the selection is fine — flows nest.

/**
 * @param {ReadonlyArray<{ id: string, type: string }>} steps
 * @param {ReadonlyArray<string>} ids
 * @returns {{ ok: true, start: number, end: number } | { ok: false, reason: string }}
 */
export function extractableRange(steps, ids) {
  if (ids.length === 0) return { ok: false, reason: "Select the steps to extract first." };
  const wanted = new Set(ids);
  /** @type {number[]} */
  const indices = [];
  steps.forEach((s, i) => {
    if (wanted.has(s.id)) indices.push(i);
  });
  if (indices.length !== wanted.size) {
    return { ok: false, reason: "Some selected steps are no longer in the list." };
  }
  const start = indices[0];
  const end = indices[indices.length - 1];
  if (end - start + 1 !== indices.length) {
    return { ok: false, reason: "Select a contiguous run of steps — a flow is one block." };
  }
  let depth = 0;
  for (let i = start; i <= end; i++) {
    if (steps[i].type === "if") depth += 1;
    if (steps[i].type === "endif") {
      depth -= 1;
      if (depth < 0) {
        return { ok: false, reason: "The selection can't split an if / end if block." };
      }
    }
  }
  if (depth !== 0) {
    return { ok: false, reason: "The selection can't split an if / end if block." };
  }
  return { ok: true, start, end };
}
