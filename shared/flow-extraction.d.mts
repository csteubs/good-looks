/** Hand-written declarations for flow-extraction.mjs — see shared/'s rule. */

export interface ExtractableStep {
  id: string;
  type: string;
}

export type ExtractableVerdict =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: string };

export function extractableRange(
  steps: ReadonlyArray<ExtractableStep>,
  ids: ReadonlyArray<string>,
): ExtractableVerdict;
