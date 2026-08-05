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
  | "endif"
  | "cookie"
  | "capture"
  | "runFlow";

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
  /** what a `cookie` step does (mirrors main types) */
  cookieAction?: CookieAction;
  /** the cookie a `cookie` step sets or deletes (absent for clearAll) */
  cookie?: CookieSpec;
  /** true when the runner should swallow this step's failure and continue to
   *  the next step instead of stopping the test. Emitted as a try/catch wrapper
   *  around the step's line in the generated spec. */
  continueOnFailure?: boolean;
  /** true when the user disabled this step — the runner skips it (logging
   *  why) and the generated spec emits the line commented out. The step stays
   *  in the list and keeps its index/position. */
  disabled?: boolean;
  /** capture/flow fields (mirror of main types) */
  captureVar?: string;
  captureFrom?: CaptureSource;
  captureAttr?: string;
  flowId?: string;
  flowArgs?: Record<string, string>;
  /** variable names this step interpolates; derived backend-side on write. */
  varRefs?: string[];
  timestamp: number;
}

/** What a `capture` step reads off its resolved element (mirror of main types). */
export type CaptureSource = "text" | "value" | "attribute" | "url" | "title";

export const CAPTURE_SOURCES: CaptureSource[] = ["text", "value", "attribute", "url", "title"];

/** Display labels for the capture-source picker. */
export const CAPTURE_SOURCE_LABELS: Record<CaptureSource, string> = {
  text: "Text content",
  value: "Input value",
  attribute: "Attribute",
  url: "Page URL",
  title: "Page title",
};

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
  /** cookie fields, so a cookie step can be inserted via insertStep */
  cookieAction?: CookieAction;
  cookie?: CookieSpec;
  /** capture/flow fields, so those steps can be inserted via insertStep */
  captureVar?: string;
  captureFrom?: CaptureSource;
  captureAttr?: string;
  flowId?: string;
  flowArgs?: Record<string, string>;
}

export type TestSpeed = "slow" | "medium" | "fast";

/** Playwright browser engine a test run uses (mirror of main types).
 *  The trainer uses the app's own WebView and is unaffected. */
export type RunBrowser = "chromium" | "firefox" | "webkit";

export const RUN_BROWSERS: RunBrowser[] = ["chromium", "firefox", "webkit"];

/** Display labels for the browser pickers. */
export const RUN_BROWSER_LABELS: Record<RunBrowser, string> = {
  chromium: "Chromium",
  firefox: "Firefox",
  webkit: "WebKit",
};

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
  /** Per-test browser-engine preference (mirrors main TestRecord). */
  runBrowser?: RunBrowser;
  /** Free-form grouping labels (mirrors main TestRecord). Normalized backend-
   *  side on write, so the renderer never has to canonicalize them itself. */
  tags?: string[];
  /** Named values this test's steps interpolate with `${name}` (mirrors main
   *  TestRecord). A secret variable never carries its value here. */
  variables?: TestVariable[];
  /** Rows of variable values this test can be swept over. */
  datasets?: Dataset[];
  /** true when this test is a reusable flow, inlined into other tests. */
  isFlow?: boolean;
  /** parameter names a flow accepts. */
  flowParams?: string[];
}

/** How a variable's value is sourced (mirror of main types). */
export type VariableKind = "plain" | "secret" | "captured";

export const VARIABLE_KINDS: VariableKind[] = ["plain", "secret", "captured"];

export const VARIABLE_KIND_LABELS: Record<VariableKind, string> = {
  plain: "Value",
  secret: "Secret",
  captured: "Captured at run time",
};

export interface TestVariable {
  name: string;
  value?: string;
  kind: VariableKind;
  description?: string;
}

/** One row of variable values a test can be swept over (mirror of main types). */
export interface Dataset {
  id: string;
  name: string;
  values: Record<string, string>;
}

/** What the renderer is allowed to know about a stored secret: that it exists,
 *  never what it is. The value lives encrypted backend-side and is injected
 *  straight into the run's child process. */
export interface SecretStatus {
  name: string;
  hasValue: boolean;
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
  /** browser engine this run used; absent on runs predating the picker
   *  (all of which ran on chromium). */
  runBrowser?: RunBrowser;
  /** id of the batch this run belonged to, when it was part of one. */
  batchId?: string;
  /** the dataset row this run used, when it was one row of a sweep. */
  datasetId?: string;
  datasetName?: string;
  /** ms spent taking screenshots, and how many — capture runs only. */
  captureOverheadMs?: number;
  shotCount?: number;
  /** id of the run this one re-executed, when it's a re-run. */
  replayOfRunId?: string;
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
  /** "element" when the step was compared element-scoped rather than page-wide. */
  scope?: "page" | "element";
}

/** A normalized (0–1) rectangle in page/viewport space. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** the acted-on element's normalized rect at capture time, when recorded. */
  rect?: NormalizedRect;
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

/** A pinned visual baseline. Mirror of main/services/baseline-store.ts. */
export interface BaselineEntry {
  stepId: string;
  runId: string;
  at: number;
  label: string;
  rect?: NormalizedRect;
}

/** Then-vs-now comparison of a past run and a re-run of it. Mirror of
 *  main/services/run-comparison.ts. */
export type StepDelta = "stable" | "fixed" | "changed-since" | "still-failing" | "unknown";

export interface StepComparison {
  stepId: string;
  label: string;
  before: ReplayStepStatus;
  after: ReplayStepStatus;
  delta: StepDelta;
  visual?: VisualDiffState;
}

export interface RunComparison {
  testId: string;
  baseRunId: string;
  replayRunId: string;
  steps: StepComparison[];
  changedSinceCount: number;
  fixedCount: number;
  stepsDiverged: boolean;
}

/** What a retention sweep deleted. Mirror of main/services/retention.ts. */
export interface RetentionResult {
  removedRuns: number;
  freedBytes: number;
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
  /** default browser engine for tests with no preference (default "chromium"). */
  defaultRunBrowser: RunBrowser;
  /** send a summary to a configured webhook on run/batch problems (default false). */
  alertWebhookEnabled: boolean;
  /** user-chosen Batch run order, as test ids (mirrors main types) */
  batchOrder: string[];
  /** how many runs' screenshot artifacts to keep per test (default 10, 1–50). */
  artifactRetainedRuns: number;
  /** also delete captured runs older than N days (0 = off, max 365). */
  artifactRetentionDays: number;
  /** notify on macOS when a run fails or shows a visual change (default false). */
  notifyOnRunIssues: boolean;
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

// ── Batch (suite) runs ────────────────────────────────────────────────
// Mirrors main/services/batch-runner.ts. A batch drives ordinary runs
// sequentially; each test still writes its own RunRecord, so a batch shows up
// in Stats as normal runs rather than a separate kind of history.

export type BatchTestStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface BatchTestResult {
  testId: string;
  testName: string;
  status: BatchTestStatus;
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  /** why a test was skipped, or why it failed to start */
  note?: string;
  /** id of the RunRecord this test produced, for linking to its log */
  runRecordId?: string;
}

export interface BatchSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
  durationMs: number;
}

export interface BatchState {
  batchId: string;
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  /** index in `results` currently executing, or -1 when idle */
  currentIndex: number;
  results: BatchTestResult[];
  /** the user stopped the batch partway */
  stopped: boolean;
  summary: BatchSummary;
}

/** A batch as persisted to batch-history.json — same shape as the live state,
 *  so a restored batch renders identically to a running one. */
export type BatchRecord = BatchState;

// ── Cookies (mirror of main/recorder/types.ts) ───────────────────────

export type CookieAction = "set" | "delete" | "clearAll";

/** Chromium sameSite spelling — NOT Playwright's ("Strict"/"Lax"/"None"). */
export type CookieSameSite = "unspecified" | "no_restriction" | "lax" | "strict";

export interface CookieSpec {
  name: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: CookieSameSite;
  /** unix seconds; omit for a session cookie */
  expirationDate?: number;
  url?: string;
}

/** A live cookie read back from the training browser's session. */
export interface LiveCookie extends CookieSpec {
  hostOnly?: boolean;
  session?: boolean;
}
