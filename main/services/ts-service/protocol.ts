// The messages between the main process and the TS-service child. Plain
// JSON both ways; every request carries an id and gets exactly one reply.

import type { Inspection, InspectionRule, TextEdit, TsCompletion, TsDiagnostic, TsHover } from "./core.js";

export type TsRequest =
  | { id: number; method: "update"; params: { id: string; text: string; runtime?: string } }
  | { id: number; method: "close"; params: { id: string } }
  | { id: number; method: "diagnostics"; params: { id: string } }
  | { id: number; method: "completions"; params: { id: string; offset: number } }
  | { id: number; method: "hover"; params: { id: string; offset: number } }
  | { id: number; method: "inspections"; params: { id: string; enabled?: Partial<Record<InspectionRule, boolean>> } }
  | { id: number; method: "format"; params: { id: string } }
  | { id: number; method: "ping"; params: Record<string, never> };

export type TsResponse = { id: number; result: unknown } | { id: number; error: string };

export interface TsResults {
  update: void;
  close: void;
  diagnostics: TsDiagnostic[];
  completions: TsCompletion[];
  hover: TsHover | null;
  inspections: Inspection[];
  format: TextEdit[];
  ping: { typescript: string };
}
