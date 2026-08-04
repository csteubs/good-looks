// Regression check for summarizeCaptureOverhead — the "what does capture
// actually cost?" math behind the Stats panel. Pure function, synthetic
// RunRecords, no filesystem or browser.
//
//   npm run check:capture-overhead

import { summarizeCaptureOverhead } from "../capture-overhead.js";
import { buildRunNotice } from "../run-notifier.js";
import type { RunRecord } from "../../recorder/types.js";

let failures = 0;
function eq<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

let seq = 0;
function run(partial: Partial<RunRecord>): RunRecord {
  seq++;
  const startedAt = 1_000_000 + seq * 10_000;
  const durationMs = partial.durationMs ?? 1000;
  return {
    id: `run-${seq}`,
    testId: partial.testId ?? "test-a",
    testName: "T",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt,
    finishedAt: startedAt + durationMs,
    durationMs,
    logFile: "",
    logBytes: 0,
    ...partial,
  };
}

// ── Empty input ────────────────────────────────────────────────────────────
const empty = summarizeCaptureOverhead([]);
eq(empty.capturedRuns, 0, "no runs → zero captured runs");
eq(empty.meanCaptureMs, 0, "no runs → no division by zero");
eq(empty.meanUncapturedDurationMs, null, "no uncaptured runs → null, not 0");

// ── Mixed history ──────────────────────────────────────────────────────────
const records: RunRecord[] = [
  // Two instrumented capture runs: 400ms/4 shots and 600ms/6 shots.
  run({ captureArtifacts: true, captureOverheadMs: 400, shotCount: 4, durationMs: 2000 }),
  run({ captureArtifacts: true, captureOverheadMs: 600, shotCount: 6, durationMs: 3000 }),
  // Two plain runs.
  run({ durationMs: 1000 }),
  run({ durationMs: 2000 }),
  // A capture run from BEFORE instrumentation — no timings recorded.
  run({ captureArtifacts: true, durationMs: 5000 }),
  // A baseline-update event — not an execution at all.
  run({ kind: "baseline-update", durationMs: 9999 }),
];

const s = summarizeCaptureOverhead(records);
eq(s.capturedRuns, 2, "only instrumented capture runs count");
eq(s.uncapturedRuns, 2, "non-capture runs counted separately");
eq(s.meanCaptureMs, 500, "mean capture time is (400+600)/2");
eq(s.totalShots, 10, "shots summed across capture runs");
eq(s.meanMsPerShot, 100, "per-shot mean is total ms ÷ total shots");
eq(s.meanCapturedDurationMs, 2500, "mean duration of captured runs");
eq(s.meanUncapturedDurationMs, 1500, "mean duration of uncaptured runs");
eq(s.captureShareOfRun, 0.2, "capture is 500ms of a 2500ms run");

// The uninstrumented capture run must not be treated as zero-cost — that would
// drag the mean down and understate the overhead.
eq(
  summarizeCaptureOverhead(records.filter((r) => r.captureOverheadMs === undefined)).capturedRuns,
  0,
  "capture runs without timings are excluded, not counted as free",
);

// A baseline-update event must never enter the uncaptured comparison set.
eq(
  summarizeCaptureOverhead([run({ kind: "baseline-update", durationMs: 9999 })])
    .meanUncapturedDurationMs,
  null,
  "baseline-update events are not runs",
);

// ── Scoping to one test ────────────────────────────────────────────────────
const scoped = summarizeCaptureOverhead(
  [
    run({ testId: "test-a", captureArtifacts: true, captureOverheadMs: 100, shotCount: 1 }),
    run({ testId: "test-b", captureArtifacts: true, captureOverheadMs: 900, shotCount: 1 }),
  ],
  "test-a",
);
eq(scoped.capturedRuns, 1, "testId scopes the summary to one test");
eq(scoped.meanCaptureMs, 100, "another test's runs don't skew the mean");

// ── Run-notification decisions ─────────────────────────────────────────────
// Same file: both are small pure "what do we tell the user about this run?"
// helpers driven by RunRecord-shaped data.
eq(
  buildRunNotice({ testName: "Checkout", status: "passed", changedSteps: 0 }),
  null,
  "a clean run notifies nothing",
);
eq(
  buildRunNotice({ testName: "Checkout", status: "failed", changedSteps: 0 })?.title,
  "Checkout failed",
  "a failed run names the test",
);
eq(
  buildRunNotice({ testName: "Checkout", status: "failed", changedSteps: 0, failedLabel: "Click Pay" })
    ?.body,
  "Failed at: Click Pay",
  "the failing step is named when known",
);
eq(
  buildRunNotice({ testName: "Checkout", status: "passed", changedSteps: 2 })?.title,
  "Checkout: visual change",
  "a passing run with visual changes still notifies",
);
eq(
  buildRunNotice({ testName: "Checkout", status: "passed", changedSteps: 1 })?.body,
  "1 step changed visually.",
  "step count is singular for one change",
);
eq(
  buildRunNotice({ testName: "Checkout", status: "failed", changedSteps: 3, failedLabel: "Click Pay" })
    ?.body,
  "Failed at: Click Pay 3 steps changed visually.",
  "a failure with visual changes reports both",
);

console.log(failures === 0 ? "\nAll capture-overhead checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
