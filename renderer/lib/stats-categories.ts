// The Stats category registry, and the arithmetic behind each tile.
//
// docs/plans/stats-categories.md — the board this feeds is the plan's §3, and
// the four states below are its §4, which is the part of it I would not trade.
//
// WHY THIS IS PURE, AND HERE. `renderer/lib/**/*.test.ts` runs in Vitest's NODE
// project, so everything below is unit-testable with no React, no jsdom and no
// query layer. That matters more than usual for this file: the failure it
// exists to prevent is a WRONG NUMBER, not a broken render, and a wrong number
// is exactly what a component test is worst at noticing.
//
// THE RULE THE WHOLE FILE IS BUILT AROUND: "found nothing" and "measured
// nothing" must never produce the same tile. This codebase already says so —
// `a11y-panel.tsx` opens with it, and every `metrics:*` response carries an
// `available` flag for the same reason. A category rendering `0` when the truth
// is "you have never switched this on" is a confident, wrong all-clear, and it
// is the worst thing this feature can produce. So `value` is `null` in both
// non-measured states and the callers have nothing to print.
//
// SECOND RULE: CATEGORIES ARE NOT COMMENSURABLE. Fourteen unaccepted
// accessibility steps, three flaky tests and nine healed locators are different
// units. Nothing here adds, averages or scores across categories — `bandReading`
// counts CATEGORIES IN A STATE and never touches their values. `check:stats-categories`
// enforces that, because the band is the easiest place in the design to grow a
// "health score" and a score across incommensurable units is a lie that looks
// like information.

import type { ToneName } from "../theme";
import { countA11ySteps } from "./a11y-format";
import type {
  FlakeReport,
  HealListEntry,
  RunRecord,
  RunReplaySummary,
  RunTotals,
} from "./recorder-types";
import { selectLatestA11yRuns } from "../../shared/a11y-rollup.mjs";
import { aiDebugFinding, type AiDebugReport } from "./ai-debug-stats";
import type { StepDurationRow, StepHealthRow } from "../../shared/metrics-query.mjs";
import type { CostBreakdown } from "../../shared/step-insights.mjs";

// ── The registry ──────────────────────────────────────────────────────

export type CategoryId =
  | "outcomes"
  | "stability"
  | "heals"
  | "a11y"
  | "visual"
  | "speed"
  | "steps"
  | "ai-debug";

export interface CategoryMeta {
  id: CategoryId;
  /** Full name, for the breadcrumb and the dashboard heading. */
  label: string;
  /** Tile label. Mono uppercase at 9.5px is wide, so this is the short one. */
  short: string;
  /** What the headline number counts, in the user's words. */
  unit: string;
  /**
   * What the tile says when this has NEVER been measured.
   *
   * REQUIRED, and `check:stats-categories` proves every entry has one. A
   * category that cannot say "not checked yet" will end up saying `0` instead,
   * which is the exact bug the four states exist to prevent — so the type makes
   * it impossible to add a category without answering the question.
   */
  unmeasured: string;
}

/**
 * The eight, in the order the board draws them.
 *
 * ORDERED BY HOW OFTEN THEY HAVE SOMETHING TO SAY, not alphabetically and not
 * by importance. Outcomes is first because it is the only one that says
 * something after a single run; Step health is near the end because it is the
 * one most often unavailable (it needs the metrics DB), and AI Debug is last
 * because it is the only one that stays silent until the user opts into a
 * feature that costs a model call.
 */
export const CATEGORIES: readonly CategoryMeta[] = [
  {
    id: "outcomes",
    label: "Outcomes",
    short: "Outcomes",
    unit: "pass rate",
    unmeasured: "Run a test and its result appears here.",
  },
  {
    id: "stability",
    label: "Stability",
    short: "Stability",
    unit: "tests change their mind between runs",
    unmeasured: "Not enough runs yet to tell a flake from a coincidence.",
  },
  {
    id: "heals",
    label: "Auto-Heal",
    short: "Auto-Heal",
    unit: "locator substitutions waiting on a decision",
    unmeasured: "Nothing has run yet, so nothing has needed healing.",
  },
  {
    id: "a11y",
    label: "Accessibility",
    short: "A11y",
    unit: "steps carry violations you haven’t accepted",
    unmeasured: "Switch on “Check accessibility” beside Run test, then run a test.",
  },
  {
    id: "visual",
    label: "Visual diff",
    short: "Visual",
    unit: "steps changed against their baseline",
    unmeasured: "Switch on “Capture screenshots” beside Run test, then run a test.",
  },
  {
    id: "speed",
    label: "Speed & cost",
    short: "Speed",
    unit: "steps got slower",
    unmeasured: "No step has two windows of timings to compare yet.",
  },
  {
    id: "steps",
    label: "Step health",
    short: "Steps",
    unit: "steps are failing, healing or throwing",
    unmeasured: "No steps recorded yet. Run a test and history accumulates here.",
  },
  {
    // THE ONE TILE WHOSE HEADLINE IS A VOLUME RATHER THAN A FINDING. Every
    // other category counts things that are wrong; this one counts diagnoses
    // asked for, because "how much have I leaned on this" is the question
    // people actually arrive with. What makes it amber is separate and lives in
    // `aiDebugFinding` — an ordered list of conditions rather than a boolean,
    // because the day tests start diagnosing themselves this tile becomes the
    // supervision surface and grows a third condition.
    id: "ai-debug",
    label: "AI Debug",
    short: "AI Debug",
    unit: "diagnoses asked for",
    unmeasured: "Press “Debug with AI” on a failed run and what it costs and saves is tracked here.",
  },
] as const;

/**
 * What a FACET is called, per category.
 *
 * Facet ids are internal vocabulary — `changed-since`, `still-failing` — and
 * they reach the URL, which means they reach the breadcrumb. A trail reading
 * "Stats / Stability / CHANGED-SINCE" is an implementation detail on screen;
 * this is the table that stops that.
 *
 * THE STABILITY LABELS ARE ALSO IN `VERDICT_COPY`, which is the Stability
 * panel's chip text, and two copies of a user-facing word are exactly the drift
 * this repo keeps getting bitten by. They cannot simply be shared: `VERDICT_COPY`
 * lives in a `.tsx` beside the component that renders it, and this module is
 * imported by the node test project and by a source-level check, neither of
 * which can load React. So the copies stay and
 * `check:stats-categories` compares them string-for-string instead — the same
 * answer `check:flake-analysis` gives for the renderer's mirror of the analysis.
 */
export const FACET_LABELS: Partial<Record<CategoryId, Record<string, string>>> = {
  outcomes: {
    failed: "Failed runs",
    passed: "Passed runs",
  },
  stability: {
    "still-failing": "Consistently failing",
    "changed-since": "Broke recently",
    flaky: "Flaky",
    "data-dependent": "Data-dependent",
    "browser-dependent": "Engine-dependent",
    fixed: "Fixed",
    stable: "Stable",
    unknown: "Too few runs",
  },
  heals: {
    pending: "Waiting on you",
    accepted: "Accepted",
    reverted: "Reverted",
  },
  // axe's own severity words, and deliberately not softened. "Critical" is what
  // the rule that produced it is called everywhere else — in the Visual view's
  // badges, in `IMPACT_ORDER`, and in axe's own documentation the user will
  // reach for next.
  a11y: {
    critical: "Critical",
    serious: "Serious",
    moderate: "Moderate",
    minor: "Minor",
  },
  visual: {
    changed: "Changed against baseline",
    clean: "Matching baseline",
  },
  speed: {
    slower: "Steps that got slower",
  },
  steps: {
    failing: "Failing",
    healing: "Healing",
    throwing: "Throwing page errors",
  },
  // The four ways an attempt ends, plus the two drills that are about what came
  // out of them rather than how they finished.
  "ai-debug": {
    done: "Answered",
    error: "Failed",
    cancelled: "Stopped by you",
    interrupted: "Interrupted",
    fixes: "Fixes applied",
    // "Tests debugged" and not "Most debugged tests": it is a row label in a
    // column sized for the four outcome names above it, and the longer phrase
    // was the only one on the screen that wrapped to two lines.
    tests: "Tests debugged",
  },
};

/** The facet's name, or the raw id when there is nothing better — a URL can
 *  carry anything, and showing what was actually asked for beats inventing a
 *  label for a facet that does not exist. */
export function facetLabel(category: string, facet: string): string {
  return FACET_LABELS[category as CategoryId]?.[facet] ?? facet;
}

export function categoryMeta(id: string): CategoryMeta | null {
  return CATEGORIES.find((c) => c.id === id) ?? null;
}

/** Is this string one of the seven? Route params are strings from history, and
 *  an unknown one must render an explained empty state rather than crash. */
export function isCategoryId(id: string): id is CategoryId {
  return CATEGORIES.some((c) => c.id === id);
}

// ── The four states ───────────────────────────────────────────────────

/**
 * `clean` and `findings` are both MEASURED and carry a number.
 * `unmeasured` and `unavailable` carry none, and they are different facts:
 * one is "you have not switched this on", the other is "the mechanism cannot
 * report on this machine". Only the first is the user's to fix.
 */
export type CategoryState = "clean" | "findings" | "unmeasured" | "unavailable";

export interface CategorySummary {
  id: CategoryId;
  state: CategoryState;
  /** The headline, already formatted. **Null in both non-measured states**, so
   *  a caller literally has no number to print. */
  display: string | null;
  /** The claim, one clause. Always present — an unmeasured tile still says
   *  what to do about it. */
  say: string;
  /** How much was looked at. Null when nothing was. */
  window: string | null;
  /** What the number reports. Null when it is not reporting an outcome — which
   *  is every state except `findings`, plus `clean` (which is phosphor). */
  tone: ToneName | null;
}

/** True only for the two states that carry a number. Exported because three
 *  call sites ask it and "did it measure?" is easy to get subtly wrong. */
export function isMeasured(state: CategoryState): boolean {
  return state === "clean" || state === "findings";
}

function measured(
  id: CategoryId,
  count: number,
  display: string,
  say: string,
  window: string,
  tone: ToneName,
): CategorySummary {
  return {
    id,
    state: count > 0 ? "findings" : "clean",
    display,
    say,
    window,
    tone: count > 0 ? tone : "phos",
  };
}

function unmeasured(id: CategoryId): CategorySummary {
  const meta = categoryMeta(id)!;
  // No display, deliberately. See the file header.
  return { id, state: "unmeasured", display: null, say: meta.unmeasured, window: null, tone: null };
}

function unavailable(id: CategoryId, why: string): CategorySummary {
  return { id, state: "unavailable", display: null, say: why, window: null, tone: null };
}

/** Exported so a dashboard says exactly what its tile said. Two phrasings of
 *  "this machine cannot report that" read as two different problems. */
export const METRICS_UNAVAILABLE =
  "Metrics aren’t available on this runtime, so nothing can be reported here. " +
  "Everything else on this page still works.";

// ── Inputs ────────────────────────────────────────────────────────────

/**
 * Everything the board needs, all of it already fetched by the Stats page.
 *
 * `undefined` means "that query has not resolved", which is NOT the same as any
 * of the four states — a tile with an unresolved query is loading, and calling
 * it `unmeasured` would flash "you have never switched this on" at someone who
 * switched it on last week.
 */
export interface CategoryInputs {
  runs?: RunRecord[];
  /** Lifetime run counts. Its own query, and its own field, because it answers
   *  what `runs` cannot: that list is capped, so its length stops growing while
   *  the suite keeps running. */
  runTotals?: RunTotals;
  flake?: FlakeReport;
  heals?: HealListEntry[];
  replays?: RunReplaySummary[];
  stepHealth?: { available: boolean; rows: StepHealthRow[] };
  slowness?: {
    available: boolean;
    cost: CostBreakdown;
    rows: StepDurationRow[];
    slowed: StepDurationRow[];
  };
  /** The AI Debug report, already built by `buildAiDebugReport`. Passed whole
   *  rather than as its three sources, because the tile and the dashboard must
   *  be looking at the same arithmetic — the same rule `latestA11yRuns` exists
   *  for, one category over. */
  aiDebug?: AiDebugReport;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** Runs that were executions. Baseline updates are events, not runs, and they
 *  carry an incidental `status` that would corrupt every rate below. */
function realRuns(runs: RunRecord[]): RunRecord[] {
  return runs.filter((r) => r.kind !== "baseline-update");
}

/**
 * The most recent run of each test that actually DID the thing.
 *
 * Used by the a11y and visual tiles, and it is the same rule `a11y-panel.tsx`
 * follows per test: describe the latest run that CHECKED, not the latest run.
 * Otherwise a later run with the toggle off blanks results that are still true,
 * and the tile drops from "14 steps" to "clean" because someone ran one test
 * without screenshots.
 */
function latestPerTest<T extends { testId: string; startedAt: number }>(
  rows: T[],
  did: (row: T) => boolean,
): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    if (!did(row)) continue;
    const prev = best.get(row.testId);
    if (!prev || row.startedAt > prev.startedAt) best.set(row.testId, row);
  }
  return [...best.values()];
}

/**
 * THE RUN SELECTIONS THE TILES AND THEIR DASHBOARDS SHARE.
 *
 * Exported rather than left private because a dashboard that picks its own runs
 * will eventually pick different ones, and the symptom is a tile reading "14
 * steps" over a screen that lists nine — the same suite, two answers, no error
 * anywhere. The tile and the dashboard call the same function instead.
 */
export function latestA11yRuns(runs: RunRecord[]): RunRecord[] {
  // Delegated to `shared/`, because the a11y DASHBOARD is rolled up in the main
  // process from replay files on disk while this tile counts from the run list
  // in a query cache. Two processes, one question — and a divergence would show
  // up as a tile and the screen under it disagreeing about the same suite.
  return selectLatestA11yRuns(realRuns(runs));
}

/** Every test's most recent captured run. A capture is a capture — there is no
 *  "did it actually do the thing" question here, unlike a11y above, because a
 *  replay only exists when screenshots were taken. */
export function latestCaptures(replays: RunReplaySummary[]): RunReplaySummary[] {
  return latestPerTest(replays, () => true);
}

// ── One summary per category ──────────────────────────────────────────

/**
 * @param totals Lifetime counts, when they have loaded. The run list is CAPPED,
 *  so counting it answers "how are the runs we still have on disk doing" — a
 *  narrower question than the one this tile asks, and one that quietly stops
 *  moving once the cap is reached. Optional rather than required because it
 *  arrives on its own query: until it does, the retained window is the best
 *  available answer and a tile that waited for it would render as "never run".
 */
export function summariseOutcomes(runs: RunRecord[], totals?: RunTotals): CategorySummary {
  const real = realRuns(runs);
  if (real.length === 0 && (totals?.runs ?? 0) === 0) return unmeasured("outcomes");
  const count = totals?.runs ?? real.length;
  const passed = totals?.passed ?? real.filter((r) => r.status === "passed").length;
  const failed = count - passed;
  const rate = count > 0 ? Math.round((passed / count) * 100) : 0;
  return {
    id: "outcomes",
    state: failed > 0 ? "findings" : "clean",
    display: `${rate}%`,
    say:
      failed > 0 ? `${failed} ${plural(failed, "run")} failed of ${count}` : `every run passed`,
    window: `${count} ${plural(count, "run")}`,
    // The rate is the number, so the tone reads the RATE rather than the count
    // of failures: one failure in four hundred is not the same news as one in
    // four, and a tone driven by the count cannot tell them apart.
    tone: failed === 0 ? "phos" : rate < 80 ? "red" : "amber",
  };
}

export function summariseStability(flake: FlakeReport): CategorySummary {
  // The Stability panel's own rule, kept rather than re-derived: a verdict from
  // too few runs is noise wearing a statistic's clothes.
  if (flake.analysedTests === 0) return unmeasured("stability");
  const unsettled = flake.tests.filter(
    (t) => t.verdict !== "stable" && t.verdict !== "unknown",
  );
  const broken = unsettled.some(
    (t) => t.verdict === "still-failing" || t.verdict === "changed-since",
  );
  const capped = flake.windowRuns >= flake.windowCap ? ` (capped at ${flake.windowCap})` : "";
  return {
    ...measured(
      "stability",
      unsettled.length,
      String(unsettled.length),
      unsettled.length > 0
        ? `${unsettled.length} ${plural(unsettled.length, "test")} ${plural(unsettled.length, "is not", "are not")} settled`
        : "every test with enough runs is passing consistently",
      `${flake.analysedTests} ${plural(flake.analysedTests, "test")} over ${flake.windowRuns} ${plural(flake.windowRuns, "run")}${capped}`,
      "amber",
    ),
    // A regression and a flake are both "unsettled", and they are not the same
    // news — red when something broke and stayed broken.
    tone: unsettled.length === 0 ? "phos" : broken ? "red" : "amber",
  };
}

export function summariseHeals(heals: HealListEntry[], runs: RunRecord[]): CategorySummary {
  if (realRuns(runs).length === 0) return unmeasured("heals");
  const pending = heals.filter((h) => h.status === "pending");
  return measured(
    "heals",
    pending.length,
    String(pending.length),
    pending.length > 0
      ? `${pending.length} ${plural(pending.length, "substitution")} waiting on a decision`
      : "nothing is waiting on a decision",
    `${heals.length} ${plural(heals.length, "heal")} recorded`,
    "amber",
  );
}

export function summariseA11y(runs: RunRecord[]): CategorySummary {
  // Measured means a run actually COMPLETED checks. A run with the toggle on
  // that completed none is a fault, not a clean result — `a11y-panel.tsx`
  // reports it as one — so it must not count as having measured anything.
  const checked = latestA11yRuns(runs);
  if (checked.length === 0) return unmeasured("a11y");
  const steps = checked.reduce((n, r) => n + (r.a11yNewSteps ?? 0), 0);
  return measured(
    "a11y",
    steps,
    String(steps),
    steps > 0
      ? `${steps} ${plural(steps, "step")} ${plural(steps, "carries", "carry")} violations you haven’t accepted`
      : "no unaccepted violations",
    `${checked.length} ${plural(checked.length, "test")} checked`,
    // Never red. Accessibility findings are REPORTED, never enforced — they do
    // not decide whether a test passes, and a red tile beside a red Outcomes
    // tile would claim they do.
    "amber",
  );
}

export function summariseVisual(replays: RunReplaySummary[]): CategorySummary {
  const captured = latestCaptures(replays);
  if (captured.length === 0) return unmeasured("visual");
  const changed = captured.reduce((n, r) => n + r.changedSteps, 0);
  return measured(
    "visual",
    changed,
    String(changed),
    changed > 0
      ? `${changed} ${plural(changed, "step")} changed against ${plural(changed, "its", "their")} baseline`
      : "nothing changed against its baseline",
    `${captured.length} ${plural(captured.length, "test")} captured`,
    "amber",
  );
}

export function summariseSpeed(slowness: NonNullable<CategoryInputs["slowness"]>): CategorySummary {
  if (!slowness.available) return unavailable("speed", METRICS_UNAVAILABLE);
  if (slowness.cost.runs === 0) return unmeasured("speed");
  const n = slowness.slowed.length;
  const share = Math.round(slowness.cost.instrumentedShare * 100);
  return measured(
    "speed",
    n,
    String(n),
    n > 0
      ? `${n} ${plural(n, "step")} got slower`
      : "no step’s median has moved enough to report",
    `${slowness.cost.runs} ${plural(slowness.cost.runs, "run")} · ${share}% instrumentation`,
    "amber",
  );
}

/**
 * The AI Debug tile.
 *
 * ITS HEADLINE IS A VOLUME AND ITS TONE IS A FINDING, and those are two
 * different questions on purpose. "How many diagnoses have I asked for" is what
 * a reader arrives with; whether anything needs attention is answered by
 * `aiDebugFinding`, which is an ordered list of conditions rather than a count
 * of anything on screen. That split is what lets the tile stay green while
 * showing a large number — which is the normal, healthy case — and go amber
 * over changes to the user's tests that nobody has read.
 */
export function summariseAiDebug(report: AiDebugReport): CategorySummary {
  if (report.attempts === 0) return unmeasured("ai-debug");
  const finding = aiDebugFinding(report);
  const answered = report.outcomes.done;
  return {
    id: "ai-debug",
    state: finding ? "findings" : "clean",
    display: String(report.attempts),
    say:
      finding?.say ??
      `${answered} of ${report.attempts} ${plural(report.attempts, "attempt")} produced an answer`,
    window: `${report.fixes.applied} ${plural(report.fixes.applied, "fix", "fixes")} applied`,
    // Amber, never red, and for the reason the a11y tile is never red: nothing
    // here decides whether a test passes. An unreviewed fix is a decision
    // waiting on the user, not a broken suite.
    tone: finding ? "amber" : "phos",
  };
}

export function summariseSteps(
  stepHealth: NonNullable<CategoryInputs["stepHealth"]>,
): CategorySummary {
  if (!stepHealth.available) return unavailable("steps", METRICS_UNAVAILABLE);
  if (stepHealth.rows.length === 0) return unmeasured("steps");
  const hot = stepHealth.rows.filter((r) => r.failed > 0 || r.heals > 0 || r.pageErrors > 0);
  return measured(
    "steps",
    hot.length,
    String(hot.length),
    hot.length > 0
      ? `${hot.length} ${plural(hot.length, "step")} ${plural(hot.length, "is", "are")} failing, healing or throwing`
      : "no step is failing, healing or throwing",
    `${stepHealth.rows.length} ${plural(stepHealth.rows.length, "step")} tracked`,
    "amber",
  );
}

/**
 * Every category that has an answer yet, in registry order.
 *
 * A category whose query has not resolved is OMITTED rather than given a state.
 * The board renders it as loading; inventing `unmeasured` for it would flash
 * "you have never switched this on" at someone who switched it on last week,
 * which is the file's own rule breaking on a technicality.
 */
export function summariseAll(inputs: CategoryInputs): CategorySummary[] {
  const out: CategorySummary[] = [];
  for (const meta of CATEGORIES) {
    switch (meta.id) {
      case "outcomes":
        if (inputs.runs) out.push(summariseOutcomes(inputs.runs, inputs.runTotals));
        break;
      case "stability":
        if (inputs.flake) out.push(summariseStability(inputs.flake));
        break;
      case "heals":
        if (inputs.heals && inputs.runs) out.push(summariseHeals(inputs.heals, inputs.runs));
        break;
      case "a11y":
        if (inputs.runs) out.push(summariseA11y(inputs.runs));
        break;
      case "visual":
        if (inputs.replays) out.push(summariseVisual(inputs.replays));
        break;
      case "speed":
        if (inputs.slowness) out.push(summariseSpeed(inputs.slowness));
        break;
      case "steps":
        if (inputs.stepHealth) out.push(summariseSteps(inputs.stepHealth));
        break;
      case "ai-debug":
        if (inputs.aiDebug) out.push(summariseAiDebug(inputs.aiDebug));
        break;
    }
  }
  return out;
}

// ── The band ──────────────────────────────────────────────────────────

export interface BandReading {
  needAttention: number;
  clean: number;
  unmeasured: number;
  unavailable: number;
  sentence: string;
  tone: ToneName | null;
}

/**
 * The board's one-sentence summary.
 *
 * IT COUNTS CATEGORIES IN A STATE. IT NEVER TOUCHES THEIR VALUES. That is the
 * condition the verdict-band treatment ships under, and it is not a style
 * preference: adding fourteen accessibility steps to three flaky tests produces
 * a number that means nothing, and a band is the most natural place in the
 * whole design for someone to later introduce one. `check:stats-categories`
 * proves no cross-category arithmetic exists under `renderer/main/stats/`.
 *
 * "Never measured" is counted SEPARATELY and never folded into "clean" — the
 * four-state rule restated at page level, and the reason this says up to three
 * things rather than two.
 */
export function bandReading(summaries: CategorySummary[]): BandReading {
  const needAttention = summaries.filter((s) => s.state === "findings").length;
  const clean = summaries.filter((s) => s.state === "clean").length;
  const notMeasured = summaries.filter((s) => s.state === "unmeasured").length;
  const noMechanism = summaries.filter((s) => s.state === "unavailable").length;

  const parts: string[] = [];
  if (needAttention > 0) {
    parts.push(
      `${needAttention} ${plural(needAttention, "category", "categories")} ${plural(needAttention, "needs", "need")} attention`,
    );
  }
  if (clean > 0) parts.push(`${clean} ${plural(clean, "is", "are")} clean`);
  if (notMeasured > 0) {
    parts.push(`${notMeasured} ${plural(notMeasured, "has", "have")} never been measured`);
  }
  if (noMechanism > 0) {
    parts.push(`${noMechanism} cannot be reported on this machine`);
  }

  let sentence: string;
  if (parts.length === 0) sentence = "Nothing has been measured yet.";
  else if (parts.length === 1) sentence = `${parts[0]}.`;
  else sentence = `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}.`;

  return {
    needAttention,
    clean,
    unmeasured: notMeasured,
    unavailable: noMechanism,
    sentence,
    // The band's own tone reports whether anything needs attention — a fact
    // about the BOARD, not a score across it.
    tone: needAttention > 0 ? "amber" : clean > 0 ? "phos" : null,
  };
}

/** Re-exported so the a11y dashboard and this module cannot disagree about
 *  what "a step with unaccepted violations" means. */
export { countA11ySteps };
