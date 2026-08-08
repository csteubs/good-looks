// Types for rollup.mjs. See run-pacing.d.mts for why these are hand-written.
//
// The inputs are typed structurally rather than imported from artifact-store.ts
// and run-history-store.ts: those reach @glaze/core/backend, and shared/ imports
// nothing that does. Only the fields the rollup reads are declared, which is
// also the honest description of what it needs.

import type { RunRow, StepRow } from "./metrics-schema.mjs";

export interface RollupReplayStep {
  index: number;
  stepId: string;
  label?: string;
  type?: string;
  status?: string;
  /** the manifest entry this step matched — the join to the logs */
  actionIndex?: number;
  /** `"<actionIndex>.png"`, the legacy carrier of the same number */
  screenshot?: string | null;
  diff?: { state?: string; ratio?: number };
  a11y?: { violations?: unknown[]; newKeys?: unknown[] };
}

export interface RollupReplay {
  failedIndex?: number | null;
  steps?: RollupReplayStep[];
}

export interface RollupManifest {
  steps?: { index?: number; ms?: number; stepMs?: number }[];
}

export interface RollupLogs {
  console?: { step?: number; type?: string }[];
  network?: { step?: number; ms?: number; status?: number; ok?: boolean; resourceType?: string }[];
  /** entries the per-run cap discarded — carried through so a query can tell
   *  "nothing happened on that step" from "that step's entries were dropped" */
  consoleDropped?: number;
  networkDropped?: number;
}

export interface RollupInput {
  /** the RunRecord, as persisted in run-history.json */
  run: Record<string, unknown> & { id: string; testId: string };
  replay?: RollupReplay | null;
  manifest?: RollupManifest | null;
  logs?: RollupLogs | null;
  healFailures?: { stepId?: string; outcome?: "exhausted" | "no-candidates" }[];
  /** heal-journal entries belonging to THIS run */
  heals?: { stepId?: string }[];
  /** the run's raw log text, for the error signature */
  logText?: string;
  source?: "app" | "mcp";
}

export declare function rollupRun(input: RollupInput): { run: RunRow; steps: StepRow[] };
