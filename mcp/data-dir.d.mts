// Types for data-dir.mjs.
//
// Hand-written, in the shape `shared/*.d.mts` uses and for the same reason: the
// implementation is plain ESM because the MCP server runs from source with no
// build step, and this file is what keeps `npm run type-check` a real gate over
// the TypeScript caller — `check:mcp-parity`, which imports these to compare
// this resolver against the app's.

/** The app's name as Electron computes it: `productName` if present, else
 *  `name`. `projectRoot` defaults to this file's own repository root, and is a
 *  parameter because a bundling caller moves `import.meta.url`. */
export declare function appName(projectRoot?: string): string;

/** Where Electron would put userData on this platform, for this app. */
export declare function electronDefaultDir(name?: string, platform?: string): string;

/** Whether a directory holds the recorder's own state. Mirrors the app's. */
export declare function hasRecorderStore(dir: string): boolean;

/** Glaze-era directories that hold a store, most recently used first. */
export declare function findLegacyStores(appSupportRoot: string): string[];

export declare function resolveDataDirChoice(
  env?: Record<string, string | undefined>,
  platform?: string,
): import("../shared/user-data-rules.d.mts").DataDirChoice;

/** The data directory, or a thrown error naming every place it looked. */
export declare function resolveDataDir(
  env?: Record<string, string | undefined>,
  platform?: string,
): string;

export declare function readJsonFile<T>(dataDir: string, fileName: string, fallback: T): T;
export declare function writeJsonFile(dataDir: string, fileName: string, value: unknown): void;
