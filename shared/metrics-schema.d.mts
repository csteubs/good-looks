// Types for metrics-schema.mjs. See run-pacing.d.mts for why these are
// hand-written.

export declare const SCHEMA_VERSION: number;

export declare const RUNS_DDL: string;
export declare const STEP_METRICS_DDL: string;
export declare const INDEX_DDL: string[];
export declare const CREATE_STATEMENTS: string[];
export declare const DROP_STATEMENTS: string[];

export declare const RUN_COLUMNS: string[];
export declare const STEP_COLUMNS: string[];
export declare const INSERT_RUN: string;
export declare const INSERT_STEP: string;

/** One row of the `runs` table. Every field beyond the identity is optional,
 *  because a run that captured nothing legitimately has almost none of them. */
export interface RunRow {
  id: string;
  test_id: string;
  test_name: string;
  url?: string;
  status: string;
  kind: string;
  started_at: number;
  duration_ms: number;
  browser?: string;
  speed?: string;
  headless?: boolean;
  batch_id?: string;
  dataset_id?: string;
  dataset_name?: string;
  healed_steps: number;
  heal_failed_steps: number;
  a11y_ms?: number;
  a11y_checks?: number;
  a11y_new_steps?: number;
  capture_ms?: number;
  shot_count?: number;
  test_timeout_ms?: number;
  failed_step_id?: string;
  error_signature?: string;
  source?: "app" | "mcp";
  has_artifacts: boolean;
  /** entries the per-run cap discarded before they reached disk — what a
   *  "nothing was recorded there" answer has to be read against */
  console_dropped: number;
  network_dropped: number;
  replay_of_run_id?: string;
}

/** One row of `step_metrics`. */
export interface StepRow {
  run_id: string;
  step_index: number;
  step_id: string;
  action_index?: number;
  label?: string;
  type?: string;
  status?: string;
  ms?: number;
  diff_state?: string;
  diff_ratio?: number;
  a11y_violations?: number;
  a11y_new?: number;
  healed: number;
  heal_failed?: "exhausted" | "no-candidates";
  net_requests?: number;
  net_failures?: number;
  net_worst_status?: number;
  net_worst_api_status?: number;
  net_total_ms?: number;
  console_errors?: number;
  console_page_errors?: number;
}

export declare function bind(
  columns: string[],
  row: Record<string, unknown>,
): (string | number | null)[];
