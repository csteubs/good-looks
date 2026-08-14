// Types for user-data-rules.mjs.
//
// Hand-written, like the other `shared/*.d.mts`: the implementation is plain
// ESM so the standalone MCP server can import it without a build step, and this
// file is what keeps `npm run type-check` a real gate over the TypeScript
// caller (`main/shell/user-data.ts`).

export declare const USERDATA_OVERRIDE_ENV: string;
export declare const STORE_SUBDIR: string;
export declare const STORE_MARKERS: readonly string[];
export declare const LEGACY_DIR_RE: RegExp;

/** Why the chosen directory was chosen. Reported rather than inferred, because
 *  `adopted-legacy` is the one the app has to say out loud — silently reading
 *  another directory is worse than the bug it fixes if nobody can tell. */
export type DataDirReason = "override" | "own-store" | "adopted-legacy" | "default";

export interface DataDirInputs {
  /** `USERDATA_OVERRIDE_ENV`, if set. */
  override?: string | undefined;
  /** Where the platform would put it. */
  defaultDir: string;
  /** Whether `defaultDir` already holds a recorder store. */
  defaultHasStore: boolean;
  /** Legacy directories that hold a store, most recently used FIRST. */
  legacyDirs?: readonly string[];
}

export interface DataDirChoice {
  dir: string;
  reason: DataDirReason;
  /** Set only when `reason` is `"adopted-legacy"`. */
  legacy?: string;
}

export declare function chooseDataDir(found: DataDirInputs): DataDirChoice;
