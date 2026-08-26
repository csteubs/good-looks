// Types for run-provenance.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so `mcp/run-tests.mjs` can import it with no build step, and this file is
// what keeps `npm run type-check` a real gate over the TypeScript callers (the
// run-history store and, when a surface reads it, the renderer).

/**
 * Where a run came from. Every field is optional and independently so: the
 * fields are validated one at a time, and a value this application will not
 * store is ABSENT rather than repaired — see the implementation's
 * "reject, never truncate" note.
 */
export interface RunProvenance {
  /** The commit under test, verbatim as the environment reported it. */
  revision?: string;
  /** The branch under test. On a pull request this is the SOURCE branch, which
   *  on a fork is chosen by whoever opened it — untrusted text. */
  branch?: string;
  /** The repository, as an http(s) URL. */
  repositoryUrl?: string;
  /** The CI job that ran this, as an http(s) URL. */
  jobUrl?: string;
}

export declare const PROVENANCE_MAX_TEXT: number;
export declare const PROVENANCE_MAX_URL: number;

/** Narrow an unknown value to storable provenance, or `undefined` when nothing
 *  in it survives. Never returns an empty object. */
export declare function normalizeRunProvenance(value: unknown): RunProvenance | undefined;

/** Read provenance out of an environment — `GOOD_LOOKS_*` first, then GitHub
 *  Actions — or `undefined` when it says nothing. The result has already been
 *  through `normalizeRunProvenance`. */
export declare function readRunProvenance(
  env: Record<string, string | undefined>,
): RunProvenance | undefined;
