// Shared recorder data model (backend). Mirror kept in renderer/lib/recorder-types.ts.

export type StepType =
  | "goto"
  | "click"
  | "fill"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "assert";

export type LocatorKind = "testid" | "role" | "label" | "placeholder" | "text" | "css";

export interface Locator {
  k: LocatorKind;
  /** value for testid/label/placeholder/text/css */
  v?: string;
  /** aria role for role locators */
  role?: string;
  /** accessible name for role locators */
  name?: string;
}

export type AssertKind = "visible" | "text";

export interface Step {
  id: string;
  type: StepType;
  locator?: Locator;
  /** fill value / selectOption value / key for press */
  value?: string;
  /** human-friendly label (e.g. selected option text) */
  label?: string;
  /** goto url */
  url?: string;
  /** assertion kind when type === "assert" */
  assert?: AssertKind;
  /** assertion text / extra description */
  text?: string;
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
}

export interface TestRecord {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  steps: Step[];
  /** absolute path to the generated .spec.ts file */
  scriptPath: string;
}

export interface RecorderState {
  recording: boolean;
  paused: boolean;
  assertMode: AssertKind | null;
  stepCount: number;
  testId: string | null;
  url: string | null;
  name: string | null;
}
