// Deciding which accessibility violations are NEW.
//
// Running axe against a real site for the first time reports dozens of
// pre-existing problems — most of them true, none of them caused by the change
// you are testing. A feature that shows all of them on every run is a feature
// nobody reads after the first day. So a violation counts only if it is not in
// the test's accepted baseline, exactly as a pixel diff counts only against a
// pinned screenshot.
//
// Pure, so `check:visual-pipeline` can drive it without a browser.

/** One violation, compacted by the capture fixture. */
export interface A11yViolation {
  /** axe rule id, e.g. "color-contrast" */
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical";
  /** axe's short help text for the rule */
  help: string;
  /** CSS-ish targets of the offending nodes, capped by the fixture */
  nodes: string[];
}

/** A11y outcome for one step, persisted in replay.json. */
export interface A11yResult {
  /** every violation the check found */
  violations: A11yViolation[];
  /** keys not present in the accepted baseline — what the UI flags */
  newKeys: string[];
  /** how many accepted violations were seen and deliberately not flagged */
  acceptedCount: number;
}

export const IMPACT_ORDER: A11yViolation["impact"][] = [
  "critical",
  "serious",
  "moderate",
  "minor",
];

/**
 * The identity of a violation, for baseline comparison.
 *
 * Rule id AND node target, not rule id alone. Keying on the rule would mean
 * accepting one low-contrast label silently accepts every future contrast
 * failure anywhere on the page — the baseline would swallow exactly the
 * regressions it exists to let through.
 */
export function violationKey(id: string, target: string): string {
  return `${id}|${target}`;
}

/** Every key a violation covers — one per offending node. */
export function keysOf(v: A11yViolation): string[] {
  if (!v.nodes || v.nodes.length === 0) return [violationKey(v.id, "")];
  return v.nodes.map((t) => violationKey(v.id, t));
}

/**
 * Compare a step's violations against its accepted baseline.
 *
 * Returns null when there is nothing to report — no violations at all — so a
 * clean step carries no a11y payload rather than an empty one that the UI would
 * have to know to ignore.
 */
export function diffViolations(
  violations: A11yViolation[] | undefined,
  accepted: string[] | undefined,
): A11yResult | null {
  if (!violations || violations.length === 0) return null;
  const acceptedSet = new Set(accepted ?? []);
  const newKeys: string[] = [];
  let acceptedCount = 0;
  for (const v of violations) {
    for (const key of keysOf(v)) {
      if (acceptedSet.has(key)) acceptedCount++;
      else if (!newKeys.includes(key)) newKeys.push(key);
    }
  }
  return { violations, newKeys, acceptedCount };
}

/** Whether a step's result is worth flagging in the UI. */
export function hasNewViolations(result: A11yResult | undefined): boolean {
  return !!result && result.newKeys.length > 0;
}

/**
 * The keys accepting a step's current violations would pin.
 *
 * Everything the step reported, not just the new ones: "accept" means "this is
 * the state I'm signing off", and leaving previously-accepted keys out would
 * quietly un-accept them the next time the baseline was rewritten.
 */
export function acceptKeysFor(violations: A11yViolation[] | undefined): string[] {
  if (!violations) return [];
  const out: string[] = [];
  for (const v of violations) {
    for (const key of keysOf(v)) {
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

/** The worst impact among a step's NEW violations, for badge colouring.
 *  Ranked by axe's own severity order rather than by count: one critical
 *  violation matters more than six minor ones. */
export function worstNewImpact(result: A11yResult | undefined): A11yViolation["impact"] | null {
  if (!result || result.newKeys.length === 0) return null;
  const newSet = new Set(result.newKeys);
  let worst: A11yViolation["impact"] | null = null;
  for (const v of result.violations) {
    if (!keysOf(v).some((k) => newSet.has(k))) continue;
    if (worst === null || IMPACT_ORDER.indexOf(v.impact) < IMPACT_ORDER.indexOf(worst)) {
      worst = v.impact;
    }
  }
  return worst;
}
