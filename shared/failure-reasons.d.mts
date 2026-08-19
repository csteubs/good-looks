// Types for failure-reasons.mjs. See run-pacing.d.mts for why these are
// hand-written.

import type { TriageResult } from "./triage.mjs";

/** A reason definition as the picker and the resolvers see it — the shape both
 *  built-ins and resolved custom reasons share. */
export interface FailureReasonDef {
  id: string;
  name: string;
  description: string;
}

/** The minimal shape a stored custom reason needs to resolve. The app's store
 *  record carries more (timestamps, disabled); this is what resolution reads. */
export interface CustomFailureReasonLike {
  id: string;
  name: string;
  description?: string;
}

export declare const DEFAULT_FAILURE_REASONS: readonly FailureReasonDef[];

export declare const MAX_REASON_NAME: number;
export declare const MAX_REASON_DESCRIPTION: number;
export declare const MAX_ACTIVE_CUSTOM_REASONS: number;

export declare function resolveFailureReason(
  id: string | null | undefined,
  custom?: readonly CustomFailureReasonLike[],
): FailureReasonDef | null;

export interface FailureReasonSuggestion {
  /** Always a built-in id — the mapper cannot read a custom definition. */
  reasonId: string;
  /** The triage signal that argued for it ("network-error" for the
   *  error-line rule), stored with the assignment as its evidence. */
  signal: string;
}

export declare function suggestFailureReason(
  triage: Pick<TriageResult, "evidence"> | null | undefined,
  errorLine?: string,
): FailureReasonSuggestion | null;
