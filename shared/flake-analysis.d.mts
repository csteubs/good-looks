// Types for flake-analysis.mjs. See run-pacing.d.mts for why these are
// hand-written.
//
// `FlakeRun` is the notable one. The implementation used to take
// `main/recorder/types.js`'s `RunRecord`, which a module in shared/ cannot
// import — it is a `.ts` on the app's side of the boundary, and importing it
// would drag @glaze/core in behind it. So the input is declared here as the
// STRUCTURAL SUBSET the analysis actually reads: eight fields, all of which
// `RunRecord` has. A real `RunRecord` still satisfies it, so every existing
// caller type-checks unchanged, and the declaration doubles as documentation of
// what this module is allowed to look at.

/** What the analysis reads from a run record. `RunRecord` is a superset. */
export interface FlakeRun {
  id: string;
  testId: string;
  testName: string;
  status: "passed" | "failed";
  startedAt: number;
  /** "baseline-update" events are not executions and are filtered out. */
  kind?: string;
  /** How the run ended when it did not end on its own. `"user"` runs are
   *  filtered out — their outcome is a keystroke, not evidence about the test.
   *  `"process-timeout"` is kept: that run really did fail. */
  endedBy?: "user" | "process-timeout";
  datasetId?: string;
  datasetName?: string;
  /** Which engine the run used. Segments the transition count: a test that
   *  fails every time on one engine and passes on the others has changed its
   *  mind zero times, and counting the interleaved sequence said otherwise. */
  runBrowser?: string;
}

/** Reuses run-comparison's vocabulary rather than inventing a second one for
 *  the same idea — two words for "it worked and now it doesn't" is how a
 *  codebase ends up with two subtly different definitions of it. */
export type StabilityVerdict =
  | "stable"
  | "still-failing"
  | "changed-since"
  | "fixed"
  | "flaky"
  | "data-dependent"
  /** Fails on some engines and passes on others, consistently on each. */
  | "browser-dependent"
  | "unknown";

export declare const MIN_RUNS_FOR_VERDICT: number;

export interface StepFlake {
  stepId: string;
  label: string;
  /** runs in which this step was the failure point */
  failures: number;
  /** runs in which run-time Auto-Heal had to substitute a locator here */
  heals: number;
  /** share (0–1) of analysed runs where this step failed */
  failureRate: number;
}

export interface FailureCluster {
  /** normalized error signature — the grouping key */
  signature: string;
  /** a real example, unnormalized, so it's recognizable */
  example: string;
  /** step this failure was attributed to, when known */
  stepId?: string;
  stepLabel?: string;
  count: number;
  /** most recent run exhibiting it */
  lastSeenAt: number;
  runIds: string[];
}

export interface TestFlake {
  testId: string;
  testName: string;
  runs: number;
  passed: number;
  failed: number;
  /** Consecutive-run disagreements, counted WITHIN each engine and summed —
   *  a chromium pass followed by a webkit failure is not the test changing its
   *  mind. */
  transitions: number;
  /** transitions / adjacent same-engine pairs: 0 = never changed its mind,
   *  1 = alternates. The denominator follows the segmentation, or three engines
   *  would report a third of the real rate. */
  flakeRate: number;
  verdict: StabilityVerdict;
  /** dataset rows that failed at least once, when the failures are confined to
   *  specific rows — the evidence behind a "data-dependent" verdict */
  failingDatasets: { id: string; name: string; failed: number; runs: number }[];
  /** Engines this test has failed on, with how often — the evidence behind a
   *  "browser-dependent" verdict, and worth showing on its own when the pattern
   *  is not clean enough to earn one. */
  failingBrowsers: { browser: string; failed: number; runs: number }[];
  /** steps that failed or needed healing, worst first */
  steps: StepFlake[];
  /** runs where Auto-Heal substituted a locator */
  healedRuns: number;
}

export interface FlakeReport {
  tests: TestFlake[];
  clusters: FailureCluster[];
  /** tests with enough runs to have a verdict at all */
  analysedTests: number;
}

/** What the analysis needs to know about one run beyond its record. */
export interface RunDetail {
  runId: string;
  /** stepId of the failure point, from the run's replay */
  failedStepId?: string;
  failedStepLabel?: string;
  /** first error line from the run log, unnormalized */
  error?: string;
  /** step ids run-time Auto-Heal substituted a locator for */
  healedStepIds?: string[];
}

export declare function countTransitions(
  statuses: readonly ("passed" | "failed")[],
): number;

export declare function analyseFlake(
  records: readonly FlakeRun[],
  details?: readonly RunDetail[],
): FlakeReport;

export declare function errorSignature(raw: string | undefined): string;
