// Types for run-comparison.mjs. See run-pacing.d.mts for why these are
// hand-written.
//
// The replay model is typed structurally rather than imported from
// artifact-store.ts: that module reaches @glaze/core/backend, and shared/ does
// not import anything that does. Only the fields this comparison reads are
// declared, which is also the honest description of what it needs.

export type ReplayStepStatus = "passed" | "failed" | "skipped" | "unknown";
export type VisualDiffState = "new-baseline" | "match" | "changed" | "unable";
export type StepDelta = "stable" | "fixed" | "changed-since" | "still-failing" | "unknown";

export interface ComparableStep {
  stepId: string;
  label: string;
  status: ReplayStepStatus;
  diff?: { state: VisualDiffState };
}

export interface ComparableReplay {
  testId: string;
  runId: string;
  steps: ComparableStep[];
}

export interface StepComparison {
  stepId: string;
  label: string;
  before: ReplayStepStatus;
  after: ReplayStepStatus;
  delta: StepDelta;
  /** visual outcome of the re-run, when it captured one */
  visual?: VisualDiffState;
}

export interface RunComparison {
  testId: string;
  baseRunId: string;
  replayRunId: string;
  steps: StepComparison[];
  /** steps that worked before and don't now — the ones worth looking at */
  changedSinceCount: number;
  fixedCount: number;
  /** true when the step lists don't line up (the test was edited between runs) */
  stepsDiverged: boolean;
}

export declare function compareReplays(
  base: ComparableReplay | null | undefined,
  replay: ComparableReplay | null | undefined,
): RunComparison | null;
