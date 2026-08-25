/** A refusal from `runSelection`, as the CLI sees it. */
export type RunRefusal =
  | { ok: false; reason: "no-match"; how: string }
  | { ok: false; reason: "unknown-browser"; browser: string }
  | { ok: false; reason: "no-playwright"; projectRoot: string }
  | { ok: false; reason: "no-browser"; browser: string }
  /** Anything `runSelection` grows later. Present so `exitCodeFor` can be given
   *  one in a test — the point of that arm is that it is NOT a pass. */
  | { ok: false; reason: string };

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface RunResult {
  testId: string;
  testName: string;
  status: string;
  durationMs?: number;
  runRecordId?: string;
  datasetId?: string;
  datasetName?: string;
  note?: string;
}

export interface RunSucceeded {
  ok: true;
  batchId: string;
  browser: string;
  parallel: number;
  missing: string[];
  summary: RunSummary;
  fixturesSkipped: string[];
  results: RunResult[];
}

export type RunOutcome = RunSucceeded | RunRefusal;

/** The exit-code contract. See `cli/exit.mjs` for what each one means and why
 *  code 2 is separate from both 0 and 1. */
export declare const EXIT: {
  readonly PASSED: 0;
  readonly FAILED: 1;
  readonly NO_MATCH: 2;
  readonly CANNOT_START: 3;
};

/** The exit code for one outcome. Never 0 for anything that did not run. */
export declare function exitCodeFor(outcome: RunOutcome | undefined | object): number;

/** One line per code, for `--help`. The documented table and the implemented
 *  one are the same object. */
export declare const EXIT_MEANINGS: ReadonlyArray<readonly [number, string]>;
