// How run history is CAPPED, and what is remembered when the cap drops a run.
//
// ── Why this file exists ───────────────────────────────────────────────────
// `recorder/run-history.json` is written by TWO PROCESSES: the app's
// `run-history-store.ts` and `saveRunRecord` in `mcp/server.mjs`, which shares
// no line of the app. Both append, and both therefore have to decide when the
// file is full and what to do about the record they drop.
//
// They decided differently, and the drift was invisible. PR #158 ("Count every
// run in the Stats totals, not the last 1000") raised the app's cap from 1000
// to 50000 and built the pruned tally underneath it, across 37 files — and
// touched nothing under `mcp/`. The MCP has been running the pre-#158 policy
// ever since: cap 1000, no tally. So one MCP run against a store the app had
// grown past a thousand records would truncate it to a thousand, delete the
// dropped runs' log files, and — because the tally was never written — remove
// those runs from the lifetime totals permanently. Nothing throws. The Stats
// board simply reports a smaller history than the machine actually has, which
// is the exact bug #158 existed to end.
//
// The neighbouring `MAX_BATCH_RECORDS` in the same file carries the comment
// "mirrors main/services/batch-history-store.ts" and does still match. That
// comment is a person doing by hand what this module does by construction —
// and the run cap is what happened the one time nobody did it.
//
// So what is shared here is the RULE, not the file access: which cap, which day
// a run belongs to, what a tally read off disk is allowed to say, and how one
// dropped run folds into it. Reading and writing stay on each side, because one
// side has a logger and an Electron userData path and the other has neither.
//
// Pure (see the admission rule in run-pacing.mjs): no fs, no IPC, no process,
// no DOM.

/**
 * How many run records `run-history.json` keeps.
 *
 * A CACHE SIZE, not a history length — the lifetime totals come from this cap
 * plus the tally below, which is the whole point of #158. Raising it costs
 * disk; lowering it silently discards evidence, so the two writers agreeing
 * matters more than the number does.
 */
export const RUN_HISTORY_CAP = 50_000;

/** How many days of pruned breakdown to keep. The digest reads fourteen (this
 *  week and the one before) and the chart seven; sixty is room for a view that
 *  wants a month without the file growing without limit. Older days are already
 *  in the flat totals, which is what the cards and the pass rate read. */
export const PRUNED_DAYS_KEPT = 60;

/**
 * Local midnight for a timestamp — the same bucketing `buildDailyBuckets` does
 * in the renderer, kept as a NUMBER rather than a formatted key so the two
 * cannot disagree about zero padding or separator. Both processes run on one
 * machine in one timezone, which is what makes a local day the right bucket.
 *
 * @param {number} ms
 * @returns {number}
 */
export function dayStartOf(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A count read back off disk: a non-negative whole number, or nothing. */
function count(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** A TIMESTAMP read back off disk. Signed, unlike `count` — epoch ms before
 *  1970 are negative, and validating a day bucket with the counter's rule threw
 *  the whole breakdown away for a clock the app does not control. No real run
 *  starts in 1969; a machine whose clock says so is exactly the case where
 *  keeping the other days beats discarding them. */
function whole(v) {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/** The zero tally — nothing has ever been pruned. */
export function emptyPrunedTally() {
  return { runs: 0, passed: 0, failed: 0, days: [], adopted: false };
}

/**
 * The per-day breakdown, or nothing at all.
 *
 * Same all-or-none rule as the totals, one level down: a bucket that survived
 * validation while its neighbour did not would make the digest state a week
 * that never happened. Dropping the breakdown degrades the two windowed figures
 * to what they showed before it existed — an undercount that is at least a
 * count — while the lifetime totals beside them stay exact.
 */
function readDays(raw, total) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let sum = 0;
  for (const entry of raw) {
    const dayStart = whole(entry?.dayStart);
    const runs = count(entry?.runs);
    const passed = count(entry?.passed);
    const failed = count(entry?.failed);
    if (dayStart === null || runs === null || passed === null || failed === null) return [];
    if (passed + failed !== runs) return [];
    out.push({ dayStart, runs, passed, failed });
    sum += runs;
  }
  // The days are a SUBSET of the total by construction (only the most recent
  // are kept). More days than runs is a file describing something that cannot
  // have happened.
  if (sum > total) return [];
  return out.sort((a, b) => a.dayStart - b.dayStart);
}

/**
 * Narrow a tally parsed off disk, or answer zeroes.
 *
 * ALL THREE FIELDS OR NONE, and the check that pinned this is the reason. The
 * first version sanitised each field on its own, so a file with a plausible
 * `failed` and a nonsense `runs` produced a total SMALLER than the outcome
 * counts sitting beside it on the same row — three numbers on one screen that
 * cannot all be true. A corrupt counter should understate the history, which is
 * self-correcting from the next prune onwards; it should never make the screen
 * incoherent. The same reasoning rejects a file whose parts don't add up.
 *
 * Takes ALREADY-PARSED JSON rather than a path: reading the file is the half
 * that differs between the two processes, and is the half that must not be in
 * `shared/`.
 *
 * @param {unknown} parsed
 */
export function readPrunedTally(parsed) {
  const zero = emptyPrunedTally();
  if (!parsed || typeof parsed !== "object") return zero;
  const runs = count(parsed.runs);
  const passed = count(parsed.passed);
  const failed = count(parsed.failed);
  if (runs === null || passed === null || failed === null) return zero;
  if (passed + failed !== runs) return zero;
  return {
    runs,
    passed,
    failed,
    days: readDays(parsed.days, runs),
    // Absent means "not yet" — an upgrade from before the seed existed.
    adopted: parsed.adopted === true,
  };
}

/**
 * Fold ONE pruned run into a tally, in place.
 *
 * A baseline-update record is an event rather than a run and is skipped, which
 * is the same rule every counter in the app applies to it. Returns whether the
 * record counted, so a caller can tell "nothing was dropped" from "records were
 * dropped but none of them were runs" — only the first means the tally file
 * does not need rewriting.
 *
 * @param {{runs:number,passed:number,failed:number,days:Array<{dayStart:number,runs:number,passed:number,failed:number}>,adopted:boolean}} tally
 * @param {{startedAt:number,status:string,kind?:string}} rec
 * @returns {boolean}
 */
export function foldPrunedRun(tally, rec) {
  if (rec?.kind === "baseline-update") return false;
  const passed = rec?.status === "passed";
  tally.runs++;
  if (passed) tally.passed++;
  else tally.failed++;

  const dayStart = dayStartOf(rec.startedAt);
  const bucket = tally.days.find((d) => d.dayStart === dayStart);
  if (bucket) {
    bucket.runs++;
    if (passed) bucket.passed++;
    else bucket.failed++;
  } else {
    tally.days.push({ dayStart, runs: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1 });
    tally.days.sort((a, b) => a.dayStart - b.dayStart);
    if (tally.days.length > PRUNED_DAYS_KEPT) {
      tally.days = tally.days.slice(-PRUNED_DAYS_KEPT);
    }
  }
  return true;
}
