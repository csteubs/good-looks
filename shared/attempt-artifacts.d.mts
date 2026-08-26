// Types for attempt-artifacts.mjs.
//
// Hand-written, like every .d.mts here: the implementation is plain ESM so the
// CLI and the capture fixture's builder can use it with no build step, and this
// file is what keeps `npm run type-check` a real gate over the TypeScript
// callers in `main/`.

/** Prefix for a retried attempt's directory. Attempt 0 has none — it keeps the
 *  run directory, because a retry only follows a failure and attempt 0 is
 *  therefore the attempt worth looking at. */
export declare const ATTEMPT_DIR_PREFIX: string;

/** Coerce anything to an attempt number. Not a non-negative integer ⇒ 0. */
export declare function normalizeAttempt(value: unknown): number;

/** The path segment for one attempt, relative to the run directory. Empty for
 *  attempt 0, so a caller can join unconditionally. */
export declare function attemptDirName(attempt: number): string;

/** The attempt a directory name denotes, or null when it is not one. */
export declare function parseAttemptDirName(name: string): number | null;

/** The full directory for one attempt's artifacts. */
export declare function attemptArtifactDir(runDir: string, attempt: number): string;

/** The attempt a Playwright scratch directory belongs to — `<slug>-retry2` ⇒ 2,
 *  `<slug>` ⇒ 0. */
export declare function attemptFromPlaywrightOutputDir(name: string): number;

/** `normalizeAttempt` and `attemptDirName` as source, for interpolation into the
 *  capture fixture — the one caller that cannot import this module. */
export declare const ATTEMPT_HELPERS: string;
