// Types for script-path.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so the app, the MCP server and the CLI locate a spec by one rule, and
// this file is what keeps `npm run type-check` a real gate over the TypeScript
// callers (test-store.ts, playwright-runner.ts, import-service.ts).

/** The directory an imported test's own sandbox sits in, under the scripts dir. */
export declare const IMPORTED_SEGMENT: string;

/** Where a library keeps its specs, given its recorder directory. */
export declare function scriptsDirFor(recorderDir: string): string;

/** Whether a record id is safe to build a path from. Ids are uuids in
 *  practice, but a copied bundle's `tests.json` was written elsewhere. */
export declare function isSafeId(id: unknown): boolean;

/** Where a record's spec sits relative to the scripts directory, as segments,
 *  or null when the id itself is unusable. */
export declare function scriptRelSegments(record: {
  id?: string;
  scriptPath?: string;
}): string[] | null;

/** Whether `candidate` is `scriptsDir` itself or sits underneath it, on
 *  resolved paths and requiring a separator at the boundary. */
export declare function isInsideScripts(
  scriptsDir: string,
  candidate: string | undefined,
): boolean;

/** The absolute path to a record's spec ON THIS MACHINE: the stored path when
 *  it is usable here, the derived position otherwise, and null when the record
 *  names no spec this reader could find. */
export declare function resolveScriptPath(
  scriptsDir: string,
  record: { id?: string; scriptPath?: string },
): string | null;
