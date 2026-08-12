// What this suite costs, and what it is worth. REDESIGN §6.4.
//
// PURE, AND EVERY NUMBER IT RETURNS IS DERIVED FROM TWO STATED ASSUMPTIONS AND
// THE RUN HISTORY. That is the whole design constraint, and the plan says why:
// "a number nobody can check is a number nobody believes". So there are exactly
// two assumptions, they are named, and they carry their units.
//
// WHERE THEY ARE SET MOVED, AND WHAT THEY MUST STILL DO DID NOT. They now live
// in Settings → Cost and persist (`shared/cost-units.mjs` holds the bounds and
// the published runner prices); the panel still states both in prose directly
// under the figures they produce, so a reader can still check the derivation
// without going anywhere. Editing them in place and losing them on reload was
// the earlier design, and its flaw was practical rather than theoretical: an
// assumption you have to retype on every visit is one nobody sets twice, so
// the panel was read at the shipped guess — the exact outcome the design was
// meant to prevent.
//
// WHAT IT REFUSES TO DO IS THE INTERESTING PART.
//
// It does not convert saved time into money. That needs a third assumption — an
// hourly rate for whoever would have done the testing — and it is the one this
// app has no business guessing: it varies by an order of magnitude between
// users, nobody would notice a bad default, and a dollar figure carries far
// more authority than the guess behind it deserves. So spend is money (a CI
// minute has a price), value is TIME (hours of manual testing not done), and
// the ratio between them is stated in its own honest unit: hours avoided per
// dollar spent. A reader who wants a currency figure can multiply by their own
// rate, which is a calculation they can check.
//
// It does not call a caught failure a "regression". The plan's phrase is
// "regressions caught"; what the history actually supports is "failures", and
// whether a given one was a regression in the site, a broken test, or flake is
// exactly the question `triage` and the flake analysis exist to answer and
// still only answer probabilistically. Naming it what it is costs one word.

import type { RunRecord } from "./recorder-types";
import {
  clampCostPerCiMinute,
  clampMinutesPerManualRun,
  COST_DEFAULT_MINUTES_PER_MANUAL_RUN,
  COST_DEFAULT_PER_CI_MINUTE,
  currencySymbol,
} from "../../shared/cost-units.mjs";
import type { CostCurrency } from "../../shared/cost-units.mjs";

/**
 * The two assumptions, with the defaults the app ships.
 *
 * Both are deliberately conservative, because every headline number here scales
 * off them and a flattering default makes the whole panel a sales pitch.
 *
 * `costPerCiMinute` is GitHub Actions' published Linux rate at the time of
 * writing. It is the cheapest of the common tiers, so the spend figure is a
 * floor rather than a boast about savings.
 *
 * `minutesPerManualRun` is how long a person would take to click through one
 * test by hand. Twelve is a working figure for a multi-step flow with waits in
 * it; a smoke test is faster and a checkout is slower, which is precisely why
 * it is on screen and editable rather than buried.
 */
export interface CostAssumptions {
  /** Currency units per minute of CI. */
  costPerCiMinute: number;
  /** How long one run of one test would take a person, by hand. */
  minutesPerManualRun: number;
}

/** The shipped guesses, sourced from `shared/cost-units.mjs` — the same file the
 *  settings store validates against and the Settings pane writes through, so
 *  "the default" means one number rather than three that agree today. */
export const COST_DEFAULTS: CostAssumptions = {
  costPerCiMinute: COST_DEFAULT_PER_CI_MINUTE,
  minutesPerManualRun: COST_DEFAULT_MINUTES_PER_MANUAL_RUN,
};

/** Read the assumptions out of persisted settings, falling back to the shipped
 *  guesses for anything absent.
 *
 *  Both fields are clamped ON THE WAY OUT as well as on the way in. The store
 *  clamps what it writes, but a settings object also reaches the panel straight
 *  off an IPC response before any write has happened, and a `0.008` that
 *  arrived as `null` from a partially-loaded query would render a confident
 *  "$0.00 spent" — a wrong answer that looks exactly like a right one. */
export function assumptionsFromSettings(
  settings: Partial<{ costPerCiMinute: number; costMinutesPerManualRun: number }>,
): CostAssumptions {
  return {
    costPerCiMinute: clampCostPerCiMinute(settings.costPerCiMinute),
    minutesPerManualRun: clampMinutesPerManualRun(settings.costMinutesPerManualRun),
  };
}

/** One test's line in the spend table. */
export interface TestCost {
  testId: string;
  testName: string;
  runs: number;
  failures: number;
  /** Runs whose failure the history suggests was flake — see `flakeRuns`. */
  flakeRuns: number;
  ciMinutes: number;
  spend: number;
  /** Hours of manual testing this test's PASSED runs stand in for. A failed run
   *  buys nothing: the flow was not verified end to end. */
  manualHoursAvoided: number;
  verdict: TestVerdict;
}

/**
 * Earning its keep, or worth a look.
 *
 * TWO VERDICTS AND NOT THREE. A middle band would be the one every row lands
 * in, and a table where nothing is called out is a table nobody reads twice.
 * `review` is deliberately the minority verdict.
 */
export type TestVerdict = "earning" | "review";

/** Why a row was called out. Null for `earning` rows — a verdict with no
 *  reason is an assertion, and this table's whole job is to be checkable. */
export type ReviewReason = "flaky" | "never-caught" | null;

export interface CostSummary {
  assumptions: CostAssumptions;
  runs: number;
  ciMinutes: number;
  spend: number;
  manualHoursAvoided: number;
  /** Hours of manual testing avoided per unit of currency spent. Null when
   *  nothing has been spent — a ratio over zero is not "infinite value", it is
   *  no measurement. */
  hoursPerUnitSpent: number | null;
  failures: number;
  /** Failures the history suggests were flake, and what they cost. */
  flakeRuns: number;
  flakeMinutes: number;
  flakeSpend: number;
  byTest: TestCost[];
}

const MS_PER_MINUTE = 60_000;

/** This machine's real runs, oldest first. Same filter as everywhere else:
 *  `baseline-update` rows are audit events rather than executions, and a
 *  tombstoned run's test is gone so it cannot be named in a table. */
function realRuns(runs: readonly RunRecord[]): RunRecord[] {
  return runs
    .filter((r) => (r.kind ?? "run") === "run" && !r.testDeleted)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Which of a test's failed runs the history suggests were FLAKE.
 *
 * The rule is §6.1's, reused rather than re-derived: a failure directly
 * followed by a pass, with none of the run settings this app records having
 * changed in between, is a failure nobody fixed — same engine, same pacing,
 * same budget, opposite outcome. That is the definition already on screen in
 * the retry panel, and having two definitions of flake in one app is how the
 * two surfaces end up disagreeing in front of a user.
 *
 * It is a SUGGESTION and the panel says so. A real fix committed between the
 * two runs looks identical from here — this app does not watch the repository.
 */
export function flakeRuns(runsForOneTest: readonly RunRecord[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < runsForOneTest.length - 1; i++) {
    const a = runsForOneTest[i];
    const b = runsForOneTest[i + 1];
    if (a.status !== "failed" || b.status !== "passed") continue;
    if (sameSettings(a, b)) out.add(a.id);
  }
  return out;
}

/** Did anything this app records about HOW a run executed differ? */
function sameSettings(a: RunRecord, b: RunRecord): boolean {
  return (
    (a.runBrowser ?? "chromium") === (b.runBrowser ?? "chromium") &&
    Boolean(a.runHeadless) === Boolean(b.runHeadless) &&
    a.speed === b.speed &&
    Boolean(a.captureArtifacts) === Boolean(b.captureArtifacts) &&
    (a.datasetName ?? null) === (b.datasetName ?? null)
  );
}

/** Why this row is worth a look, or null if it is not.
 *
 *  ORDER MATTERS: a test that is both flaky and has never caught anything is
 *  reported as flaky, because that is the fixable half. */
export function reviewReason(row: {
  runs: number;
  failures: number;
  flakeRuns: number;
}): ReviewReason {
  // A third or more of its failures being flake, with at least two of them —
  // one flaky failure is an anecdote, and a ratio over a single sample is not
  // a ratio.
  if (row.flakeRuns >= 2 && row.flakeRuns / Math.max(1, row.failures) >= 0.33) return "flaky";
  // Run a lot and never failed. NOT a bug — a test that always passes may be
  // guarding something that never breaks — but it is the row worth asking
  // about, and nothing else in the app ever raises it.
  if (row.runs >= MIN_RUNS_FOR_NEVER_CAUGHT && row.failures === 0) return "never-caught";
  return null;
}

/** Below this, "never failed" says more about the sample than the test. */
export const MIN_RUNS_FOR_NEVER_CAUGHT = 10;

/**
 * The whole panel's numbers, from the run history and two stated assumptions.
 *
 * `spend` counts EVERY run, including failures — CI charges for those too, and
 * a cost figure that quietly excluded them would be the flattering kind.
 * `manualHoursAvoided` counts only PASSES, because a run that failed did not
 * verify the flow and stands in for nothing.
 */
export function computeCost(
  runs: readonly RunRecord[],
  assumptions: CostAssumptions,
): CostSummary {
  const real = realRuns(runs);

  const byId = new Map<string, RunRecord[]>();
  for (const r of real) byId.set(r.testId, [...(byId.get(r.testId) ?? []), r]);

  const byTest: TestCost[] = [];
  for (const [testId, list] of byId) {
    const flaky = flakeRuns(list);
    const ciMinutes = list.reduce((n, r) => n + r.durationMs, 0) / MS_PER_MINUTE;
    const passes = list.filter((r) => r.status === "passed").length;
    const failures = list.filter((r) => r.status === "failed").length;
    const row = {
      testId,
      // The newest record's name, because a rename leaves older rows carrying
      // the old one and a table that lists a test under two names reads as two
      // tests.
      testName: list[list.length - 1].testName,
      runs: list.length,
      failures,
      flakeRuns: flaky.size,
      ciMinutes,
      spend: ciMinutes * assumptions.costPerCiMinute,
      manualHoursAvoided: (passes * assumptions.minutesPerManualRun) / 60,
    };
    byTest.push({ ...row, verdict: reviewReason(row) === null ? "earning" : "review" });
  }

  // Most expensive first. The table exists to answer "where is the money
  // going", and sorting by name would bury that under alphabetical accident.
  byTest.sort((a, b) => b.spend - a.spend || a.testName.localeCompare(b.testName));

  const ciMinutes = byTest.reduce((n, t) => n + t.ciMinutes, 0);
  const spend = ciMinutes * assumptions.costPerCiMinute;
  const manualHoursAvoided = byTest.reduce((n, t) => n + t.manualHoursAvoided, 0);

  const flakeIds = new Set<string>();
  for (const list of byId.values()) for (const id of flakeRuns(list)) flakeIds.add(id);
  const flakeMinutes =
    real.filter((r) => flakeIds.has(r.id)).reduce((n, r) => n + r.durationMs, 0) / MS_PER_MINUTE;

  return {
    assumptions,
    runs: real.length,
    ciMinutes,
    spend,
    manualHoursAvoided,
    hoursPerUnitSpent: spend > 0 ? manualHoursAvoided / spend : null,
    failures: real.filter((r) => r.status === "failed").length,
    flakeRuns: flakeIds.size,
    flakeMinutes,
    flakeSpend: flakeMinutes * assumptions.costPerCiMinute,
    byTest,
  };
}

/**
 * Money, to the cent, in the currency the user picked.
 *
 * THIS USED TO REFUSE A SYMBOL, and the reasoning was sound at the time: the
 * rate was whatever the user typed, in whatever currency they thought in, and
 * the app was never told which — so a `$` would have been the app asserting
 * something it did not know. Settings → Cost is now where it gets told, which
 * removes the objection rather than overriding it. `"none"` is still on that
 * list and still lands here as `""`, so the original behaviour is a choice a
 * user can make rather than one the app makes for them.
 *
 * The symbol goes on the near side of the `<`: `<$0.01` is "less than a cent",
 * where `$<0.01` reads as a typo.
 */
export function formatSpend(n: number, currency: CostCurrency): string {
  const sym = currencySymbol(currency);
  if (n === 0) return `${sym}0.00`;
  if (n < 0.01) return `<${sym}0.01`;
  return `${sym}${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A RATE, not a total — the price of one CI minute, as the panel states it.
 *
 * Separate from `formatSpend` because two decimals destroy it: the shipped
 * 0.008 renders as `<$0.01` through that function, which turns the sentence
 * that exists to make the figures checkable into one that withholds the number.
 * So this keeps up to four decimals and drops trailing zeroes, and $0.062 and
 * $0.008 both read as themselves.
 */
export function formatRate(n: number, currency: CostCurrency): string {
  const sym = currencySymbol(currency);
  return `${sym}${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

/** Hours, at the precision the number deserves. Under ten hours a decimal is
 *  meaningful; past that it is noise on top of an assumption. */
export function formatHours(hours: number): string {
  if (hours === 0) return "0";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

/** Minutes, at the precision the number deserves.
 *
 *  ROUNDING TO WHOLE MINUTES MAKES THE COLUMN USELESS on a young history: a
 *  suite of ten-second tests renders as a column of zeroes, which reads as
 *  "this measured nothing" rather than "these are fast". Sub-ten gets a
 *  decimal; past that a decimal is noise. */
export function formatMinutes(minutes: number): string {
  if (minutes === 0) return "0";
  if (minutes < 0.05) return "<0.1";
  if (minutes < 10) return minutes.toFixed(1);
  return String(Math.round(minutes));
}
