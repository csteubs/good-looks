// Throwaway verification of the artifact-retention setting: clamping +
// persistence in recorder-settings-store, and artifactStore.usage() accounting.
// Run via the same esbuild+alias pattern as visual-pipeline.check.ts.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { artifactStore } from "../artifact-store.js";
import { recorderSettingsStore } from "../recorder-settings-store.js";

// Both stores resolve `app.getPath("userData")` lazily per call (see
// glaze-backend-stub.ts), so pointing them at a throwaway dir here — after the
// imports — still lands every write inside it.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-retention-check-"));
process.env.GLAZE_TEST_USERDATA = userData;

let failures = 0;
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

fs.rmSync(userData, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll retention checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
