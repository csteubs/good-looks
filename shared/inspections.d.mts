export type InspectionRule =
  | "no-wait-for-timeout"
  | "no-force-without-reason"
  | "missing-await"
  | "raw-css-locator"
  | "unwrapped-statement"
  | "index-pinned-locator";

export interface InspectionInfo {
  id: InspectionRule;
  label: string;
  summary: string;
  severity: "error" | "warning" | "hint";
  fixes: boolean;
}

export const INSPECTIONS: InspectionInfo[];
export const INSPECTION_RULES: InspectionRule[];
export function defaultInspections(): Record<InspectionRule, boolean>;
export function normalizeInspections(raw: unknown): Record<InspectionRule, boolean>;
