// Types for export.mjs.
//
// Hand-written, like `ingest.d.mts` beside it: the implementation is plain ESM
// so `bin/good-looks.mjs` can import it with no build step, and this file is
// what keeps `npm run type-check` a real gate over its TypeScript callers —
// today `main/services/cli-export.test.ts`, over there because a `.test.ts`
// under `cli/` matches neither Vitest project.

/** What `good-looks export` was asked to do, once the arguments are known good. */
export interface ExportOptions {
  /** Where to write the bundle. Named rather than positional: this command
   *  CREATES what it is pointed at, and there is no default. */
  out: string;
  /** Write into a directory that already has files in it. */
  force: boolean;
  /** Report what would be written and write nothing. */
  dryRun: boolean;
  /** Print the summary as JSON instead of prose. */
  json: boolean;
}

/** What the command reports. `needsSecrets` is the one a CI operator acts on:
 *  those tests are IN the bundle and will skip on the runner until the
 *  variables are set. */
export interface ExportSummary {
  exported: number;
  specFiles: number;
  into: string;
  missingSpecs: string[];
  unusable: number;
  needsSecrets: { id: string; name: string; names: string[] }[];
  symlinksSkipped: number;
  dryRun: boolean;
}

export declare function exportCommand(
  options: ExportOptions,
  deps: {
    out: (s: string) => void;
    err: (s: string) => void;
    /** The library to read. Resolved by the caller so a library this CLI cannot
     *  find is the same refusal it is for `run` and `ingest`. */
    dataDir: string;
  },
): number;

export declare const EXPORT_USAGE: string;

export declare function parseExportArgs(
  argv: string[],
): { ok: true; options: ExportOptions } | { ok: false; error: string } | { ok: "help" };
