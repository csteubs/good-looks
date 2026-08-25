// Throwaway verification of the artifact-retention setting: clamping +
// persistence in recorder-settings-store, and artifactStore.usage() accounting.
// Run via the same esbuild+alias pattern as visual-pipeline.check.ts.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { artifactStore, setPrunePreflight } from "../artifact-store.js";
import { recorderSettingsStore } from "../recorder-settings-store.js";
import {
  SWEEP_INTERVAL_MS,
  applyRetentionForTest,
  resetSweepClock,
  sweepRetentionIfDue,
} from "../retention.js";

// Both stores resolve `app.getPath("userData")` lazily per call (see
// shell-backend-stub.ts), so pointing them at a throwaway dir here — after the
// imports — still lands every write inside it.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-retention-check-"));
process.env.GLAZE_TEST_USERDATA = userData;

let failures = 0;
function check(cond: boolean, label: string): void {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

// 1. Default when nothing is persisted.
eq(recorderSettingsStore.get().artifactRetainedRuns, 10, "defaults to 10 retained runs");

// 2. Clamping on write.
eq(
  recorderSettingsStore.set({ artifactRetainedRuns: 3 }).artifactRetainedRuns,
  3,
  "accepts an in-range value",
);
eq(
  recorderSettingsStore.set({ artifactRetainedRuns: 999 }).artifactRetainedRuns,
  50,
  "clamps above the max",
);
eq(
  recorderSettingsStore.set({ artifactRetainedRuns: 0 }).artifactRetainedRuns,
  50,
  "ignores a non-positive value (keeps current)",
);
eq(
  recorderSettingsStore.set({ artifactRetainedRuns: 2.6 }).artifactRetainedRuns,
  3,
  "rounds a fractional value",
);

// 3. Persisted and re-read; unrelated writes preserve it.
eq(recorderSettingsStore.get().artifactRetainedRuns, 3, "persists across a fresh read");
eq(
  recorderSettingsStore.set({ showUrlBar: false }).artifactRetainedRuns,
  3,
  "unrelated writes preserve it",
);

// 4. Clamping on read of a hand-edited file.
const file = path.join(userData, "recorder", "recorder-settings.json");
fs.writeFileSync(file, JSON.stringify({ artifactRetainedRuns: 4000 }), "utf-8");
eq(
  recorderSettingsStore.get().artifactRetainedRuns,
  50,
  "clamps a hand-edited out-of-range file value",
);

// 5. usage() on an empty tree, then with seeded artifacts.
eq(artifactStore.usage(), { bytes: 0, runs: 0, tests: 0 }, "empty artifacts tree reports zeros");

const runA = artifactStore.ensureRunDir("test-1", "run-a");
const runB = artifactStore.ensureRunDir("test-1", "run-b");
const runC = artifactStore.ensureRunDir("test-2", "run-c");
fs.writeFileSync(path.join(runA, "0.png"), Buffer.alloc(1000));
fs.writeFileSync(path.join(runB, "0.png"), Buffer.alloc(2000));
fs.writeFileSync(path.join(runC, "0.png"), Buffer.alloc(4000));
// The pinned baseline is not a run, but its bytes still occupy disk.
const baselineDir = path.join(artifactStore.rootPath(), "test-1", "baseline");
fs.mkdirSync(baselineDir, { recursive: true });
fs.writeFileSync(path.join(baselineDir, "step.png"), Buffer.alloc(500));

const usage = artifactStore.usage();
eq(usage.tests, 2, "counts each test with artifacts");
eq(usage.runs, 3, "counts run dirs only (baseline/ excluded)");
eq(usage.bytes, 7500, "sums every artifact byte, including the baseline");

// 6. Retention at the configured number leaves exactly that many run dirs, and
//    never the baseline (mirrors what playwright-runner does before a run).
artifactStore.ensureRunDir("test-1", "run-c2");
artifactStore.pruneRuns("test-1", 1);
eq(artifactStore.listRuns("test-1").length, 1, "pruneRuns honors a low retained count");
eq(
  fs.existsSync(path.join(baselineDir, "step.png")),
  true,
  "a low retained count still never prunes the baseline",
);

// 7. Age-based retention runs ON TOP of the count cap.
const AGED_TEST = "test-aged";
const DAY_MS = 24 * 60 * 60 * 1000;
const aged = artifactStore.ensureRunDir(AGED_TEST, "old-run");
const fresh = artifactStore.ensureRunDir(AGED_TEST, "new-run");
fs.writeFileSync(path.join(aged, "0.png"), Buffer.alloc(10));
fs.writeFileSync(path.join(fresh, "0.png"), Buffer.alloc(10));
// Backdate the old run's directory mtime by 30 days.
const old = new Date(Date.now() - 30 * DAY_MS);
fs.utimesSync(aged, old, old);

// Age rule off: the count cap alone keeps both.
artifactStore.pruneRuns(AGED_TEST, 10, 0);
eq(artifactStore.listRuns(AGED_TEST).length, 2, "maxAgeMs=0 disables the age rule");

// A 7-day cutoff drops the 30-day-old run but keeps the fresh one, even though
// the count cap alone would have kept both.
artifactStore.pruneRuns(AGED_TEST, 10, 7 * DAY_MS);
eq(artifactStore.listRuns(AGED_TEST), ["new-run"], "runs older than the cutoff are pruned by age");

// A generous cutoff keeps everything that survived.
artifactStore.pruneRuns(AGED_TEST, 10, 365 * DAY_MS);
eq(artifactStore.listRuns(AGED_TEST).length, 1, "a wide cutoff prunes nothing further");

// Both rules apply together: cutoff keeps it, but the count cap doesn't.
const a2 = artifactStore.ensureRunDir(AGED_TEST, "second-run");
fs.writeFileSync(path.join(a2, "0.png"), Buffer.alloc(10));
artifactStore.pruneRuns(AGED_TEST, 1, 365 * DAY_MS);
eq(artifactStore.listRuns(AGED_TEST).length, 1, "the count cap still applies under an age rule");

// The baseline survives age-based pruning too.
const agedBaseline = path.join(artifactStore.rootPath(), AGED_TEST, "baseline");
fs.mkdirSync(agedBaseline, { recursive: true });
fs.writeFileSync(path.join(agedBaseline, "step.png"), Buffer.alloc(10));
const oldB = new Date(Date.now() - 300 * DAY_MS);
fs.utimesSync(agedBaseline, oldB, oldB);
artifactStore.pruneRuns(AGED_TEST, 10, DAY_MS);
eq(
  fs.existsSync(path.join(agedBaseline, "step.png")),
  true,
  "an old pinned baseline survives age-based pruning",
);

// Settings clamping for the new field.
eq(recorderSettingsStore.get().artifactRetentionDays, 0, "age retention defaults to off");
eq(
  recorderSettingsStore.set({ artifactRetentionDays: 9999 }).artifactRetentionDays,
  365,
  "clamps the retention age to a year",
);
eq(
  recorderSettingsStore.set({ artifactRetentionDays: 0 }).artifactRetentionDays,
  0,
  "0 is accepted (disables the rule) rather than treated as unset",
);

// 8. Retention sweeps EVERY test, not just the one being run.
// This is the hole pruneRuns alone left: a test you stop running never ages
// out, so an "older than N days" rule silently did nothing for it.
const IDLE = "test-idle";
const ACTIVE = "test-active";
for (const [testId, ageDays] of [
  [IDLE, 30],
  [ACTIVE, 30],
] as const) {
  const dir = artifactStore.ensureRunDir(testId, `stale-${testId}`);
  fs.writeFileSync(path.join(dir, "0.png"), Buffer.alloc(2048));
  const when = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(dir, when, when);
}
// A fresh run for the active test only — the idle one gets nothing new.
const activeFresh = artifactStore.ensureRunDir(ACTIVE, "fresh");
fs.writeFileSync(path.join(activeFresh, "0.png"), Buffer.alloc(2048));

// Per-test pruning (what a capture run does) only touches the test it ran.
artifactStore.pruneRuns(ACTIVE, 10, 7 * DAY_MS);
eq(artifactStore.listRuns(ACTIVE), ["fresh"], "a run prunes its own test's stale artifacts");
eq(
  artifactStore.listRuns(IDLE).length,
  1,
  "…but leaves an idle test's stale artifacts untouched (the gap)",
);

// The all-tests sweep closes it.
const swept = artifactStore.pruneAllTests(10, 7 * DAY_MS);
eq(artifactStore.listRuns(IDLE).length, 0, "pruneAllTests reaches an idle test");
eq(swept.removedRuns, 1, "the sweep reports how many runs it removed");
check(swept.freedBytes > 0, "the sweep reports the bytes it freed");

// Sweeping again is a no-op rather than an error.
const again = artifactStore.pruneAllTests(10, 7 * DAY_MS);
eq(again.removedRuns, 0, "a second sweep removes nothing");

// A lowered run limit applies retroactively across tests.
for (let i = 0; i < 5; i++) {
  const d = artifactStore.ensureRunDir(IDLE, `bulk-${i}`);
  fs.writeFileSync(path.join(d, "0.png"), Buffer.alloc(512));
  const t = new Date(Date.now() + i * 1000);
  fs.utimesSync(d, t, t);
}
artifactStore.pruneAllTests(2, 0);
eq(artifactStore.listRuns(IDLE).length, 2, "a lowered run limit applies without a new run");

// 9. The prune preflight — the seam the metrics rollup hangs off. Registered,
// it must fire once per removed run BEFORE that run's files go; after them is
// a rollup of evidence that no longer exists. Note every section above pruned
// with NO preflight registered and was allowed to: the store skips an
// unregistered preflight rather than waiting for one, by design (a metrics
// failure must never block retention) — which is exactly why the launch order
// in main/index.ts matters, and check:metrics-db pins it.
const PREF = "test-preflight";
const seen: Array<{ testId: string; runId: string; evidenceOnDisk: boolean }> = [];
setPrunePreflight((testId, runId) => {
  seen.push({
    testId,
    runId,
    evidenceOnDisk: fs.existsSync(path.join(artifactStore.rootPath(), testId, runId, "0.png")),
  });
});

const doomed = artifactStore.ensureRunDir(PREF, "doomed-run");
const kept = artifactStore.ensureRunDir(PREF, "kept-run");
fs.writeFileSync(path.join(doomed, "0.png"), Buffer.alloc(10));
fs.writeFileSync(path.join(kept, "0.png"), Buffer.alloc(10));
const stale = new Date(Date.now() - 30 * DAY_MS);
fs.utimesSync(doomed, stale, stale);

const sweptWithPreflight = artifactStore.pruneAllTests(10, 7 * DAY_MS);
eq(sweptWithPreflight.removedRuns, 1, "the preflight sweep removes only the stale run");
eq(
  seen,
  [{ testId: PREF, runId: "doomed-run", evidenceOnDisk: true }],
  "the preflight fires once per removed run, while its files are still on disk",
);
eq(artifactStore.listRuns(PREF), ["kept-run"], "surviving runs are never preflighted");

// A preflight that throws must not save the run from retention: the disk
// filling up is a worse failure than a gap in the metrics.
const doomed2 = artifactStore.ensureRunDir(PREF, "doomed-run-2");
fs.writeFileSync(path.join(doomed2, "0.png"), Buffer.alloc(10));
fs.utimesSync(doomed2, stale, stale);
setPrunePreflight(() => {
  throw new Error("metrics unavailable");
});
artifactStore.pruneAllTests(10, 7 * DAY_MS);
eq(artifactStore.listRuns(PREF), ["kept-run"], "a throwing preflight cannot stop the prune");

// ── R17: what a RUN pays for ────────────────────────────────────────────
//
// `applyRetention` used to sit in every run's `finally`, and it is the
// expensive one: `pruneAllTests` brackets itself with two `usage()` walks, each
// a recursive `statSync` over the whole artifacts tree, so a hundred-test batch
// paid for the entire library two hundred times on the thread streaming its own
// output. The run path now prunes the ONE test that just ran and lets the
// library-wide sweep be throttled.
setPrunePreflight(() => {});

const RAN = "test-just-ran";
const OTHER = "test-untouched";
for (const id of [RAN, OTHER]) {
  for (const runId of ["old-run", "new-run"]) {
    const dir = artifactStore.ensureRunDir(id, runId);
    fs.writeFileSync(path.join(dir, "0.png"), Buffer.alloc(10));
  }
  const staleAt = new Date(Date.now() - 30 * DAY_MS);
  fs.utimesSync(path.join(artifactStore.rootPath(), id, "old-run"), staleAt, staleAt);
}
recorderSettingsStore.set({ artifactRetainedRuns: 10, artifactRetentionDays: 7 });

applyRetentionForTest(RAN);
eq(artifactStore.listRuns(RAN), ["new-run"], "the run path prunes the test that just ran");
eq(
  artifactStore.listRuns(OTHER).sort(),
  ["new-run", "old-run"],
  "…and touches no other test — that is the library sweep's job, not a run's",
);

// The sweep still happens, but not once per run. `resetSweepClock` is the test
// seam; a real session's first run after startup sweeps, and the next one
// inside half an hour does not.
resetSweepClock();
const firstSweep = sweepRetentionIfDue();
check(firstSweep !== null, "the first sweep after a reset is due");
eq(artifactStore.listRuns(OTHER), ["new-run"], "the sweep is what ages out an idle test");

const secondSweep = sweepRetentionIfDue();
eq(secondSweep, null, "a second sweep moments later is declined, not repeated");

const laterSweep = sweepRetentionIfDue(Date.now() + SWEEP_INTERVAL_MS + 1);
check(laterSweep !== null, "…and is due again once the interval has passed");

// The wiring, which no behavioural test can see. Reintroducing the expensive
// call in the run path breaks nothing, fails nothing and returns the same
// answers — it just costs the whole library two full-tree stat walks per run
// again, which is only visible as "the app got slow during batches".
{
  const runnerSrc = fs.readFileSync(
    path.join(process.cwd(), "main/services/playwright-runner.ts"),
    "utf8",
  );
  const code = runnerSrc
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  check(
    /applyRetentionForTest\(/.test(code),
    "the run path prunes the test that ran",
  );
  check(
    /sweepRetentionIfDue\(/.test(code),
    "the run path asks for the library sweep rather than performing one",
  );
  check(
    !/\bapplyRetention\(/.test(code),
    "the run path does not call the whole-library sweep directly (R17)",
  );
}

fs.rmSync(userData, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll retention checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
