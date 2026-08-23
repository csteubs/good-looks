// The TypeScript service's answers, as the renderer sees them (mirror of
// main/services/ts-service/core.ts — offsets are character offsets into the
// document the renderer sent).

import type { InspectionRule } from "../../shared/inspections.mjs";

export interface TsSpan {
  from: number;
  to: number;
}
export interface TsDiagnostic extends TsSpan {
  message: string;
  severity: "error" | "warning" | "info";
  code: number;
}
export interface TsCompletion {
  label: string;
  kind: string;
  sortText: string;
  detail?: string;
}
export interface TsHover extends TsSpan {
  text: string;
  documentation?: string;
}
export interface TextEdit extends TsSpan {
  text: string;
}
export interface Inspection extends TsSpan {
  rule: InspectionRule;
  severity: "error" | "warning" | "hint";
  message: string;
  fix?: { title: string; edits: TextEdit[] };
}
export interface TsServiceStatus {
  available: boolean;
  reason?: string;
  typescript?: string;
}
