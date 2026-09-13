// Types for steps-digest.mjs.
//
// Hand-written, like every .d.mts here: the implementation is plain ESM so the
// CLI and the MCP can import it with no build step, and this file is what keeps
// `npm run type-check` a real gate over the TypeScript callers in `main/` and
// `renderer/`.

/** Hex characters kept from the SHA-256. */
export declare const DIGEST_HEX_LENGTH: number;

/** The step-list scheme tag. */
export declare const STEPS_SCHEME: string;

/** The spec-source scheme tag. */
export declare const SOURCE_SCHEME: string;

/** Step fields dropped before hashing — element fingerprint, record timestamp
 *  and the derived variable references. See the module header for each. */
export declare const IGNORED_STEP_FIELDS: string[];

/** The canonical text a step list hashes as, or null when the input is not a
 *  list. Exported so a test can say WHY two lists digested alike. */
export declare function canonicalSteps(steps: unknown): string | null;

/** Which scheme a run of this test digests under — `"steps"` when the executed
 *  spec is generated from the step list, `"source"` when the file is the record
 *  (hand-edited, imported, or steps/script diverged). Both runners ask this one
 *  function; an answer that went two ways would make every test run by both
 *  compare as unknown. */
export declare function digestSchemeFor(
  test: unknown,
  replaying?: boolean,
): "steps" | "source";

/** `"s1:<hex>"` for a step list, or undefined when there is no list — and
 *  undefined means UNKNOWN to every reader, never "unchanged". */
export declare function digestSteps(steps: unknown): string | undefined;

/** `"x1:<hex>"` for a spec file's source, for tests whose file is the source of
 *  truth. The caller reads the file; this module stays pure. */
export declare function digestSource(source: unknown): string | undefined;

/** Whether a stored value is a digest this module could have written. */
export declare function isRunDigest(value: unknown): value is string;

/** What two runs' digests say about each other. The ONE place the scheme rule
 *  lives, so no caller compares an `s1` against an `x1` with `===`. */
export declare function comparableDigests(
  a: unknown,
  b: unknown,
): "same" | "different" | "unknown";
