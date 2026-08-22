// Types for triage.mjs. See run-pacing.d.mts for why these are hand-written.

import type { RunRow, StepRow } from "./metrics-schema.mjs";
import type { StepHealthRow } from "./metrics-query.mjs";

/** Which way one signal points. There is no "unknown" direction: a signal that
 *  does not point anywhere is not evidence, and belongs in `limits`. */
export type TriageDirection = "site" | "runner";

export type TriageVerdict = "site" | "runner" | "mixed" | "unknown";

export interface TriageEvidence {
  /** Stable identifier for the rule that fired — safe to switch on. */
  signal: string;
  direction: TriageDirection;
  /** The underlying number or fact, in words. Shown to the user verbatim. */
  detail: string;
}

export interface TriageResult {
  verdict: TriageVerdict;
  /** 0–1, never 1. Reduced when `limits` is non-empty. */
  confidence: number;
  /** Strongest first. The product; `verdict` is a summary of it. */
  evidence: TriageEvidence[];
  /** What could not be seen, and therefore what must not be read into the
   *  absence of evidence. Never empty just because the verdict is confident. */
  limits: string[];
  failingStepId: string | null;
  suggestedNext: string;
}

export interface TriageInput {
  run: RunRow | null | undefined;
  steps?: StepRow[];
  /** Other runs of the same test, from metrics-query's siblingRuns() asked
   *  with the failing step's id. The window is the caller's choice. Cross-run
   *  signals read each sibling's `step_status` — the failing step's outcome in
   *  that run — and a sibling that never executed the step (null) is set aside
   *  rather than read as a pass. */
  siblings?: (Partial<RunRow> & { step_status?: string | null })[];
  /** The stepHealth() row for the failing step, when the caller has it. */
  stepHistory?: Pick<StepHealthRow, "heals" | "healFailures" | "runs"> | null;
}

/** The sibling-run window both callers must use, so the same run triaged from
 *  the app and from the MCP cannot give two different answers. */
export declare const TRIAGE_COHORT: number;

export declare function triageRun(input?: TriageInput): TriageResult;
