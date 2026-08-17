// The lifetime run counter: does "Total runs" still tell the truth once the
// run index has hit its cap?
//
// THE BUG THIS PINS. run-history.json holds at most MAX_RECORDS records and
// prunes the oldest to stay there. Every counter on the Stats screen was
// `runs.length` over that list, so on a suite past the cap the board reported
// 1000 total runs, 1000 runs ago, and would report 1000 forever. Nothing threw
// and nothing looked broken — the number was simply the size of a cache being
// read as the size of a history.
//
// It is a check rather than a Vitest case because the store is only itself with
// a real filesystem under it: the whole mechanism is a second file that has to
// be written at the moment of pruning, and a mocked `fs` would let a version
// that never writes it pass. Bundled with the same esbuild+alias pattern as
// retention.check.ts.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { runHistoryStore } from "../run-history-store.js";
import type { RunRecord } from "../../recorder/types.js";

// Set after the imports: the shell stub resolves app.getPath() lazily per call,
// so every write below still lands in this throwaway dir.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-run-totals-check-"));
process.env.GLAZE_TEST_USERDATA = userData;

const recorderDir = path.join(userData, "recorder");
const indexFile = path.join(recorderDir, "run-history.json");
const tallyFile = path.join(recorderDir, "run-history-pruned.json");

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

/** The cap, mirrored. Deliberately NOT imported: the store does not export it,
 *  and a check that reads the constant it is testing against agrees with a
 *  typo. If this is ever wrong the seeded index simply won't reach the cap and
 *  the prune assertions below fail loudly, which is the correct outcome. */
const MAX_RECORDS = 1000;

function seeded(i: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `seed-${i}`,
    testId: "t1",
    testName: "Alpha",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: 1_000_000 + i,
    finishedAt: 1_000_000 + i + 5,
    durationMs: 5,
    logFile: path.join(recorderDir, "logs", `seed-${i}.log`),
    logBytes: 0,
    ...over,
  } as RunRecord;
}

function appendRun(id: string, status: "passed" | "failed", startedAt: number): void {
  runHistoryStore.append(
    {
      id,
      testId: "t1",
      testName: "Alpha",
      url: "https://example.com",
      status,
      exitCode: status === "passed" ? 0 : 1,
      startedAt,
      finishedAt: startedAt + 10,
    },
    "console output",
  );
}

// ── 1. An empty store counts nothing, and says so without a tally file ──

eq(
  runHistoryStore.totals(),
  { runs: 0, passed: 0, failed: 0, retained: 0, pruned: 0, prunedDays: [] },
  "an empty history totals zero",
);

// ── 2. Under the cap, the total IS the retained count ──────────────────

appendRun("a", "passed", 2_000_000);
appendRun("b", "failed", 2_000_001);
eq(
  runHistoryStore.totals(),
  { runs: 2, passed: 1, failed: 1, retained: 2, pruned: 0, prunedDays: [] },
  "under the cap, every run is retained",
);

// A baseline update is an event, not a run — the same rule every rate on the
// Stats screen already follows. Counting it here would move the pass rate when
// nothing had been executed at all.
runHistoryStore.logBaselineUpdate("t1", "Alpha", 2, "run");
eq(
  runHistoryStore.totals(),
  { runs: 2, passed: 1, failed: 1, retained: 2, pruned: 0, prunedDays: [] },
  "a baseline update is not counted as a run",
);

// ── 3. PAST THE CAP: the total keeps climbing, the index does not ──────
//
// The index is seeded directly rather than by 1000 appends — each append
// rewrites the whole file, so the honest version of this setup is quadratic and
// takes minutes. What is under test is the prune, and the prune reads the file.

fs.mkdirSync(path.join(recorderDir, "logs"), { recursive: true });
fs.writeFileSync(
  indexFile,
  JSON.stringify(
    Array.from({ length: MAX_RECORDS }, (_, i) => seeded(i)),
    null,
    2,
  ),
  "utf-8",
);
fs.rmSync(tallyFile, { force: true });

eq(runHistoryStore.list().length, MAX_RECORDS, "the seeded index is exactly at the cap");

appendRun("new-1", "passed", 3_000_000);
appendRun("new-2", "passed", 3_000_001);
appendRun("new-3", "failed", 3_000_002);

eq(runHistoryStore.list().length, MAX_RECORDS, "the index stays at the cap");
eq(
  runHistoryStore.totals(),
  {
    runs: MAX_RECORDS + 3,
    // The three pruned records were seeded runs, all passed.
    passed: MAX_RECORDS + 2,
    failed: 1,
    retained: MAX_RECORDS,
    pruned: 3,
    // All three pruned records were seeded on one day; the day breakdown gets
    // its own assertions below.
    prunedDays: [{ dayStart: dayStartOf(1_000_000), runs: 3, passed: 3, failed: 0 }],
  },
  "the total counts pruned runs; the retained count does not",
);

// THE PATH THAT WOULD HAVE BEEN FORGOTTEN. logBaselineUpdate prunes too, and it
// pruned through its own copy of the loop until both callers were moved onto
// one helper. At the cap it pushes a real run out of the index, so the tally has
// to grow even though what was ADDED is not a run.
runHistoryStore.logBaselineUpdate("t1", "Alpha", 1, "step");
eq(
  runHistoryStore.totals().pruned,
  4,
  "a baseline update that prunes a run still counts that run",
);
eq(runHistoryStore.totals().runs, MAX_RECORDS + 3, "…and the lifetime total is unchanged by it");
eq(
  runHistoryStore.totals().retained,
  MAX_RECORDS - 1,
  "…while the retained count drops, because a run left the index",
);

// ── 3b. Pruned runs keep their DAY ─────────────────────────────────────
//
// A lifetime total cannot repair a figure that counts a WINDOW. The weekly
// digest and the pass/fail chart both count the last seven days out of the run
// list, and pruning takes the OLDEST records — so a suite that fits a thousand
// runs inside a week starts losing that week's own runs, and the digest reports
// "1000 runs this week" on a week that had more.

function dayStartOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 86_400_000;
const today = dayStartOf(Date.now());

runHistoryStore.deleteAll();
fs.writeFileSync(
  indexFile,
  JSON.stringify(
    // Two days' worth, all older than the runs appended below, so the cap
    // reaches them: 3 on the day before yesterday, 2 yesterday.
    [
      ...Array.from({ length: 3 }, (_, i) =>
        seeded(i, { id: `d2-${i}`, startedAt: today - 2 * DAY_MS + i * 1000, status: "failed" }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        seeded(100 + i, { id: `d1-${i}`, startedAt: today - DAY_MS + i * 1000 }),
      ),
      ...Array.from({ length: MAX_RECORDS - 5 }, (_, i) =>
        seeded(1000 + i, { id: `now-${i}`, startedAt: today + i * 1000 }),
      ),
    ],
    null,
    2,
  ),
  "utf-8",
);

appendRun("push-1", "passed", today + 900_000);
appendRun("push-2", "passed", today + 900_001);
appendRun("push-3", "passed", today + 900_002);
appendRun("push-4", "passed", today + 900_003);

const days = runHistoryStore.totals().prunedDays;
eq(days.length, 2, "pruned runs are bucketed by the day they started");
eq(
  days.map((d) => [d.dayStart - today, d.runs, d.passed, d.failed]),
  [
    [-2 * DAY_MS, 3, 0, 3],
    [-DAY_MS, 1, 1, 0],
  ],
  "each day carries its own outcome split, oldest first",
);
eq(
  days.reduce((n, d) => n + d.runs, 0),
  runHistoryStore.totals().pruned,
  "the day buckets account for every pruned run",
);

// ── 4. A corrupt tally understates; it never poisons ───────────────────
//
// The alternative is a KPI card reading "NaN", which is worse than one reading
// low: a low number is a number, and this file is rebuilt by the next prune.

fs.writeFileSync(tallyFile, "{ not json", "utf-8");
eq(runHistoryStore.totals().pruned, 0, "an unparseable tally reads as zero pruned");
eq(
  runHistoryStore.totals().runs,
  runHistoryStore.totals().retained,
  "…and the total falls back to the retained count",
);

fs.writeFileSync(tallyFile, JSON.stringify({ runs: -5, passed: "many", failed: 1.7 }), "utf-8");
const nonsense = runHistoryStore.totals();
eq(
  { pruned: nonsense.pruned, runs: nonsense.runs - nonsense.retained },
  { pruned: 0, runs: 0 },
  "a negative, a string and a fraction each contribute nothing",
);
eq(
  nonsense.passed + nonsense.failed === nonsense.runs && Number.isInteger(nonsense.runs),
  true,
  "the outcome counts still add up to the total, as whole numbers",
);

// A tally that parses and is all whole numbers can still be internally
// impossible, and one that says 40 runs of which 30 passed and 30 failed is not
// a history — it is a corrupt file whose parts happen to be plausible.
fs.writeFileSync(tallyFile, JSON.stringify({ runs: 40, passed: 30, failed: 30 }), "utf-8");
eq(runHistoryStore.totals().pruned, 0, "a tally whose parts don't add up is discarded whole");

// ── 5. Deleting history forgets the pruned runs too ────────────────────
//
// The user asking to reset stats and then being told 1003 runs happened is the
// same complaint this counter answers, pointing the other way.

runHistoryStore.resetStats();
eq(
  runHistoryStore.totals(),
  { runs: 0, passed: 0, failed: 0, retained: 0, pruned: 0, prunedDays: [] },
  "resetStats clears the pruned tally as well as the index",
);

appendRun("after-reset", "passed", 4_000_000);
fs.writeFileSync(tallyFile, JSON.stringify({ runs: 7, passed: 5, failed: 2 }), "utf-8");
eq(runHistoryStore.totals().runs, 8, "a fresh tally is counted again");
runHistoryStore.deleteAll();
eq(
  runHistoryStore.totals(),
  { runs: 0, passed: 0, failed: 0, retained: 0, pruned: 0, prunedDays: [] },
  "deleteAll clears the pruned tally as well as the index",
);

// ── 6. deleteRange leaves the tally alone, on purpose ──────────────────
//
// Everything the tally counts is older than every record still in the index, so
// a range that reaches those runs has nothing left to delete. Subtracting here
// would double-count the removal.

appendRun("keep", "passed", 5_000_000);
appendRun("drop", "failed", 5_000_100);
fs.writeFileSync(tallyFile, JSON.stringify({ runs: 4, passed: 3, failed: 1 }), "utf-8");
runHistoryStore.deleteRange(5_000_050, 5_000_200);
eq(
  runHistoryStore.totals(),
  { runs: 5, passed: 4, failed: 1, retained: 1, pruned: 4, prunedDays: [] },
  "deleting a date range removes records without rewriting history",
);

console.log(failures === 0 ? "\nAll run-totals checks passed." : `\n${failures} check(s) FAILED.`);
try {
  fs.rmSync(userData, { recursive: true, force: true });
} catch {
  /* best effort */
}
process.exit(failures === 0 ? 0 : 1);
