// What the accessibility findings look like ACROSS the suite, and the identity
// rules that make that question answerable at all.
//
// WHY THIS IS SHARED, AND PURE. Three separate places needed the same three
// answers and each had its own copy of some of them:
//
//   - `main/services/a11y-diff.ts` decides what is NEW when a run finishes.
//   - `renderer/lib/a11y-format.ts` ranks and phrases it for the Visual view.
//   - The Stats board's Accessibility tile counts it, and its dashboard breaks
//     it down — the tile in the renderer, the breakdown over files on disk.
//
// `violationKey` and `keysOf` already carried "keep in sync" comments in two
// files. They are defined here once now and re-exported there, because the
// direction that drift fails is silent: two spellings of a key mean an accepted
// violation stops being recognised as accepted, and the app reports a finding
// the user already dismissed.
//
// PURE (CLAUDE.md): no fs, no shell import, no process. WHICH runs to roll up
// needs the disk on one side and a React Query cache on the other, so only the
// RULE for picking them lives here — `selectLatestA11yRuns` — and each side
// hands in the runs it found.

/** axe's own severity order, worst first. */
export const IMPACTS = ["critical", "serious", "moderate", "minor"];

/**
 * The identity of a violation, for baseline comparison.
 *
 * Rule id AND node target, not rule id alone. Keying on the rule would mean
 * accepting one low-contrast label silently accepts every future contrast
 * failure anywhere on the page — the baseline would swallow exactly the
 * regressions it exists to let through.
 *
 * @param {string} id
 * @param {string} target
 * @returns {string}
 */
export function violationKey(id, target) {
  return `${id}|${target}`;
}

/**
 * Every key a violation covers — one per offending node.
 *
 * @param {{ id: string, nodes?: string[] }} v
 * @returns {string[]}
 */
export function keysOf(v) {
  if (!v.nodes || v.nodes.length === 0) return [violationKey(v.id, "")];
  return v.nodes.map((t) => violationKey(v.id, t));
}

/**
 * The runs a suite-wide accessibility answer is computed over: each test's most
 * recent run that actually COMPLETED checks.
 *
 * Two exclusions, both load-bearing. A baseline update is an event, not a run,
 * and carries an incidental status. And a run with the toggle on that completed
 * zero checks is a FAULT, not a clean result — counting it would let a broken
 * fixture read as "nothing found", which is the most confident possible way of
 * being wrong. Taking the latest run that checked, rather than the latest run,
 * is what stops one screenshot-less run blanking results that are still true.
 *
 * @template {{ testId: string, startedAt: number, kind?: string, a11yChecks?: number }} T
 * @param {readonly T[]} runs
 * @returns {T[]}
 */
export function selectLatestA11yRuns(runs) {
  /** @type {Map<string, T>} */
  const best = new Map();
  for (const run of runs) {
    if (run.kind === "baseline-update") continue;
    if ((run.a11yChecks ?? 0) <= 0) continue;
    const prev = best.get(run.testId);
    if (!prev || run.startedAt > prev.startedAt) best.set(run.testId, run);
  }
  return [...best.values()];
}

/**
 * Roll a set of runs up into "which rules are failing, how badly, and where".
 *
 * COUNTS OVERLAP AND THAT IS THE HONEST SHAPE. A step carrying a critical and a
 * moderate violation is counted under both impacts, so the four impact counts
 * add up to more than `stepsWithNew`. The alternative — filing each step under
 * its worst impact only — makes the numbers partition neatly and hides every
 * moderate rule that happens to share a step with a critical one, which is the
 * rule you were looking for when you opened "Moderate". Callers state the
 * overlap; nothing here adds the impacts together.
 *
 * ONLY NEW VIOLATIONS. Everything else is the accepted baseline, and against a
 * real site that is dozens of true, pre-existing findings — a report that
 * cannot say which are new is one nobody reads twice.
 *
 * @param {readonly {
 *   testId: string, testName?: string | null, runId: string, startedAt?: number,
 *   steps: readonly { stepId?: string, label?: string | null, index?: number,
 *     a11y?: { violations?: { id: string, impact: string, help?: string, nodes?: string[] }[],
 *              newKeys?: string[] } }[]
 * }[]} runs
 * @returns {import("./a11y-rollup.d.mts").A11yRollup}
 */
export function rollupA11y(runs) {
  /** @type {Map<string, import("./a11y-rollup.d.mts").A11yRuleRollup>} */
  const rules = new Map();
  const stepsPerImpact = new Map(IMPACTS.map((i) => [i, 0]));
  let stepsWithNew = 0;

  for (const run of runs) {
    for (const step of run.steps ?? []) {
      const newKeys = new Set(step.a11y?.newKeys ?? []);
      if (newKeys.size === 0) continue;
      stepsWithNew++;
      // Which impacts THIS step contributes to, counted once each however many
      // violations of that impact it carries.
      const impactsHere = new Set();
      for (const v of step.a11y?.violations ?? []) {
        const hits = keysOf(v).filter((k) => newKeys.has(k));
        if (hits.length === 0) continue;
        const impact = IMPACTS.includes(v.impact) ? v.impact : "minor";
        impactsHere.add(impact);
        const key = `${impact}|${v.id}`;
        let rule = rules.get(key);
        if (!rule) {
          rule = { id: v.id, impact, help: v.help ?? v.id, steps: 0, nodes: 0, where: [] };
          rules.set(key, rule);
        }
        rule.steps++;
        rule.nodes += hits.length;
        rule.where.push({
          testId: run.testId,
          testName: run.testName ?? null,
          runId: run.runId,
          startedAt: run.startedAt ?? 0,
          stepId: step.stepId ?? null,
          stepLabel: step.label ?? null,
          index: step.index ?? 0,
          nodes: hits.length,
        });
      }
      for (const impact of impactsHere) {
        stepsPerImpact.set(impact, (stepsPerImpact.get(impact) ?? 0) + 1);
      }
    }
  }

  const byImpact = IMPACTS.map((impact) => ({
    impact,
    steps: stepsPerImpact.get(impact) ?? 0,
    rules: [...rules.values()].filter((r) => r.impact === impact).length,
  }));

  return {
    checkedRuns: runs.length,
    stepsWithNew,
    byImpact,
    // Worst impact first, then the rule hitting the most steps — the order the
    // dashboard reads them in, decided here so both callers cannot disagree.
    rules: [...rules.values()].sort(
      (a, b) => IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) || b.steps - a.steps,
    ),
  };
}
