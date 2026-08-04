// Mirror of main/recorder/types.ts for the renderer. Keep shapes in sync.

export type StepType =
  | "goto"
  | "click"
  | "fill"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "assert"
  | "wait"
  | "viewport"
  | "if"
  | "endif";

/** Predicate for an `if` step. Element conditions use `Step.locator`; page
 *  conditions (urlContains/titleContains) use `Step.value` as the substring. */
export type ConditionKind =
  | "visible"
  | "hidden"
  | "exists"
  | "enabled"
  | "disabled"
  | "checked"
  | "unchecked"
  | "urlContains"
  | "titleContains";

export type LocatorKind = "testid" | "role" | "label" | "placeholder" | "text" | "css" | "xpath";

export interface Locator {
  k: LocatorKind;
  v?: string;
  role?: string;
  name?: string;
}

export type AssertKind =
  | "visible"
  | "hidden"
  | "text"
  | "exactText"
  | "enabled"
  | "disabled"
  | "checked"
  | "unchecked"
  | "value"
  | "attribute"
  | "count"
  | "url"
  | "urlEndsWith"
  | "urlIs"
  | "title";

export interface Step {
  id: string;
  type: StepType;
  locator?: Locator;
  value?: string;
  label?: string;
  url?: string;
  assert?: AssertKind;
  cond?: ConditionKind;
  text?: string;
  soft?: boolean;
  attr?: string;
  count?: number;
  width?: number;
  height?: number;
  waitMs?: number;
  /** true when the runner should swallow this step's failure and continue to
   *  the next step instead of stopping the test. Emitted as a try/catch wrapper
   *  around the step's line in the generated spec. */
  continueOnFailure?: boolean;
  /** true when the user disabled this step — the runner skips it (logging
   *  why) and the generated spec emits the line commented out. The step stays
   *  in the list and keeps its index/position. */
  disabled?: boolean;
  timestamp: number;
}

/** Payload for a manually-added or AI-generated step (no id/timestamp yet). */
export interface RawStep {
  type: StepType;
  locator?: Locator;
  value?: string;
  label?: string;
  url?: string;
  assert?: AssertKind;
  cond?: ConditionKind;
  text?: string;
  soft?: boolean;
  attr?: string;
  count?: number;
  width?: number;
  height?: number;
  waitMs?: number;
}

export type TestSpeed = "slow" | "medium" | "fast";

export interface TestRecord {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  steps: Step[];
  scriptPath: string;
  scriptEdited?: boolean;
  speed?: TestSpeed;
  sourceDir?: string;
  hidden?: boolean;
  stepsDiverged?: boolean;
  /** Per-test screenshot-capture preference (mirrors main TestRecord). */
  captureArtifacts?: boolean;
  /** Per-test headless-run preference (mirrors main TestRecord). */
  runHeadless?: boolean;
}

/** A single completed test run (mirror of main/recorder/types.ts RunRecord). */
export type RunRecordKind = "run" | "baseline-update";

export interface RunRecord {
  id: string;
  testId: string;
  testName: string;
  url: string;
  status: "passed" | "failed";
  exitCode: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  logFile: string;
  logBytes: number;
  captureArtifacts?: boolean;
  runHeadless?: boolean;
  /** ms spent taking screenshots, and how many — capture runs only. */
  captureOverheadMs?: number;
  shotCount?: number;
  kind?: RunRecordKind;
  note?: string;
}

/** Per-run visual-testing replay model (mirror of main/services/artifact-store.ts). */
export type ReplayStepStatus = "passed" | "failed" | "skipped" | "unknown";

/** Visual-diff outcome for a step (Phase 3). */
export type VisualDiffState = "new-baseline" | "match" | "changed" | "unable";

export interface VisualDiff {
  state: VisualDiffState;
  /** fraction of pixels changed (0–1), for match/changed. */
  ratio?: number;
  /** threshold (percent, 0–100) this step was compared at. */
  threshold?: number;
  /** why the comparison couldn't run, for state "unable". */
  reason?: string;
  /** diff-overlay filename (e.g. "3.diff.png") in the run dir, for "changed". */
  diffFile?: string;
  /** how many ignore masks were applied to this step's comparison, when any. */
  maskedCount?: number;
}

export interface ReplayStep {
  index: number;
  /** stable Step.id — the key baselines are pinned under. */
  stepId: string;
  label: string;
  type: string;
  status: ReplayStepStatus;
  /** filename within the run dir (e.g. "3.png"), or null when uncaptured. */
  screenshot: string | null;
  diff?: VisualDiff;
}

export interface RunReplay {
  testId: string;
  runId: string;
  testName: string;
  url?: string;
  status: "passed" | "failed";
  startedAt: number;
  finishedAt: number;
  failedIndex: number | null;
  visualThreshold?: number;
  steps: ReplayStep[];
}

export interface RunReplaySummary {
  testId: string;
  runId: string;
  testName: string;
  status: "passed" | "failed";
  startedAt: number;
  finishedAt: number;
  stepCount: number;
  failedIndex: number | null;
  changedSteps: number;
}

/** A rectangular region excluded from visual diffing. Coordinates are
 *  normalized (0–1) so masks survive viewport changes. `stepId: null` means
 *  the mask applies to every step. Mirror of main/recorder/types.ts VisualMask. */
export interface VisualMask {
  id: string;
  stepId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

/** What screenshot capture costs, measured from run history. Mirror of
 *  main/services/capture-overhead.ts CaptureOverheadSummary. */
export interface CaptureOverheadSummary {
  capturedRuns: number;
  uncapturedRuns: number;
  meanCaptureMs: number;
  meanMsPerShot: number;
  meanCapturedDurationMs: number;
  meanUncapturedDurationMs: number | null;
  captureShareOfRun: number;
  totalShots: number;
}

/** On-disk footprint of all captured artifacts. Mirror of
 *  main/services/artifact-store.ts ArtifactUsage. */
export interface ArtifactUsage {
  bytes: number;
  runs: number;
  tests: number;
}

/** A user-authored note on a replay step (Phase 4). Mirror of
 *  main/services/annotation-store.ts Annotation. */
export interface Annotation {
  id: string;
  testId: string;
  runId: string;
  stepId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** A hit from searching the raw run logs. */
export interface LogSearchResult {
  runId: string;
  testName: string;
  status: "passed" | "failed";
  startedAt: number;
  matchCount: number;
  snippet: string;
}

export interface PickedElement {
  tag: string;
  description: string;
  candidates: Locator[];
  css: Record<string, string>;
  attributes: Record<string, string>;
}

export interface RecorderSettings {
  showUrlBar: boolean;
  defaultRunSpeed: TestSpeed;
  /** Auto-Heal engine enabled (default true). */
  autoHealEnabled: boolean;
  /** how many heal attempts before giving up (default 3). */
  autoHealRetries: number;
  /** per-attempt timeout in ms (default 4000). */
  autoHealAttemptTimeoutMs: number;
  /** default value of the per-test "Capture screenshots" toggle (default false). */
  defaultCaptureArtifacts: boolean;
  /** default value of the per-test "Run headless" toggle (default false). */
  defaultRunHeadless: boolean;
  /** how many runs' screenshot artifacts to keep per test (default 10, 1–50). */
  artifactRetainedRuns: number;
  /** also delete captured runs older than N days (0 = off, max 365). */
  artifactRetentionDays: number;
  /** IDs of aesthetic enhancement features the user has disabled.
   *  Empty = all enabled. Known IDs: "aiThinkingGif". */
  disabledAestheticEnhancements: string[];
}

/** A single alternative locator the Auto-Heal engine found for a failed step.
 *  Mirror of main/recorder/types.ts HealCandidate. */
export interface HealCandidate {
  locator: Locator;
  description: string;
  score: number;
  matchedPastRun: boolean;
}

/** Result of a heal attempt for a single failed step. Mirror of backend
 *  HealResult, with an added `autoApplied` flag from the push event. */
export interface HealSuggestion {
  stepId: string;
  stepIndex: number;
  stepLabel: string;
  originalLocator?: Locator;
  candidates: HealCandidate[];
  attempts: number;
  ok: boolean;
  appliedLocator?: Locator;
  autoApplied: boolean;
  error?: string;
}

/** Payload pushed from the backend when the user picks an item from the
 *  right-click test-tools menu in the training browser. Mirrors the backend
 *  `ContextAction` in main/services/recorder-service.ts. */
export interface ContextAction {
  kind: "assertion" | "wait" | "goto" | "press" | "viewport" | "find" | "refine";
  assert?: AssertKind;
  waitMode?: "element" | "hidden" | "time";
  picked: PickedElement | null;
  prefillText: string;
  prefillValue: string;
}

/** A single verbose diagnostic line produced while replaying a step. */
export interface DebugLogLine {
  i: number;
  t: number;
  level: "info" | "warn" | "error";
  m: string;
}

/** Live streaming event pushed during a "Replay from current step" run, so the
 *  debug panel's Console tab can show each step's output as it runs. */
export type ReplayLogEvent =
  | { phase: "start"; startIndex: number; total: number }
  | { phase: "step"; index: number; stepLabel: string; ok: boolean; error?: string; logs: DebugLogLine[]; heal?: HealSuggestion }
  | { phase: "done"; ran: number; passed: number; failedAtIndex: number; error?: string };

/** Persisted debug entry for a single step's replay attempt. */
export interface DebugEntry {
  stepId: string;
  stepIndex: number;
  stepLabel: string;
  ok: boolean;
  error?: string;
  at: number;
  logs: DebugLogLine[];
}

export interface RecorderState {
  recording: boolean;
  paused: boolean;
  assertMode: AssertKind | null;
  stepCount: number;
  testId: string | null;
  url: string | null;
  name: string | null;
  editing: boolean;
  assertSoft: boolean;
  cursor: number;
  refineMode: boolean;
  /** true once the trainer browser window has finished loading its first page */
  pageReady: boolean;
  /** true while the training browser window is opening but hasn't shown yet. */
  loading: boolean;
  /** set when the training window failed to open within the timeout. */
  loadFailed: boolean;
}
