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
}
