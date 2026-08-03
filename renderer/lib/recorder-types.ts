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
}

/** A single verbose diagnostic line produced while replaying a step. */
export interface DebugLogLine {
  i: number;
  t: number;
  level: "info" | "warn" | "error";
  m: string;
}

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
}
