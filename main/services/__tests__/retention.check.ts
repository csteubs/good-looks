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

fs.rmSync(userData, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll retention checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
