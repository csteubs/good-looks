// Types for run-digest.mjs — the reading half of steps-digest.mjs.
//
// Hand-written, like every .d.mts here. See run-digest.mjs for why the split
// exists: the renderer imports this file, and must never reach `node:crypto`.

/** Hex characters kept from the SHA-256. */
export declare const DIGEST_HEX_LENGTH: number;

/** The step-list scheme tag. */
export declare const STEPS_SCHEME: string;

/** The spec-source scheme tag. */
export declare const SOURCE_SCHEME: string;

/** Whether a stored value is a digest steps-digest.mjs could have written. */
export declare function isRunDigest(value: unknown): value is string;

/** What two runs' digests say about each other. The ONE place the scheme rule
 *  lives, so no caller compares an `s1` against an `x1` with `===`. */
export declare function comparableDigests(
  a: unknown,
  b: unknown,
): "same" | "different" | "unknown";
