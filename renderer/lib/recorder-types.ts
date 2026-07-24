// Mirror of main/recorder/types.ts for the renderer. Keep shapes in sync.

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
  v?: string;
  role?: string;
  name?: string;
}

export type AssertKind = "visible" | "text";

export interface Step {
  id: string;
  type: StepType;
  locator?: Locator;
  value?: string;
  label?: string;
  url?: string;
  assert?: AssertKind;
  text?: string;
  timestamp: number;
}

export interface TestRecord {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  steps: Step[];
  scriptPath: string;
  scriptEdited?: boolean;
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
}
