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
