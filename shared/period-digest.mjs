// "How was this period?" — the digest rule, over one window of run history.
//
// This began as `renderer/lib/weekly-digest.ts` (REDESIGN §6.5), which answers
// "how was this week?" at the top of Stats. The AI Insights report asks the
// same question over a day, a week or a month, from the MAIN process — and two
// spellings of "how was the period" is how the Stats panel and the report end
// up disagreeing about the same seven days. Same move as `a11y-rollup.mjs`:
// the rule comes here once, and both sides import it. The renderer's
// `weekly-digest.ts` is now a thin wrapper fixing the period to a week.
//
// `flakeRuns` travelled with it, because the digest's flake line REUSES §6.4's
// definition rather than adding a second — two definitions of flake in one app
// is how two surfaces disagree in front of a user. `cost-model.ts` re-exports
// it from here for its own callers.
//
// PURE, over runs the caller already has. `now` is passed in rather than read —
// a period boundary computed from a hidden clock is one no test can sit either
// side of. No fs, no process, no imports: the same rules the rest of shared/
// lives by.

const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

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
 * It is a SUGGESTION and the panels say so. A real fix committed between the
 * two runs looks identical from here — this app does not watch the repository.
 *
 * Wants ONE test's history, OLDEST FIRST: the rule is "failed and then
 * passed", found by a failure at `i` and a pass at `i + 1`. Sorted the other
 * way it silently finds nothing.
 *
 * @param {readonly import("./period-digest.mjs").DigestRun[]} runsForOneTest
 * @returns {Set<string>} ids of the failed runs that look like flake
 */
export function flakeRuns(runsForOneTest) {
  const out = new Set();
  for (let i = 0; i < runsForOneTest.length - 1; i++) {
    const a = runsForOneTest[i];
    const b = runsForOneTest[i + 1];
    if (a.status !== "failed" || b.status !== "passed") continue;
    if (sameSettings(a, b)) out.add(a.id);
  }
  return out;
}

/** Did anything this app records about HOW a run executed differ? */
function sameSettings(a, b) {
  return (
    (a.runBrowser ?? "chromium") === (b.runBrowser ?? "chromium") &&
    Boolean(a.runHeadless) === Boolean(b.runHeadless) &&
    a.speed === b.speed &&
    Boolean(a.captureArtifacts) === Boolean(b.captureArtifacts) &&
    (a.datasetName ?? null) === (b.datasetName ?? null)
  );
}

/**
 * A quiet period is not a good period, and the difference matters.
 *
 * With no runs at all the honest report is that nothing ran — NOT "0 failures"
 * or "100% passed", which are true statements about an empty set and read as
 * good news. This is the one reading the digest most has to get right, because
 * a suite nobody is running is the failure mode the whole app exists against.
 *
 * @param {readonly import("./period-digest.mjs").DigestRun[]} runs
 * @param {number} now
 * @param {{ periodMs?: number, periodLabel?: string,
 *           prunedDays?: readonly import("./period-digest.mjs").RunDayCount[] }} [opts]
 *  `periodMs` is the window length (default one week); `periodLabel` is the
 *  noun the sentences use ("week", "day", "month") so the copy stays
 *  grammatical at every cadence. `prunedDays` are runs the run index no longer
 *  holds, by local day: the index is CAPPED and pruning takes the OLDEST
 *  records, so a suite busy enough to fit a thousand runs inside a window
 *  loses that window's own runs to the cap. These counts carry no test
 *  identity, so they raise the run and failure COUNTS and cannot contribute
 *  an offender or a flake — the honest degradation, since neither can be
 *  recovered from a run whose record is gone.
 * @returns {import("./period-digest.mjs").PeriodDigest}
 */
export function periodDigest(runs, now, opts = {}) {
  const periodMs = opts.periodMs ?? WEEK_MS;
  const periodLabel = opts.periodLabel ?? "week";
  const prunedDays = opts.prunedDays ?? [];

  const periodStart = now - periodMs;
  const prevStart = periodStart - periodMs;

  // BASELINE UPDATES ARE NOT RUNS. They are recorded in the same history and
  // the Stats header already separates them; counting them here would inflate
  // a quiet period with work nobody did.
  const real = runs.filter((r) => !isBaselineUpdate(r));
  const thisPeriod = real.filter((r) => r.startedAt >= periodStart && r.startedAt <= now);
  const lastPeriod = real.filter((r) => r.startedAt >= prevStart && r.startedAt < periodStart);

  // A pruned DAY joins the window its midnight falls in. The window is rolling
  // and the buckets are calendar days, so the day straddling `periodStart`
  // lands wholly on one side — an error bounded by one day's pruned runs,
  // against an alternative of dropping them entirely. Nothing finer is
  // available: the records that carried the timestamps are what pruning
  // deleted.
  const prunedIn = (from, to) => prunedDays.filter((d) => d.dayStart >= from && d.dayStart <= to);
  const sum = (days, key) => days.reduce((n, d) => n + d[key], 0);

  const prunedThisPeriod = prunedIn(periodStart, now);
  const periodRuns = thisPeriod.length + sum(prunedThisPeriod, "runs");
  const failed =
    thisPeriod.filter((r) => r.status === "failed").length + sum(prunedThisPeriod, "failed");
  const previousRuns = lastPeriod.length + sum(prunedIn(prevStart, periodStart - 1), "runs");
  const offenders = rankOffenders(thisPeriod);
  const flaky = countFlaky(thisPeriod);

  return {
    runs: periodRuns,
    failed,
    previousRuns,
    offenders,
    flaky,
    lines: buildLines({ runs: periodRuns, failed, previousRuns, offenders, flaky }, periodLabel),
  };
}

/** A baseline update is a history row with no exit code of its own. Mirrors
 *  what the Stats header already excludes, so the two counts agree. */
function isBaselineUpdate(run) {
  return run.status !== "passed" && run.status !== "failed";
}

/**
 * Tests that failed, worst first.
 *
 * COUNTED PER TEST, NOT PER RUN, and that is the whole reason this is a list
 * rather than a number. One test failing three times is one problem; three
 * tests failing once each is three, and "3 failures" says the same thing about
 * both while they want completely different reactions.
 */
function rankOffenders(runs) {
  const byTest = new Map();
  for (const run of runs) {
    if (run.status !== "failed") continue;
    const found = byTest.get(run.testId);
    if (found) {
      found.failures++;
    } else {
      byTest.set(run.testId, {
        testId: run.testId,
        testName: run.testName || run.testId,
        failures: 1,
      });
    }
  }
  return [...byTest.values()].sort((a, b) => b.failures - a.failures);
}

/**
 * Flaky runs across the period, using §6.4's definition.
 *
 * TWO ORDERING FACTS, AND BOTH BITE. `flakeRuns` reads ONE test's history, so
 * the runs are grouped first — handed a mixed list it would compare a failure
 * of one test to a pass of another and report flake invented out of
 * interleaving. And it wants that history OLDEST FIRST — see its own doc
 * comment. `cost-model`'s `realRuns` re-sorts for exactly this reason; this
 * does the same rather than assuming a caller did it.
 */
function countFlaky(runs) {
  const byTest = new Map();
  for (const run of runs) {
    const list = byTest.get(run.testId);
    if (list) list.push(run);
    else byTest.set(run.testId, [run]);
  }
  let total = 0;
  for (const list of byTest.values()) {
    total += flakeRuns([...list].sort((a, b) => a.startedAt - b.startedAt)).size;
  }
  return total;
}

/** How many offenders get named before the rest become a count. Two, because
 *  the sentence has to stay a sentence — a list of five test names is a table
 *  written in prose, and there is a real table further down the screen. */
const NAMED_OFFENDERS = 2;

function buildLines(d, periodLabel) {
  if (d.runs === 0) {
    // Nothing ran. Said plainly and alone: any further sentence here would be
    // a statistic about an empty set.
    return d.previousRuns > 0
      ? [
          `Nothing ran this ${periodLabel}. ${d.previousRuns} run${plural(d.previousRuns)} the ${periodLabel} before.`,
        ]
      : [`Nothing ran this ${periodLabel}.`];
  }

  const lines = [];
  lines.push(
    d.failed === 0
      ? `${d.runs} run${plural(d.runs)}, all passed.`
      : `${d.runs} run${plural(d.runs)}, ${d.failed} failed.`,
  );

  // THE COMPARISON IS WHAT MAKES THIS PERIODIC. Without it these are totals,
  // and the panels below already do totals better. Omitted entirely when there
  // is no previous period — a first period compared against zero reads as
  // explosive growth, which is a statement about the app being new.
  const change = periodOnPeriod(d.runs, d.previousRuns, periodLabel);
  if (change) lines.push(change);

  if (d.offenders.length > 0) lines.push(offenderLine(d.offenders));

  // Flake last, and only when there is some: it is a qualifier on the failures
  // above rather than a finding of its own, and on a clean period it would be
  // the only sentence with a number in it and read as a problem.
  if (d.flaky > 0) {
    // "N of those failures" pluralises the wrong noun — with one flake it reads
    // "1 of those failure", and with one failure total the phrase claims a set
    // it is drawing from that does not exist. Naming the count directly is
    // grammatical at every value.
    lines.push(
      `${d.flaky} failure${plural(d.flaky)} passed again with nothing changed — possible flake.`,
    );
  }
  return lines;
}

/** The period-on-period sentence, or null when there is nothing honest to
 *  compare against. */
function periodOnPeriod(runs, previous, periodLabel) {
  if (previous === 0) return null;
  if (runs === previous) return `Same as the ${periodLabel} before.`;
  const delta = runs - previous;
  const direction = delta > 0 ? "Up" : "Down";
  return `${direction} ${Math.abs(delta)} on the ${periodLabel} before (${previous}).`;
}

function offenderLine(offenders) {
  const named = offenders.slice(0, NAMED_OFFENDERS);
  const rest = offenders.length - named.length;
  const parts = named.map((t) => `${t.testName} (${t.failures}×)`);
  const tail = rest > 0 ? `, and ${rest} other${plural(rest)}` : "";
  return offenders.length === 1
    ? `${named[0].testName} failed ${named[0].failures} time${plural(named[0].failures)}.`
    : `Worst: ${parts.join(", ")}${tail}.`;
}

function plural(n) {
  return n === 1 ? "" : "s";
}
