// Types for error-signature.mjs. See run-pacing.d.mts for why these are
// hand-written.

/** Normalize a raw failure message into a stable clustering key. */
export declare function errorSignature(raw: string | undefined): string;

/** The first line of a run log that looks like the failure, or "". */
export declare function firstErrorLine(log: string | undefined): string;
