// Hand-written types for period-digest.mjs. See the module header for why this
// is a `.mjs` with a `.d.mts` beside it rather than a `.ts`: the app compiles
// and bundles, the MCP server is plain ESM with no build step, and this keeps
// `npm run type-check` a real gate over every TypeScript caller.

export declare const WEEK_MS: number;

/** The run fields the digest and the flake rule read. Structural on purpose —
 *  the renderer's `RunRecord` and the backend's both satisfy it. */
export interface DigestRun {
  id: string;
  testId: string;
  testName?: string;
  status: string;
  startedAt: number;
  kind?: string;
  runBrowser?: string;
  runHeadless?: boolean;
  speed?: string;
  captureArtifacts?: boolean;
  datasetName?: string | null;
}

/** Runs the run index no longer holds, tallied by local day. */
export interface RunDayCount {
  dayStart: number;
  runs: number;
  failed: number;
}

export interface DigestTest {
  testId: string;
  testName: string;
  failures: number;
}

export interface PeriodDigest {
  runs: number;
  failed: number;
  /** Runs in the window BEFORE this one, for the comparison. */
  previousRuns: number;
  /** Tests that failed at least once, worst first. */
  offenders: DigestTest[];
  /** Runs that failed and then passed again with nothing changed (§6.4's
   *  rule, via `flakeRuns`). */
  flaky: number;
  /** The sentences, in order. Empty when there is nothing to say. */
  lines: string[];
}

export declare function flakeRuns(runsForOneTest: readonly DigestRun[]): Set<string>;

export declare function periodDigest(
  runs: readonly DigestRun[],
  now: number,
  opts?: {
    periodMs?: number;
    periodLabel?: string;
    prunedDays?: readonly RunDayCount[];
  },
): PeriodDigest;
