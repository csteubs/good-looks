// Types for emitters.mjs. See run-pacing.d.mts for why these are hand-written.
//
// The run shape is declared STRUCTURALLY rather than imported from either
// side's `RunRecord`: this module is shared between the app (compiled
// TypeScript) and the MCP (plain ESM), and neither owns the other's types.
// Declaring only the fields the emitters read is also the honest description of
// the dependency — it is what makes "a field was renamed" a type error here
// rather than a silently empty column in someone's CI report.

export interface EmitRun {
  id?: string;
  testId?: string;
  testName?: string;
  url?: string;
  status?: "passed" | "failed";
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  logFile?: string;
  runBrowser?: string;
}

/** A row out of the metrics DB. Deliberately open — the emitters write whatever
 *  columns the row carries rather than a list they would have to keep in step
 *  with the schema. */
export type EmitRow = Record<string, unknown>;

/** Applied to every string that leaves. Passed in because the app's
 *  `redactWithSnapshot` reads an encrypted store, which this module must not. */
export type Redactor = (text: string) => string;

export declare const NO_REDACTION: Redactor;

export interface EmitOptions {
  redact?: Redactor;
}

export declare function junitXml(
  runs: readonly EmitRun[],
  opts?: EmitOptions & { suiteName?: string },
): string;

export declare function githubAnnotations(runs: readonly EmitRun[], opts?: EmitOptions): string;

export declare function ticketMarkdown(
  runs: readonly EmitRun[],
  opts?: EmitOptions & { title?: string },
): string;

export declare function stepMetricsNdjson(rows: readonly EmitRow[], opts?: EmitOptions): string;

export declare function stepMetricsCsv(rows: readonly EmitRow[], opts?: EmitOptions): string;

export declare function otlpTrace(
  runs: readonly EmitRun[],
  opts?: EmitOptions & { serviceName?: string },
): string;

export type EmitterId = "junit" | "github" | "ticket" | "otlp" | "ndjson" | "csv";

export interface EmitterMeta {
  id: EmitterId;
  label: string;
  extension: string;
  summary: string;
  /** Null when the emitter reports outcomes only. Set for the two that carry
   *  more than that — see §7.3. */
  risk: string | null;
}

export declare const EMITTERS: readonly EmitterMeta[];

export declare function emitFileName(emitterId: string, stamp: string): string;
