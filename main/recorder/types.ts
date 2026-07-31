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
  | "viewport";

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
}
