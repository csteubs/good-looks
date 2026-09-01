// Types for heal-artifacts.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so both the compiled app and the plain-.mjs MCP can name these files, and
// this file is what keeps `npm run type-check` a real gate over the TypeScript
// caller (`playwright-runner.ts`).

/** The heal map for one run: what the heal fixture reads through
 *  `GLAZE_HEAL_MAP`. Keyed by RUN, not by test — two runs of one test can be in
 *  flight at once. */
export declare function healMapFileName(runId: string): string;

/** The directory the heal fixture writes `heals.json` and `matches.json` into,
 *  pointed at by `GLAZE_HEAL_DIR`. */
export declare function healDirName(runId: string): string;

/** What the heal fixture writes each heal and failed attempt into, inside
 *  `GLAZE_HEAL_DIR`. */
export declare const HEAL_EVENTS_FILE: string;

/** What the heal fixture writes each failing locator's match set into. */
export declare const HEAL_MATCHES_FILE: string;

/** A heal that happened: a candidate was applied and the step got past. */
export declare function isHeal(event: unknown): boolean;

/** A failed attempt — `exhausted` or `no-candidates`. Keyed on the outcomes
 *  that exist, so an unrecognised value counts as neither. */
export declare function isHealFailure(event: unknown): boolean;

/** What an unattended run writes its SUCCESSFUL heals into, in the run's
 *  artifact directory — evidence for `good-looks ingest` to promote into the
 *  journal on the machine that owns the library. */
export declare const RUN_HEALS_FILE: string;

/** The envelope `heal-failures.json`, `step-matches.json` and `run-heals.json`
 *  are written in. */
export declare function healArtifactEnvelope<T>(
  testId: string,
  runId: string,
  entries: readonly T[],
): { testId: string; runId: string; entries: readonly T[] };
