// The Script IDE's inspections: ONE list of rule ids with the words the
// Settings pane and the editor use for them. The rules themselves run in
// the TypeScript service (main/services/ts-service/core.ts); the renderer
// only needs to name them, and a rule named in one place and not the other
// is a setting that toggles nothing.

/** @typedef {"no-wait-for-timeout" | "no-force-without-reason" | "missing-await" | "raw-css-locator" | "unwrapped-statement" | "index-pinned-locator"} InspectionRule */

/** @type {{ id: InspectionRule; label: string; summary: string; severity: "error" | "warning" | "hint"; fixes: boolean }[]} */
export const INSPECTIONS = [
  {
    id: "missing-await",
    label: "Promise not awaited",
    summary: "A page action or expect() whose promise nothing awaits: the test moves on, and a failure there cannot fail the test.",
    severity: "error",
    fixes: true,
  },
  {
    id: "no-wait-for-timeout",
    label: "Fixed-time wait",
    summary: "waitForTimeout passes whether or not the page is ready. A web-first assertion waits for the thing itself.",
    severity: "warning",
    fixes: true,
  },
  {
    id: "no-force-without-reason",
    label: "force: true without a reason",
    summary: "Skips actionability checks, so the step passes against a covered or disabled element. Quiet when a comment on the line or the line above says why.",
    severity: "warning",
    fixes: true,
  },
  {
    id: "unwrapped-statement",
    label: "Statement outside test.step",
    summary: "The Steps tab shows it as code rather than a step, and a run reports no step for it.",
    severity: "hint",
    fixes: true,
  },
  {
    id: "raw-css-locator",
    label: "CSS locator",
    summary: "Follows the page's markup, which changes without the page changing. A role, label, placeholder or test id survives a restyle.",
    severity: "hint",
    fixes: false,
  },
  {
    id: "index-pinned-locator",
    label: "Locator pinned by index",
    summary: "nth(), first() and last() pick by DOM order; a reordered page picks a different element.",
    severity: "hint",
    fixes: false,
  },
];

/** @type {InspectionRule[]} */
export const INSPECTION_RULES = INSPECTIONS.map((i) => i.id);

/** Every rule on — the default. */
export function defaultInspections() {
  /** @type {Record<InspectionRule, boolean>} */
  const out = /** @type {Record<InspectionRule, boolean>} */ ({});
  for (const r of INSPECTION_RULES) out[r] = true;
  return out;
}

/** A settings value rebuilt over the known rules: unknown keys dropped,
 *  non-booleans read as on. */
export function normalizeInspections(raw) {
  const out = defaultInspections();
  if (!raw || typeof raw !== "object") return out;
  for (const r of INSPECTION_RULES) {
    const v = /** @type {Record<string, unknown>} */ (raw)[r];
    if (typeof v === "boolean") out[r] = v;
  }
  return out;
}
