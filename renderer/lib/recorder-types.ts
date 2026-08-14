// Mirror of main/recorder/types.ts for the renderer. Keep shapes in sync.

import type { LlmErrorKind } from "./llm-types";
import type { FlakeReport as SharedFlakeReport } from "../../shared/flake-analysis.mjs";
import type { CostCurrency } from "../../shared/cost-units.mjs";

export type { CostCurrency };

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
  // `title` is exact ("Page title is"); `titleContains` is the substring kind
  // the vocabulary was missing. See the note in main/recorder/types.ts.
  | "title"
  | "titleContains"
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

/** How big the app's own interface is drawn, as a zoom factor (mirror of main
 *  types). The backend validates by membership in this exact set before the
 *  number reaches `setZoomFactor` — see `main/recorder/types.ts`. */
export type UiScale = 0.9 | 1 | 1.1 | 1.25;

export const UI_SCALES: UiScale[] = [0.9, 1, 1.1, 1.25];

/** Labels for the size picker.
 *
 *  DELIBERATELY NOT PERCENTAGES. "110%" invites the reading that this is a
 *  precise typographic setting; it is a zoom factor, and what the user is
 *  choosing is how big the app is. Four words say that and survive the value
 *  set changing. */
export const UI_SCALE_LABELS: Record<string, string> = {
  "0.9": "Small",
  "1": "Default",
  "1.1": "Large",
  "1.25": "Larger",
};

/** Which typeface pairing the interface is set in (mirror of main types). */
export type UiTypeface = "space" | "system" | "classic";

export const UI_TYPEFACES: UiTypeface[] = ["space", "system", "classic"];

/** Labels for the typeface picker.
 *
 *  THE FACES, NOT THE PAIRING NAMES. "Space", "System" and "Classic" are what
 *  the values are called in the store and in settings search; they are not what
 *  someone choosing a typeface wants to read, because "System" alone says
 *  nothing about what they are about to get. Second names are dropped where the
 *  family is unambiguous ("Grotesk", "Helvetica") so the longest label still
 *  fits the trigger — a picker whose current value reads "Space — Space Mono /
 *  Space Gr…" tells you less than one that fits. */
export const UI_TYPEFACE_LABELS: Record<UiTypeface, string> = {
  space: "Space Mono / Grotesk",
  system: "SF Mono / SF Pro",
  classic: "Menlo / Helvetica",
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
  /** true when the user dismissed the divergence banner (mirrors main
   *  TestRecord). Cleared backend-side whenever divergence is established
   *  afresh, so the banner returns for a NEW divergence only. */
  stepsDivergedDismissed?: boolean;
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

// The stability vocabulary is the ANALYSIS's, imported rather than restated.
// These were hand-written mirrors of `main/services/flake-analysis.ts`, kept
// honest by an assertion in check:flake-analysis, because a renderer cannot
// import from `main/`. Phase 4 moved the analysis into `shared/`, which the
// renderer CAN import — so the copies are gone, and with them the possibility
// of the Stability tooltips quoting a threshold the analysis no longer uses.
export type {
  FailureCluster,
  StabilityVerdict,
  StepFlake,
  TestFlake,
} from "../../shared/flake-analysis.mjs";
export { MIN_RUNS_FOR_VERDICT } from "../../shared/flake-analysis.mjs";

/** The analysis's report, plus what the IPC handler adds: a truncated history
 *  has to be visible in the UI rather than implied. */
export interface FlakeReport extends SharedFlakeReport {
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

/** Where a whole-script change came from (mirror of script-change-store.ts). */
export type ScriptChangeOrigin = "ai-debug" | "manual";

/** What the renderer sends with a script write, so the journal can say who did
 *  it. `reviewed: false` means the change landed without the user reading it —
 *  an auto-applied AI fix — which is the only thing that enters the review
 *  queue. Normalized backend-side; the renderer's copy is a claim, not a fact. */
export interface ScriptChangeSource {
  by: ScriptChangeOrigin;
  model?: string;
  reviewed?: boolean;
}

/** One recorded change to a test's whole spec, and the means to undo it.
 *
 *  The sibling of `HealEntry`: a heal swaps one step's locator, this replaces
 *  the file. Kept in its own store backend-side — see script-change-store.ts —
 *  and merged with the heals in the Heals surfaces, which is where they are
 *  both just "things that changed this test". */
export interface ScriptChangeEntry {
  id: string;
  testId: string;
  origin: ScriptChangeOrigin;
  /** Which model wrote the fix. May be absent even on an `ai-debug` entry, so
   *  every label must degrade to a bare "AI Debug". */
  model?: string;
  reviewed: boolean;
  /** The previous spec — the undo. Empty when `truncated`. */
  before: string;
  after: string;
  addedLines: number;
  removedLines: number;
  /** The sources were too large to store, so there is nothing to revert TO.
   *  Every Revert control must be disabled on one of these. */
  truncated?: boolean;
  status: HealStatus;
  at: number;
}

/** A script change as the cross-test Heals view sees it — same reason
 *  `HealListEntry` exists. */
export interface ScriptChangeListEntry extends ScriptChangeEntry {
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

/** What an emit reports back. REDESIGN §6.5 — note there is no `text` field
 *  and there is not meant to be: the renderer never holds the emitted bytes,
 *  because redaction happens in the main process and a payload that crossed the
 *  boundary first would be redacted only in a copy. */
export interface EmitResult {
  /** Where it landed, or null when the user cancelled the save dialog. */
  path: string | null;
  bytes: number;
  /** Runs (or metric rows) that went in, so the panel can say what the file
   *  covers rather than leaving the user to guess. */
  count: number;
  cancelled: boolean;
}

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
  /** how many steps Auto-Heal TRIED to rescue and could not. The opposite
   *  evidence to `healedSteps` and the more informative half — a step that
   *  healed says the locator was stale, a step that could not says the element
   *  is gone. Nothing recorded this before 2026-08-07, so absent means UNKNOWN
   *  and never 0 (mirrors main/recorder/types.ts). */
  healFailedSteps?: number;
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
  /** The test this run belonged to has been deleted (mirrors main types). The
   *  record is kept so the aggregate counters hold still; every surface that
   *  NAMES a test filters these out. Its screenshots and raw log are gone. */
  testDeleted?: boolean;
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

/** One measured area of change. Mirror of the backend's own type; kept
 *  structural here so the renderer's record types import nothing from `main/`. */
export interface DiffRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: number;
  share: number;
}

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
  /** Where the change is, largest first — REDESIGN §6.6's "what moved".
   *  Normalized (0–1) against the compared image, like every other rect in
   *  this app, so the viewer can lay a box over the frame at any size.
   *  Recorded only for "changed": it is what the user triages, and a matched
   *  step's sub-threshold specks are noise stored in every replay forever. */
  regions?: DiffRegion[];
  /** Regions found beyond the cap and folded away, so the UI can say "and 12
   *  smaller" rather than implying the list is everything. */
  regionsOmitted?: number;
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
  /** Findings banners the user has waved off for THIS run (mirrors main
   *  RunReplay). Persisted with the run, so it survives selecting another. */
  dismissedNotices?: RunNoticeKind[];
  steps: ReplayStep[];
}

/** The two non-failing findings a run reports, each of which the user can
 *  either accept (resolve for good) or dismiss (acknowledge for this run). */
export type RunNoticeKind = "visual" | "a11y";

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
  /**
   * Fetch a third-party favicon for each site in the library instead of drawing
   * the generated monogram (default false).
   *
   * OFF IS THE HONEST DEFAULT AND HAS TO STAY THAT WAY. Turning it on sends the
   * hostname of every test in the library to icons.duckduckgo.com, on every
   * render of the sidebar — see `SiteIcon` and REDESIGN §3.5. This app's stated
   * egress posture is one opt-in summary-only webhook, so this is the second
   * outbound channel in the product and the only reason it is acceptable is
   * that the user asked for it by name.
   */
  siteIconsFromWeb: boolean;
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
  /** post a macOS notification when a batch finishes, pass or fail (default
   *  true). Suppresses the per-run notification for tests inside a batch. */
  notifyOnBatchDone: boolean;
  /** post a macOS notification when an AI debug job finishes or fails
   *  (default false). */
  notifyOnAiDebugDone: boolean;
  /** EXPERIMENTAL. Auto-apply a finished AI debug job's script fix while its
   *  dialog is minimized, only when the script hasn't changed since the prompt
   *  was sent (default false). */
  autoAcceptAiDebugFixes: boolean;
  /** IDs of aesthetic enhancement features the user has disabled.
   *  Empty = all enabled. Known IDs: "aiThinkingGif". */
  disabledAestheticEnhancements: string[];
  /** How big the app's interface is drawn (default 1 = 100%). A zoom factor
   *  applied to the app's own windows in the main process — not a font size,
   *  and never applied to the training browser. */
  uiScale: UiScale;
  /** Which typeface pairing the interface is set in (default "space"). Read by
   *  `lib/typeface.ts`, which writes it to `data-gl-typeface` on the document
   *  element; the families themselves live in `renderer/theme/tokens.css`. */
  uiTypeface: UiTypeface;
  /** Which symbol the Cost panel stamps on a money figure (default "usd").
   *  "none" restores bare numbers — see `shared/cost-units.mjs`. */
  costCurrency: CostCurrency;
  /** What one minute of CI costs, in the currency above (default 0.008).
   *  The Settings pane offers GitHub's published runner rates as pre-fills; the
   *  runner shown there is derived from this number, never stored beside it. */
  costPerCiMinute: number;
  /** How long one run of one test would take a person, by hand, in minutes
   *  (default 12). */
  costMinutesPerManualRun: number;
}

/** A single alternative locator the Auto-Heal engine found for a failed step.
 *  Mirror of main/recorder/types.ts HealCandidate. */
export interface HealCandidate {
  locator: Locator;
  description: string;
  score: number;
  matchedPastRun: boolean;
}

/** One element a failing locator resolved to. Mirror of main/recorder/types.ts
 *  StepMatch. */
export interface StepMatch {
  index: number;
  tag: string;
  id?: string;
  testid?: string;
  ariaLabel?: string;
  text?: string;
  classes: string[];
  ancestors: string[];
  visible: boolean;
  enabled: boolean;
  rect?: { x: number; y: number; w: number; h: number };
}

/** One failing step's page structure. Mirror of main/recorder/types.ts
 *  StepStructure — already rebuilt from page-authored input by
 *  `buildStepStructures` before it crosses IPC. `matches` is what the locator
 *  literally resolved to; `candidates` is what Auto-Heal thought resembled the
 *  element we wanted. */
export interface StepStructure {
  stepIndex: number;
  stepLabel: string;
  method?: string;
  originalLocator?: Locator;
  matchCount?: number;
  matches: StepMatch[];
  outcome?: "exhausted" | "no-candidates";
  candidates: HealCandidate[];
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
  /** where the recording STARTS — what gets saved as the test's URL and what
   *  the opening `goto` step replays */
  url: string | null;
  /** where the page is NOW. Separate from `url` on purpose: tracking the live
   *  location in that field would rewrite every saved test's starting point to
   *  wherever the user happened to stop. Null outside a session. */
  liveUrl: string | null;
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
  /** the test has since been deleted — the row is kept so the batch's summary
   *  still adds up, and hidden by the view (mirrors main types) */
  testDeleted?: boolean;
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
  /** The Routine this batch was started from. Absent for a batch started any
   *  other way, or by a release that predates Routines — see the main-process
   *  copy, and `ORPHAN_BATCH_OWNER` for who those belong to. */
  routineId?: string;
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  /** index in `results` currently executing, or -1 when idle */
  currentIndex: number;
  results: BatchTestResult[];
  /** the batch ended before its queue did */
  stopped: boolean;
  /** Why — see the main-process copy. Absent means the user pressed Stop, which
   *  is what `stopped` meant on its own and what every pre-Routines record
   *  means. */
  stoppedBy?: "user" | "failure";
  /** The name of the test whose failure stopped it. */
  stoppedByTest?: string;
  /** When the current `wait` barrier ends, present only while sitting in one.
   *  See the main-process copy: without it a pause is indistinguishable from a
   *  hang. */
  waitingUntil?: number;
  summary: BatchSummary;
}

/** A batch as persisted to batch-history.json — same shape as the live state,
 *  so a restored batch renders identically to a running one. */
export type BatchRecord = BatchState;

// ── Routines (mirror of main/recorder/types.ts) ──────────────────────
// Batch v2: a saved, named job. docs/ROUTINES.md. A Routine composes RUNS;
// `runFlow` composes STEPS — see the main-process copy for why that line
// matters. `test` and `group` are built; `wait`, `notify` and `branch` are
// designed there and deliberately unwritten, because all three are steps that
// are NOT runs and executing one needs the runner to walk a program with
// barriers rather than a queue.

export type FailurePolicy = "continue" | "stopRoutine" | "skipGroup";

export interface RoutineTestStep {
  kind: "test";
  testId: string;
  /** NEVER empty — an empty array is a step that queues nothing, so the
   *  Routine silently runs fewer tests than it lists. */
  browsers: RunBrowser[];
  headless: boolean;
  onFailure: FailurePolicy;
  /** The test this step names has been deleted. Marked, not removed — the step
   *  renders as broken and the user takes it out. */
  testDeleted?: boolean;
}

/** A named run of steps. ONE LEVEL DEEP and with no `parallel` flag yet — see
 *  the main-process copy for both constraints and why they are deliberate. Its
 *  only run-time meaning is `skipGroup`, which had nowhere to point until
 *  groups existed. */
export interface RoutineGroupStep {
  kind: "group";
  /** Stable across renames and reorders; a group has no natural key the way a
   *  test step has its `testId`. */
  id: string;
  label: string;
  steps: RoutineTestStep[];
}

/** Pause the Routine. A BARRIER, not a sleep on one lane: everything before it
 *  finishes before the clock starts, and nothing after it begins until the
 *  clock ends. See the main-process copy for why that is the only reading that
 *  makes a wait mean anything. */
export interface RoutineWaitStep {
  kind: "wait";
  id: string;
  ms: number;
}

/** Say something when the run reaches this point. A BARRIER like `wait`:
 *  everything before it finishes before it fires. The message is STATIC TEXT —
 *  see the main-process copy for why interpolation is a security decision, not
 *  a missing feature. */
export interface RoutineNotifyStep {
  kind: "notify";
  id: string;
  channel: "desktop" | "webhook";
  message: string;
}

export type RoutineStep =
  | RoutineTestStep
  | RoutineGroupStep
  | RoutineWaitStep
  | RoutineNotifyStep;

/** Longest a `notify` message may be — user text that can leave the machine. */
export const MAX_ROUTINE_MESSAGE = 200;

/** Longest a single `wait` may pause a Routine: one hour. A ceiling rather than
 *  a warning — the runner holds the batch open across a wait, so a longer one
 *  is a batch that looks hung. Anything beyond this is what a schedule is for. */
export const MAX_ROUTINE_WAIT_MS = 60 * 60 * 1000;

/**
 * When a Routine runs by itself. docs/ROUTINES.md capability 2.
 *
 * NOT A CRON STRING, which is what the spec sketched — see
 * `shared/routine-schedule.mjs` for the argument. The short version: a cron
 * text field's failure mode is a schedule that never fires, and that looks
 * exactly like a schedule that is not due yet. An enumerated schedule cannot
 * hold a value the picker could not produce.
 *
 * `everyHours` is anchored to LOCAL MIDNIGHT, not to the last run, so the
 * cadence cannot drift; `hours` is constrained to divisors of 24 so the day has
 * no short gap at the end. `minute` is minutes since local midnight.
 */
export type RoutineSchedule =
  | { kind: "everyHours"; hours: number }
  | { kind: "dailyAt"; minute: number }
  | { kind: "weekdaysAt"; minute: number };

export interface RoutineDefaults {
  captureArtifacts: boolean;
  concurrency: number;
}

export interface Routine {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  steps: RoutineStep[];
  /** When it runs by itself. Absent means it only runs when you press Run. */
  schedule?: RoutineSchedule;
  /**
   * When this Routine's SCHEDULE last fired — not when the Routine last ran.
   *
   * Held beside the schedule rather than inside it, which is where the spec put
   * it: editing a schedule then cannot clobber the record of what it has
   * already done, and "I changed the time and it ran again immediately" is a
   * bug nobody would think to look for. A MANUAL run does not update it, so
   * running the job by hand at 23:00 does not cancel its 23:30 occurrence.
   */
  lastScheduledRunAt?: number;
  defaults: RoutineDefaults;
}

export const MAX_ROUTINES = 50;
export const MAX_ROUTINE_STEPS = 200;
export const MAX_ROUTINE_NAME = 80;

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
  /** Which model is answering, stamped when the stream starts. Read by the
   *  auto-apply path, which lands long after the panel that chose it — asking
   *  the settings then would name whichever model is selected at that moment.
   *  Absent on sessions stored before this was recorded. */
  model?: string;
  startedAt: number;
  updatedAt: number;
  readOnly?: boolean;
}
