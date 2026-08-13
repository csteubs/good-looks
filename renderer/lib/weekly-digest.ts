// "How was this week?" — the weekly read. REDESIGN §6.5.
//
// WHAT THIS IS NOT. The mockup drew a weekly DIGEST PREVIEW sitting beside a
// list of delivery channels: a picture of the email that went out on Mondays.
// §7.3 removed the channels, because they promised a Slack integration that was
// never built — and with delivery gone, a preview is a preview of nothing.
//
// What survives the loss is the QUESTION, and it is one the Stats screen cannot
// currently answer. Six panels live there — cost, suite cost, step health,
// flake, divergence, capture overhead — and every one of them is a table or a
// breakdown. None says how the week went, and a reader who wants that has to
// assemble it from six places. So this is a READ: three or four sentences at the
// top of the screen, and the ticket emitter (§6.5) is how it leaves.
//
// It is deliberately NOT a seventh breakdown. Anything here that a panel below
// already states in more detail is a restatement, and a screen that says the
// same thing twice teaches people to skim both.
//
// PURE, over the runs the view already has. `now` is passed in rather than read,
// the same rule §6.1 and §6.6 follow: a week boundary computed from a hidden
// clock is one no test can sit either side of.

import type { RunRecord } from "./recorder-types";
import { flakeRuns } from "./cost-model";

const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export interface DigestTest {
  testId: string;
  testName: string;
  failures: number;
}

export interface WeeklyDigest {
  runs: number;
  failed: number;
  /** Runs in the seven days BEFORE this week, for the comparison. */
  previousRuns: number;
  /** Tests that failed at least once, worst first. */
  offenders: DigestTest[];
  /** Runs that failed and then passed again with nothing changed. Reuses
   *  §6.4's rule rather than defining a second one — two definitions of flake
   *  in one app is how two surfaces end up disagreeing in front of a user. */
  flaky: number;
  /** The sentences, in order. Empty when there is nothing to say. */
  lines: string[];
}

/**
 * A quiet week is not a good week, and the difference matters.
 *
 * With no runs at all the honest report is that nothing ran — NOT "0 failures"
 * or "100% passed", which are true statements about an empty set and read as
 * good news. This is the one reading the digest most has to get right, because
 * a suite nobody is running is the failure mode the whole app exists against.
 */
export function weeklyDigest(runs: readonly RunRecord[], now: number): WeeklyDigest {
  const weekStart = now - WEEK_MS;
  const prevStart = weekStart - WEEK_MS;

  // BASELINE UPDATES ARE NOT RUNS. They are recorded in the same history and
  // the Stats header already separates them; counting them here would inflate
  // a quiet week with work nobody did.
  const real = runs.filter((r) => !isBaselineUpdate(r));
  const thisWeek = real.filter((r) => r.startedAt >= weekStart && r.startedAt <= now);
  const lastWeek = real.filter((r) => r.startedAt >= prevStart && r.startedAt < weekStart);

  const failed = thisWeek.filter((r) => r.status === "failed").length;
  const offenders = rankOffenders(thisWeek);
  const flaky = countFlaky(thisWeek);

  return {
    runs: thisWeek.length,
    failed,
    previousRuns: lastWeek.length,
    offenders,
    flaky,
    lines: buildLines({
      runs: thisWeek.length,
      failed,
      previousRuns: lastWeek.length,
      offenders,
      flaky,
    }),
  };
}

/** A baseline update is a history row with no exit code of its own. Mirrors
 *  what the Stats header already excludes, so the two counts agree. */
function isBaselineUpdate(run: RunRecord): boolean {
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
function rankOffenders(runs: readonly RunRecord[]): DigestTest[] {
  const byTest = new Map<string, DigestTest>();
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
 * Flaky runs across the week, using §6.4's definition.
 *
 * TWO ORDERING FACTS, AND BOTH BITE. `flakeRuns` reads ONE test's history, so
 * the runs are grouped first — handed a mixed list it would compare a failure
 * of one test to a pass of another and report flake invented out of
 * interleaving. And it wants that history OLDEST FIRST, because its rule is
 * "failed and then passed": it looks for a failure at `i` and a pass at `i + 1`,
 * which is chronological order and the opposite of what `runHistoryStore.list`
 * returns. `cost-model`'s own `realRuns` re-sorts for exactly this reason; this
 * does the same rather than assuming a caller did it.
 *
 * Sorted the other way it silently finds nothing — no error, no zero-division,
 * just a flake line that never appears.
 */
function countFlaky(runs: readonly RunRecord[]): number {
  const byTest = new Map<string, RunRecord[]>();
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

function buildLines(d: Omit<WeeklyDigest, "lines">): string[] {
  if (d.runs === 0) {
    // Nothing ran. Said plainly and alone: any further sentence here would be
    // a statistic about an empty set.
    return d.previousRuns > 0
      ? [`Nothing ran this week. ${d.previousRuns} run${plural(d.previousRuns)} the week before.`]
      : ["Nothing ran this week."];
  }

  const lines: string[] = [];
  lines.push(
    d.failed === 0
      ? `${d.runs} run${plural(d.runs)}, all passed.`
      : `${d.runs} run${plural(d.runs)}, ${d.failed} failed.`,
  );

  // THE COMPARISON IS WHAT MAKES THIS WEEKLY. Without it these are totals, and
  // the panels below already do totals better. Omitted entirely when there is
  // no previous week — a first week compared against zero reads as explosive
  // growth, which is a statement about the app being new.
  const change = weekOnWeek(d.runs, d.previousRuns);
  if (change) lines.push(change);

  if (d.offenders.length > 0) lines.push(offenderLine(d.offenders));

  // Flake last, and only when there is some: it is a qualifier on the failures
  // above rather than a finding of its own, and on a clean week it would be the
  // only sentence with a number in it and read as a problem.
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

/** The week-on-week sentence, or null when there is nothing honest to compare
 *  against. */
function weekOnWeek(runs: number, previous: number): string | null {
  if (previous === 0) return null;
  if (runs === previous) return `Same as the week before.`;
  const delta = runs - previous;
  const direction = delta > 0 ? "Up" : "Down";
  return `${direction} ${Math.abs(delta)} on the week before (${previous}).`;
}

function offenderLine(offenders: readonly DigestTest[]): string {
  const named = offenders.slice(0, NAMED_OFFENDERS);
  const rest = offenders.length - named.length;
  const parts = named.map((t) => `${t.testName} (${t.failures}×)`);
  const tail = rest > 0 ? `, and ${rest} other${plural(rest)}` : "";
  return offenders.length === 1
    ? `${named[0].testName} failed ${named[0].failures} time${plural(named[0].failures)}.`
    : `Worst: ${parts.join(", ")}${tail}.`;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
