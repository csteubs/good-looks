// Types for run-plan.mjs.
//
// The MCP server is plain ESM JavaScript on purpose — it runs standalone via
// `node mcp/server.mjs`, with no build step and without the app. This
// declaration exists so check:mcp-parity, which imports these to exercise them
// against the generator, consumes them with types rather than `any`.

import type { Dataset, RecorderSettings, TestRecord, TestSpeed } from "../main/recorder/types.js";

/** The subset of a TestRecord this module reads. Loose on purpose: these come
 *  from tests.json on disk, which may predate any given field. */
export type PlannedTest = Partial<TestRecord> & { id?: string; name?: string };

export declare function secretVariableNames(test: PlannedTest | undefined): string[];

export declare function datasetRow(
  test: PlannedTest | undefined,
  datasetId: string | undefined,
): Dataset | null;

export declare function runEnv(params: {
  base: NodeJS.ProcessEnv;
  browsersPath: string;
  nodeModules: string;
  speed: TestSpeed | string | undefined;
  testTimeoutMs: number;
  vars?: Record<string, string>;
}): NodeJS.ProcessEnv;

export declare function runArgs(params: {
  cliPath: string;
  specFile: string;
  configPath: string;
  browser: string;
  testTimeoutMs: number;
}): string[];

export declare function sanitizeOutput(output: string): string;

export interface RunFixtureReport {
  speed: TestSpeed | string | undefined;
  stepDelayMs: number;
  testTimeoutMs?: number;
  timeoutNote?: string;
  /** What an app run of this test would have done that this one did not.
   *  Absent when there is nothing to report. */
  skipped?: string[];
}

export declare function describeRun(
  test: PlannedTest | undefined,
  settings?: Partial<RecorderSettings>,
  opts?: { speed?: TestSpeed | string; timeoutMs?: number; timeoutRaised?: boolean },
): RunFixtureReport;
