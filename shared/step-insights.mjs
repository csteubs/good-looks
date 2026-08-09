// What the step rows MEAN, separately from how they are fetched.
//
// Pure (see the admission rule in run-pacing.mjs). `metrics-query.mjs` returns
// rows; this turns rows into the two findings §6.2 and §6.3 of the plan are
// actually about — "this step got slower" and "this step disagrees across
// engines". Kept out of metrics-query because that file has one job and one
// rule (no SQL escapes it), and kept out of both callers because the app's
// panel and the MCP's tool must not be able to disagree about what "diverges"
// means — which is the same reason the flake analysis moved to shared/.

/**
 * Group a step × engine matrix into one row per step, with a verdict.
 *
 * The verdicts intentionally match `shared/triage.mjs`'s cross-run signals,
 * because they are the same question asked of a whole history rather than one
 * run, and two vocabularies for it would be two things to keep in sync:
 *
 *   • `single-engine` — fails on exactly one engine while at least one other
 *     passes cleanly. The actionable one: an engine-specific selector or race,
 *     and a different bug report from the one below.
 *   • `all-engines` — every engine that ran it has seen it fail. Look at the
 *     site, not the test.
 *   • `mixed` — fails on more than one engine but not all. Rarer, and named
 *     rather than folded into `all-engines`, which would overstate it.
 *   • `clean` — no engine has seen it fail.
 *   • `insufficient` — only one engine has ever run it, so nothing can be said.
 *     This is the majority case on a young history and must not read as
 *     `clean`: "never failed anywhere" and "only ever tried in one place" are
 *     different facts, and only the first is reassuring.
 */
export function divergentSteps(rows) {
  const byStep = new Map();
  for (const r of rows) {
    const key = `${r.testId}::${r.stepId}`;
    const g = byStep.get(key) ?? {
      stepId: r.stepId,
      testId: r.testId,
      testName: r.testName,
      label: r.label,
      browsers: [],
    };
    // `label` is MAX()'d per (step, browser) by the query, so any row's is as
    // good as another's — but prefer a non-null one, since a step recorded
    // before labels existed would otherwise blank a row that has one.
    if (!g.label && r.label) g.label = r.label;
    g.browsers.push({ browser: r.browser, runs: r.runs, failed: r.failed });
    byStep.set(key, g);
  }

  return [...byStep.values()]
    .map((g) => {
      const browsers = g.browsers.slice().sort((a, b) => a.browser.localeCompare(b.browser));
      const failing = browsers.filter((b) => b.failed > 0);
      const clean = browsers.filter((b) => b.failed === 0);
      let verdict;
      if (browsers.length < 2) verdict = "insufficient";
      else if (failing.length === 0) verdict = "clean";
      else if (clean.length === 0) verdict = "all-engines";
      else if (failing.length === 1) verdict = "single-engine";
      else verdict = "mixed";
      return {
        ...g,
        browsers,
        verdict,
        failingBrowsers: failing.map((b) => b.browser),
        passingBrowsers: clean.map((b) => b.browser),
      };
    })
    // Divergence first — a step that behaves differently on one engine is the
    // whole point of the view, and it must not sort below a hundred clean rows.
    .sort((a, b) => rank(a.verdict) - rank(b.verdict) || String(a.testName).localeCompare(String(b.testName)));
}

function rank(verdict) {
  switch (verdict) {
    case "single-engine":
      return 0;
    case "mixed":
      return 1;
    case "all-engines":
      return 2;
    case "clean":
      return 3;
    default:
      return 4;
  }
}

/** Below this many timed runs in a window, a median is one or two numbers and a
 *  "got 3× slower" drawn from it is noise with a decimal point on it. */
export const MIN_SAMPLES_FOR_TREND = 3;

/** How much slower before it is worth reporting. Deliberately coarse: step
 *  durations on a real site move 20% run to run without anything changing. */
export const SLOWDOWN_RATIO = 1.5;

/**
 * Steps that got meaningfully slower, worst first.
 *
 * Requires BOTH windows to have real samples. The tempting version — report
 * anything whose recent median exceeds some absolute threshold — answers a
 * different question ("what is slow") and is already answerable by sorting the
 * table. This one answers "what CHANGED", which is the one nobody can get from
 * the existing views.
 */
export function slowdowns(rows, { ratio = SLOWDOWN_RATIO, minSamples = MIN_SAMPLES_FOR_TREND } = {}) {
  return rows
    .filter(
      (r) =>
        r.changeRatio !== null &&
        r.changeRatio >= ratio &&
        r.recentRuns >= minSamples &&
        r.previousRuns >= minSamples,
    )
    .sort((a, b) => b.changeRatio - a.changeRatio);
}

/**
 * Split a suite's wall-clock into the parts the user chose and the rest.
 *
 * The point of §6.2, and the reason it is worth stating as a share rather than
 * a total: "your suite takes 5 minutes" invites nothing, while "3m20s of your
 * 5m suite is capture, accessibility and the Slow speed you picked" names three
 * switches. `capture_ms` and `a11y_ms` are measured, not estimated.
 *
 * `instrumentedMs` deliberately excludes the speed setting. Slow-motion delay
 * is derivable per run, but it is spread across steps rather than recorded as a
 * total, so attributing it here would mean inventing a number and presenting it
 * beside two that were measured. The per-speed totals are returned alongside so
 * the view can show the same thing honestly: which speeds the time went to.
 */
export function costBreakdown(cost) {
  const total = cost.totalMs || 0;
  const instrumentedMs = (cost.captureMs || 0) + (cost.a11yMs || 0);
  return {
    ...cost,
    instrumentedMs,
    otherMs: Math.max(0, total - instrumentedMs),
    instrumentedShare: total > 0 ? instrumentedMs / total : 0,
  };
}
