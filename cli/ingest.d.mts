// Types for ingest.mjs.
//
// Hand-written, like `args.d.mts` beside it: the implementation is plain ESM so
// `bin/good-looks.mjs` can import it with no build step, and this file is what
// keeps `npm run type-check` a real gate over its TypeScript callers — which
// today means `main/services/cli-ingest.test.ts`, the tests being over there
// because a `.test.ts` under `cli/` matches neither Vitest project.

/** What `good-looks ingest` was asked to do, once the arguments are known good. */
export interface IngestOptions {
  /** The directory to read. An unpacked CI artifact — either the library or its
   *  `recorder/`. No default: ingest writes into the user's real run history. */
  dir: string;
  /** Report what would be ingested and write nothing. */
  dryRun: boolean;
  /** Print the summary as JSON instead of prose. */
  json: boolean;
}

/** What the command reports. Counted apart on purpose: `unusable` means look at
 *  what produced the directory, `alreadyPresent` means you have run this before. */
export interface IngestSummary {
  ingested: number;
  alreadyPresent: number;
  unusable: number;
  withLogs: number;
  from: string;
  into: string;
  dryRun: boolean;
}

export declare function ingestCommand(
  options: IngestOptions,
  deps: {
    out: (s: string) => void;
    err: (s: string) => void;
    /** The library to write into. Resolved by the caller so a library this CLI
     *  cannot find is the same refusal it is for `run`. */
    dataDir: string;
    /** Injectable for tests; stamped on every record as `ingestedAt`. */
    now?: () => number;
  },
): number;

export declare const INGEST_USAGE: string;

export declare function parseIngestArgs(
  argv: string[],
): { ok: true; options: IngestOptions } | { ok: false; error: string } | { ok: "help" };
