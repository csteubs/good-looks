// Shared recorder data model (backend). Mirror kept in renderer/lib/recorder-types.ts.

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
  // Logic layer: `if` opens a conditional block, `endif` closes it. Steps
  // between them run only when the condition holds; otherwise they're skipped
  // and the test continues gracefully.
  | "if"
  | "endif";

/**
 * Predicate for an `if` step. Element conditions resolve `Step.locator`; page
 * conditions (urlContains/titleContains) use `Step.value` as the substring.
 */
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
  /** value for testid/label/placeholder/text/css/xpath */
  v?: string;
  /** aria role for role locators */
  role?: string;
  /** accessible name for role locators */
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
  | "title";

export interface Step {
  id: string;
  type: StepType;
  locator?: Locator;
  /** fill value / selectOption value / key for press / expected value for value/attribute/url/title asserts */
  value?: string;
  /** human-friendly label (e.g. selected option text) */
  label?: string;
  /** goto url */
  url?: string;
  /** assertion kind when type === "assert" */
  assert?: AssertKind;
  /** condition predicate when type === "if" */
  cond?: ConditionKind;
  /** assertion text / extra description */
  text?: string;
  /** soft assertion — reports a failure but doesn't stop the test (expect.soft) */
  soft?: boolean;
  /** attribute name for an "attribute" assertion */
  attr?: string;
  /** expected element count for a "count" assertion */
  count?: number;
  /** viewport width when type === "viewport" */
  width?: number;
  /** viewport height when type === "viewport" */
  height?: number;
  /** wait duration in ms when type === "wait" (omit to wait for the locator instead) */
  waitMs?: number;
  timestamp: number;
}

/** Payload emitted by the injected capture script (before backend enrichment). */
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
  /** absolute path to the generated .spec.ts file */
  scriptPath: string;
  /** true once the script has been hand-edited, so it's no longer regenerated from steps */
  scriptEdited?: boolean;
  /** playback speed for runs (adds a slowMo delay between actions); defaults to "fast" (no delay) */
  speed?: TestSpeed;
  /** absolute path to the folder a test was imported from, so its sibling
   *  modules (e.g. `./helpers.js`) can be re-copied into the scripts dir */
  sourceDir?: string;
  /** true when the user removed the test from the sidebar view — the record
   *  and its script file are kept on disk; the sidebar just hides it. */
  hidden?: boolean;
  /** true when the script was resynced to steps (e.g. after an LLM-apply)
   *  and the parser had to skip statements it couldn't classify — the steps
   *  count may not fully reflect the script. */
  stepsDiverged?: boolean;
}

/** A single completed test run, persisted to run-history.json. The raw console
 *  output for the run lives in a sibling .log file (see logFile) so large
 *  outputs stay out of the JSON index. */
export interface RunRecord {
  /** unique per run (not the testId — one test has many runs) */
  id: string;
  testId: string;
  testName: string;
  url: string;
  status: "passed" | "failed";
  exitCode: number;
  /** epoch ms */
  startedAt: number;
  /** epoch ms */
  finishedAt: number;
  durationMs: number;
  /** absolute path to the raw console-output .log file for this run */
  logFile: string;
  /** size of the log file in bytes (0 if the raw log was deleted but the
   *  record kept, or if the log could not be read) */
  logBytes: number;
  /** Whether this run was asked to capture artifacts (screenshots, and later
   *  video/DOM snapshots). Per-run choice, off by default; the gate every
   *  visual-testing phase checks. Absent on runs recorded before the toggle. */
  captureArtifacts?: boolean;
}

/** A hit from searching the raw run logs. */
export interface LogSearchResult {
  runId: string;
  testName: string;
  status: "passed" | "failed";
  startedAt: number;
  matchCount: number;
  /** a short excerpt of the log around the first match */
  snippet: string;
}

/** An element captured via the "Refine Selector" picker in the training window. */
export interface PickedElement {
  /** lowercase tag name, e.g. "button" */
  tag: string;
  /** human-readable descriptor, e.g. "button#submit.btn-primary" */
  description: string;
  /** every locator strategy that applies, best-first */
  candidates: Locator[];
  /** curated slice of computed styles */
  css: Record<string, string>;
  /** curated element attributes */
  attributes: Record<string, string>;
}

/** Global trainer preferences, independent of any recording session. */
export interface RecorderSettings {
  /** show the current page's URL in the training window's title bar (default true) */
  showUrlBar: boolean;
  /** default playback speed for new recordings (adds a slowMo delay between
   *  actions during runs); persisted so the New Recording dialog remembers the
   *  last choice. Defaults to "slow" so runs are watchable by default. */
  defaultRunSpeed: TestSpeed;
  /** Auto-Heal engine enabled (default true). When a step's locator fails to
   *  resolve during replay, the engine probes the page for alternative target
   *  elements using all locator strategies + context from past runs. */
  autoHealEnabled: boolean;
  /** how many heal attempts to make before giving up (default 3). */
  autoHealRetries: number;
  /** per-attempt timeout in ms before the attempt is considered timed-out
   *  (default 4000). */
  autoHealAttemptTimeoutMs: number;
}

/** A single alternative locator the Auto-Heal engine found for a failed step. */
export interface HealCandidate {
  /** the alternative locator to try */
  locator: Locator;
  /** human-readable description of the matched element (e.g. "button#submit") */
  description: string;
  /** relevance score (0–1, higher = better match) */
  score: number;
  /** true if this candidate matches something seen in past-run debug logs
   *  for this step (the locator previously resolved successfully). */
  matchedPastRun: boolean;
}

/** Result of a heal attempt for a single failed step. */
export interface HealResult {
  /** step id this heal was for */
  stepId: string;
  /** 0-based step index */
  stepIndex: number;
  /** human-friendly step label */
  stepLabel: string;
  /** the step's original locator (before healing) */
  originalLocator: Locator | undefined;
  /** all candidates the engine found, best-first */
  candidates: HealCandidate[];
  /** how many attempts were made */
  attempts: number;
  /** true if a candidate was auto-applied and the step succeeded on re-run */
  ok: boolean;
  /** the locator that was auto-applied (if ok) */
  appliedLocator?: Locator;
  /** true if the best candidate was auto-applied (set by tryHeal) */
  autoApplied: boolean;
  /** short error if healing failed entirely */
  error?: string;
}

/** A single verbose diagnostic line produced while replaying a step. */
export interface DebugLogLine {
  /** monotonic index within the step's log session */
  i: number;
  /** ms timestamp (Date.now()) when the line was produced */
  t: number;
  /** "info" | "warn" | "error" — controls tone in the panel */
  level: "info" | "warn" | "error";
  /** the diagnostic message */
  m: string;
}

/** Persisted debug entry for a single step's replay attempt. */
export interface DebugEntry {
  /** step id this entry belongs to */
  stepId: string;
  /** 1-based step index at the time of replay (for display) */
  stepIndex: number;
  /** human-friendly step label at replay time */
  stepLabel: string;
  /** replay outcome */
  ok: boolean;
  /** short error string (mirrors the legacy `error` field) */
  error?: string;
  /** ms timestamp of the replay attempt */
  at: number;
  /** verbose, ordered diagnostic lines */
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
  /** true when continuing/extending an existing test rather than recording a new one */
  editing: boolean;
  /** true when the pending assertion is soft (expect.soft) */
  assertSoft: boolean;
  /** index new steps are inserted at (defaults to the end of the list) */
  cursor: number;
  /** true while the "Refine Selector" element picker is active */
  refineMode: boolean;
  /** true once the trainer browser window has finished loading its first page */
  pageReady: boolean;
  /** true while the training browser window is opening but hasn't shown yet.
   *  The renderer shows a loading modal with copy explaining the load; if this
   *  stays true past the timeout, the session is cancelled and an error shown. */
  loading: boolean;
  /** set when the training window failed to open within the timeout; the
   *  renderer shows an error dialog prompting the user to try again. */
  loadFailed: boolean;
}
