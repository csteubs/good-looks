// Mirror of main/recorder/types.ts for the renderer. Keep shapes in sync.

import type { LlmErrorKind } from "./llm-types";

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
  | "runFlow"
  | "state";

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

/** Predicate a `wait` step blocks on until it holds (mirror of main types).
 *  A superset of ConditionKind, kept separate on purpose so widening the wait
 *  vocabulary can't silently widen what an `if` condition accepts. */
export type WaitUntilKind =
  | "visible"
  | "hidden"
  | "exists"
  | "enabled"
  | "disabled"
  | "checked"
  | "unchecked"
  | "text"
  | "value"
  | "count"
  | "urlContains"
  | "titleContains";

/** How the Add-wait dialog is opened from outside itself (the training
 *  browser's right-click menu). "hidden" preselects a Wait Until on the
 *  `hidden` predicate — before conditional waits existed it collapsed into the
 *  plain element wait, which generates `.waitFor()` and so waited for the
 *  element to become VISIBLE: the opposite of what was picked, with nothing on
 *  screen to say so. Mirror of the `waitMode` union in
 *  main/services/recorder-service.ts. */
export type WaitDialogMode = "element" | "hidden" | "time" | "until";

/** Mirror of DEFAULT_WAIT_TIMEOUT_MS in main/services/script-generator.ts.
 *  Pinned to the backend's value by describe-step-parity.test.ts, which covers
 *  a wait-until step with no explicit timeout — if the two drift, the trainer's
 *  step list and the run log quote different timeouts for the same step. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

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
  | "title"
  | "css";

/** Pseudo-state a `state` step applies (mirror of main types).
 *
 *  `:active` and `:focus-visible` are deliberately NOT members: each needs two
 *  Playwright calls, and a step emits exactly one awaited statement. The
 *  Add-step dialog composes them out of several ordinary rows instead — see the
 *  doc comment on `ElementState` in main/recorder/types.ts. */
export type ElementState = "hover" | "focus" | "press" | "release";

export const ELEMENT_STATES: ElementState[] = ["hover", "focus", "press", "release"];

/** How a `css` assertion compares (mirror of main types). */
export type CssMatch = "is" | "contains";

/** Labels for the element-state picker. The four entries the USER picks are not
 *  the four `ElementState` members — two of them expand to several steps. */
export const ELEMENT_STATE_LABELS: Record<ElementState, string> = {
  hover: "Hover over element",
  focus: "Focus element",
  press: "Press and hold mouse",
  release: "Release mouse",
};

/** The properties the CSS-assertion picker offers with the element's live
 *  computed value beside each (mirror of CSS_ASSERT_PROPS in main types).
 *  KEBAB-case: `getComputedStyle().getPropertyValue()` answers "" for a
 *  camelCase name, on both the capture side and inside Playwright's toHaveCSS.
 *  Pinned against the backend list by check:css-assertions. */
export const CSS_ASSERT_PROPS: string[] = [
  "color",
  "background-color",
  "opacity",
  "border-color",
  "border-width",
  "border-radius",
  "box-shadow",
  "outline-color",
  "font-size",
  "font-weight",
  "font-family",
  "text-decoration",
  "letter-spacing",
  "cursor",
  "display",
  "visibility",
  "width",
  "height",
  "padding",
  "margin",
  "transform",
  "z-index",
];

/** A syntactically valid CSS property name (mirror of main types). The renderer
 *  copy exists so the dialog can refuse a malformed free-text property with a
 *  message, rather than posting it and having the boundary drop it silently. */
export function isCssPropName(v: unknown): v is string {
  return typeof v === "string" && v.length <= 100 && /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/.test(v);
}

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
  /** KEBAB-case CSS property for a "css" assertion, the match mode, and the
   *  pseudo-state a `state` step applies (mirror of main types). */
  cssProp?: string;
  cssMatch?: CssMatch;
  elementState?: ElementState;
  count?: number;
  width?: number;
  height?: number;
  waitMs?: number;
  /** predicate a `wait` step blocks on, and how long it waits before failing
   *  (mirror of main types). */
  waitUntil?: WaitUntilKind;
  timeoutMs?: number;
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
  /** the target element's recorded identity (mirror of main types). */
  fingerprint?: ElementFingerprint;
  timestamp: number;
}

/** The recorded identity of a step's target element (mirror of main types).
 *  Feeds Auto-Heal's candidate scoring. */
export interface ElementFingerprint {
  tag: string;
  description: string;
  candidates: Locator[];
  attributes: Record<string, string>;
  text?: string;
  neighborText?: string;
  depth: number;
  rect?: { x: number; y: number; w: number; h: number };
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
  cssProp?: string;
  cssMatch?: CssMatch;
  elementState?: ElementState;
  count?: number;
  width?: number;
  height?: number;
  waitMs?: number;
  waitUntil?: WaitUntilKind;
  timeoutMs?: number;
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

export type TestSpeed = "crawl" | "slow" | "medium" | "fast";

/** Every speed, SLOWEST FIRST (mirror of main types) — the order the sidebar
 *  slider's stops are in. Every picker derives its list from this rather than
 *  re-declaring one, so a new speed appears in all of them at once. */
export const TEST_SPEEDS: TestSpeed[] = ["crawl", "slow", "medium", "fast"];

/** Display labels for the speed pickers. */
export const TEST_SPEED_LABELS: Record<TestSpeed, string> = {
  crawl: "Crawl",
  slow: "Slow",
  medium: "Medium",
  fast: "Fast",
};

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
  /** Why the steps and the script disagree (mirrors main TestRecord).
   *  `"parse"`: statements in the script couldn't be mapped back into steps.
   *  `"unapplied"`: edited steps were saved but the script wasn't regenerated
   *  from them. Absent on older records — read that as `"parse"`. */
  stepsDivergedReason?: "parse" | "unapplied";
  /** Per-test screenshot-capture preference (mirrors main TestRecord). */
  recordLogs?: boolean;
  captureArtifacts?: boolean;
  /** Per-test headless-run preference (mirrors main TestRecord). */
  runHeadless?: boolean;
  /** Per-test browser-engine preference (mirrors main TestRecord). */
  runBrowser?: RunBrowser;
  /** Per-test Playwright timeout in ms (mirrors main TestRecord). When absent,
   *  the global default from Settings applies. */
  testTimeoutMs?: number;
  /** Per-test accessibility-check preference (mirrors main TestRecord). */
  a11yChecks?: boolean;
  /** Violations accepted for this test, keyed by step id. */
  a11yBaseline?: Record<string, string[]>;
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

/** What a successful Auto-Heal may do to the stored test (mirror of main types). */
export type HealApplyMode = "suggest" | "apply";

/** What happened to a proposed heal (mirror of heal-journal-store.ts). */
export type HealStatus = "pending" | "accepted" | "reverted";

/** One recorded Auto-Heal, and the means to undo it. */
export interface HealEntry {
  id: string;
  testId: string;
  stepId: string;
  stepIndex: number;
  stepLabel: string;
  source: "trainer" | "run";
  runId?: string;
  originalLocator?: Locator;
  appliedLocator: Locator;
  candidates: HealCandidate[];
  /** whether the stored test was actually changed. False under "suggest". */
  applied: boolean;
  status: HealStatus;
  at: number;
}

/** Stability verdict for a test (mirror of main/services/flake-analysis.ts).
 *  Shares run-comparison's vocabulary rather than inventing a second one. */
export type StabilityVerdict =
  | "stable"
  | "still-failing"
  | "changed-since"
  | "fixed"
  | "flaky"
  | "data-dependent"
  | "unknown";

export interface StepFlake {
  stepId: string;
  label: string;
  failures: number;
  heals: number;
  failureRate: number;
}

export interface FailureCluster {
  signature: string;
  example: string;
  stepId?: string;
  stepLabel?: string;
  count: number;
  lastSeenAt: number;
  runIds: string[];
}

export interface TestFlake {
  testId: string;
  testName: string;
  runs: number;
  passed: number;
  failed: number;
  transitions: number;
  flakeRate: number;
  verdict: StabilityVerdict;
  failingDatasets: { id: string; name: string; failed: number; runs: number }[];
  steps: StepFlake[];
  healedRuns: number;
}

export interface FlakeReport {
  tests: TestFlake[];
  clusters: FailureCluster[];
  analysedTests: number;
  /** how many runs the analysis actually looked at, and the cap it uses */
  windowRuns: number;
  windowCap: number;
}

/** One captured window (mirror of main/services/debug-capture.ts). */
export interface DebugShot {
  file: string;
  window: string;
  width: number;
  height: number;
}

/** One debug capture — a press or a request, and the windows it produced. */
export interface DebugCaptureSession {
  id: string;
  at: number;
  reason: "shortcut" | "request" | "manual";
  shots: DebugShot[];
  error?: string;
}

/** A heal as the cross-test Heals view sees it: the entry plus the name of the
 *  test it came from, or null when that test has since been deleted. */
export interface HealListEntry extends HealEntry {
  testName: string | null;
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
  /** playback speed this run executed at. Absent on runs predating the field —
   *  which means UNKNOWN, not "fast": speed is a per-test setting the user
   *  changes between runs, so an older run could have been any of them. */
  speed?: TestSpeed;
  /** id of the batch this run belonged to, when it was part of one. */
  batchId?: string;
  /** how many steps run-time Auto-Heal got past by substituting a locator. */
  healedSteps?: number;
  /** accessibility-check cost, and steps with unaccepted violations. */
  a11yMs?: number;
  a11yChecks?: number;
  a11yNewSteps?: number;
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

/** One accessibility violation, compacted by the capture fixture
 *  (mirror of main/services/a11y-diff.ts). */
export interface A11yViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical";
  help: string;
  nodes: string[];
}

/** A step's accessibility outcome, after comparison with the accepted
 *  baseline. `newKeys` is what the UI flags; everything else is context. */
export interface A11yResult {
  violations: A11yViolation[];
  newKeys: string[];
  acceptedCount: number;
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
  /** accessibility outcome for this step, when a11y checks ran. */
  a11y?: A11yResult;
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
  /** how many steps reported unaccepted accessibility violations. */
  a11yNewSteps?: number;
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
  /** runs that ran accessibility checks and reported a timing */
  a11yRuns: number;
  meanA11yMs: number;
  meanMsPerA11yCheck: number;
  a11yShareOfRun: number;
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

/** One test's row in the Batch view (mirrors main types). An ABSENT entry is
 *  the default — unticked, the test's own runBrowser, defaultRunHeadless.
 *  `browsers` is never empty: a zero-engine row silently doesn't run. */
export interface BatchRowOptions {
  selected: boolean;
  browsers: RunBrowser[];
  headless: boolean;
}

export const MAX_BATCH_TEST_OPTIONS = 1000;

export interface RecorderSettings {
  showUrlBar: boolean;
  /** Open the trainer panel docked beside the training browser (default false). */
  trainerPanelEnabled: boolean;
  defaultRunSpeed: TestSpeed;
  /** browser window size for new recordings, or null for the trainer's own
   *  default (mirror of main types). Also recorded as the test's first
   *  `viewport` step so it replays at the size it was recorded at. */
  defaultWindowSize: { width: number; height: number } | null;
  /** Auto-Heal engine enabled (default true). */
  autoHealEnabled: boolean;
  /** how many heal attempts before giving up (default 3). */
  autoHealRetries: number;
  /** per-attempt timeout in ms (default 4000). */
  autoHealAttemptTimeoutMs: number;
  /** What a successful heal may do to the stored test (mirror of main types).
   *  "suggest" (default) records it for review; "apply" writes it immediately. */
  autoHealApply: HealApplyMode;
  /** default value of the per-test "Check accessibility" toggle. */
  defaultA11yChecks: boolean;
  /** listen for screenshot requests from an MCP client (default false). */
  debugScreenshots: boolean;
  /** default value of the per-test "Capture screenshots" toggle (default false). */
  defaultCaptureArtifacts: boolean;
  defaultRecordLogs: boolean;
  recordAllHeaders: boolean;
  keepRunningAiDebugJobs: boolean;
  /** default value of the per-test "Run headless" toggle (default false). */
  defaultRunHeadless: boolean;
  /** default browser engine for tests with no preference (default "chromium"). */
  defaultRunBrowser: RunBrowser;
  /** default Playwright per-test timeout in ms (default 60000 = 1 minute). */
  defaultTestTimeoutMs: number;
  /** send a summary to a configured webhook on run/batch problems (default false). */
  alertWebhookEnabled: boolean;
  /** user-chosen Batch run order, as test ids (mirrors main types) */
  batchOrder: string[];
  /** per-row Batch-view options by test id (mirrors main types). An absent
   *  entry is the default — see BatchRowOptions. */
  batchTestOptions: Record<string, BatchRowOptions>;
  /** how many tests a batch starts at once by default (default 1, 1–16). */
  defaultBatchConcurrency: number;
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
  kind: "assertion" | "wait" | "goto" | "press" | "viewport" | "find" | "refine" | "elementState";
  assert?: AssertKind;
  /** pseudo-state to preselect when kind === "elementState" (mirror of main). */
  elementState?: "hover" | "focus";
  waitMode?: WaitDialogMode;
  picked: PickedElement | null;
  prefillText: string;
  prefillValue: string;
  /** Which trainer window should act on this — the event is broadcast to both,
   *  and unaddressed it would open two prefilled dialogs for one right-click.
   *  Absent means "main". */
  target?: TrainerTarget;
}

/** The two windows that can host a trainer. */
export type TrainerTarget = "main" | "panel";

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
  /** true while a replay is running steps against the training window. Both
   *  trainer windows disable their controls on it — see the note on the mirror
   *  of this interface in main/recorder/types.ts. */
  replaying: boolean;
  /** true once the trainer browser window has finished loading its first page */
  pageReady: boolean;
  /** true while the training browser window is opening but hasn't shown yet. */
  loading: boolean;
  /** set when the training window failed to open within the timeout. */
  loadFailed: boolean;
}

// ── Batch (suite) runs ────────────────────────────────────────────────
// Mirrors main/services/batch-runner.ts. A batch drives ordinary runs — one at
// a time by default, up to `concurrency` at a time when asked; each test still
// writes its own RunRecord, so a batch shows up in Stats as normal runs rather
// than a separate kind of history.

export type BatchTestStatus = "pending" | "running" | "passed" | "failed" | "skipped";

/** Mirror of main/recorder/types.ts. Both halves must agree: the renderer warns
 *  about a number the BACKEND is going to clamp, so if these drift the dialog
 *  names a count that never happens. */
export const MAX_BATCH_CONCURRENCY = 16;
export const HEADED_PARALLEL_WARN = 10;

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
  /** engine this entry ran on, when the batch fanned the test out across more
   *  than one (mirrors main types; absent on pre-fan-out history records) */
  browser?: RunBrowser;
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

// ── AI debug sessions (mirror of main/recorder/types.ts) ─────────────

export type AiDebugStatus =
  | "idle"
  | "streaming"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

export interface ConsoleEntry {
  step: number;
  ts: number;
  type: string;
  text: string;
  url: string;
  line: number;
}

export interface NetworkEntry {
  step: number;
  ts: number;
  ms: number;
  method: string;
  url: string;
  resourceType: string;
  status: number;
  ok: boolean;
  failure?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export interface RunLogs {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  consoleDropped: number;
  networkDropped: number;
  headersFiltered: boolean;
}

export type AiDebugKind = "run" | "step";

export interface AiDebugSession {
  key: string;
  kind: AiDebugKind;
  testId: string;
  label: string;
  testName: string;
  status: AiDebugStatus;
  content: string;
  reasoning: string;
  error: string | null;
  /** Which kind of failure `error` was, so the UI offers the right fix without
   *  re-deriving it from the message text. Absent on sessions stored before
   *  kinds existed. */
  errorKind?: LlmErrorKind | null;
  requestId: string | null;
  /** Identifies the RUN this session describes — the artifact id, or a hash of
   *  the run output before one exists. A session is about one execution, not
   *  about a test in general: reopening the panel after a re-run must not show
   *  a diagnosis of output that is no longer on screen. */
  runKey?: string | null;
  /** True when this session outlived the run it describes — kept alive only
   *  because it was still streaming and the user opted to preserve running
   *  jobs. Everything showing it must say so: its answer is about output that
   *  is no longer on screen. */
  superseded?: boolean;
  scriptHash: string | null;
  startedAt: number;
  updatedAt: number;
  readOnly?: boolean;
}
