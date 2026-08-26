// Types for junit.mjs.
//
// Hand-written, like every other `.d.mts` in this repo: the implementation is
// plain ESM so the CLI can run it with no build step, and this file is what
// keeps `npm run type-check` a real gate over its TypeScript callers — here,
// `main/services/cli-junit.test.ts`.

/** One entry of `runSelection`'s `results` array. Deliberately loose: this
 *  module reads a named handful of fields and forwards nothing else, and
 *  pinning the whole result shape here would be a second place to update every
 *  time the runner grows a field it does not emit. */
export interface JunitResult {
  testId?: string;
  testName?: string;
  status?: "passed" | "failed" | "skipped";
  exitCode?: number;
  durationMs?: number;
  failedStepIndex?: number;
  stepCount?: number;
  note?: string;
}

export interface JunitOptions {
  /** The secret values THIS PROCESS resolved for the tests in this report.
   *  Values, never a redactor — a caller that could pass one could pass an
   *  identity function, and the file would look identical. */
  secretValues?: readonly string[];
  suiteName?: string;
}

export declare function junitReportFor(
  results: readonly JunitResult[],
  options?: JunitOptions,
): string;

export declare function writeJunitReport(
  destination: string,
  results: readonly JunitResult[],
  options?: JunitOptions,
): { path: string; bytes: number; count: number };
