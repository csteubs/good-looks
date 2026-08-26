// Types for run-ingest.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so `cli/ingest.mjs` can import it with no build step, and this file is
// what keeps `npm run type-check` a real gate over any TypeScript caller.
//
// `IngestedRun` is declared STRUCTURALLY rather than as `Omit<RunRecord,
// "logFile">`. Importing `RunRecord` would point `shared/` at `main/`, which is
// the one direction this directory does not go — `main/recorder/types.ts`
// already imports from here, and the whole reason `shared/` is a pure core is
// that nothing in it depends on the compiled app.
//
// What that would have bought is drift detection, and it is bought instead by
// `check:run-ingest`, which reads both files and asserts the two agree in both
// directions: every field the gate copies is one `RunRecord` declares, and every
// REQUIRED field of `RunRecord` is one the gate produces. A type import could
// only have caught the second.

/**
 * A foreign run record, narrowed to what this library will store.
 *
 * NOTE THE ABSENT `logFile`. It is not an oversight and not optional: the
 * incoming value is an absolute path on another machine, and the store's
 * readers do not bound it. The caller supplies a local path it derived from the
 * validated `id`.
 */
export interface IngestedRun {
  id: string;
  testId: string;
  testName: string;
  url: string;
  status: "passed" | "failed";
  exitCode: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** Always 0 from the gate — the caller re-derives it from the log it copied. */
  logBytes: number;
  [field: string]: unknown;
}

/** The most a free-text field on an ingested record may be. */
export declare const INGEST_MAX_TEXT: number;

/** Is this a value we are willing to use as part of a filename? Rejects
 *  traversal, separators and anything that is not a plain token. */
export declare function isIngestableRunId(value: unknown): boolean;

/** Narrow one foreign run record, or `null` when a REQUIRED field is unusable.
 *  Optional fields are judged independently — one bad field does not lose the
 *  run. */
export declare function normalizeIngestedRun(value: unknown): IngestedRun | null;

/** Split incoming records into the ones to store, the ones already present, and
 *  the ones that could not be read. Deduped by id, which is what makes `ingest`
 *  safe to run twice. */
export declare function planIngest(
  localIds: Iterable<string>,
  incoming: unknown[],
): { fresh: IngestedRun[]; duplicate: number; unusable: number };
