/** What `good-looks run` was asked to do, once the arguments are known good. */
export interface RunOptions {
  testIds?: string[];
  tag?: string;
  group?: string;
  browser?: string;
  speed?: string;
  parallel?: number;
  allDatasets?: true;
  json: boolean;
}

export type ParsedRunArgs =
  | { ok: true; options: RunOptions }
  | { ok: false; error: string }
  /** `--help` is a request that succeeded, not a parse failure — and it is
   *  scanned for before anything can be rejected. */
  | { ok: "help" };

export declare function parseRunArgs(argv: string[]): ParsedRunArgs;

export declare const RUN_USAGE: string;

export interface InstallOptions {
  browser: string;
  withDeps: boolean;
}

export type ParsedInstallArgs =
  | { ok: true; options: InstallOptions }
  | { ok: false; error: string }
  | { ok: "help" };

export declare function parseInstallArgs(argv: string[]): ParsedInstallArgs;

export declare const INSTALL_USAGE: string;
