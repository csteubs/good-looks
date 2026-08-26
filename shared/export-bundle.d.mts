// Types for export-bundle.mjs.
//
// Hand-written, like every .d.mts here: the implementation is plain ESM so the
// CLI can import it with no build step, and this file is what keeps
// `npm run type-check` a real gate over the TypeScript callers.

/** Where a bundle's record file sits, relative to the bundle root. */
export declare const BUNDLE_TESTS_FILE: string;

/** Where a bundle's specs sit, relative to the bundle root. */
export declare const BUNDLE_SCRIPTS_DIR: string;

/** The record fields a bundle carries, because the unattended run path reads
 *  them. An allowlist: an exported record is REBUILT from these, never spread
 *  and pruned. */
export declare const EXPORTED_FIELDS: readonly string[];

/** Fields deliberately withheld, keyed by name with the reason as the value.
 *  `check:export-egress` requires this and EXPORTED_FIELDS together to account
 *  for every key of TestRecord. */
export declare const WITHHELD_FIELDS: Readonly<Record<string, string>>;

/** A path as written INTO a bundle: forward slashes on every platform. */
export declare function bundlePath(segments: string[]): string;

/** One exported record and where its spec sits, or null when the record names
 *  no path that can be built safely. */
export declare function bundleRecord(record: Record<string, unknown>): {
  record: Record<string, unknown>;
  specSegments: string[];
} | null;

/** What one test contributes to the bundle's scripts directory — its own spec,
 *  or an imported test's whole sandbox. */
export declare function specSource(
  record: Record<string, unknown>,
): { kind: "file"; segments: string[] } | { kind: "tree"; segments: string[] } | null;

/** Names of the secret variables a test declares. Values never travel. */
export declare function secretNames(record: Record<string, unknown>): string[];

/** Plan a bundle from a library's tests.json. */
export declare function planExport(tests: unknown): {
  records: Record<string, unknown>[];
  specs: { kind: string; segments: string[]; id: string }[];
  unusable: { id: unknown; name: unknown }[];
  needsSecrets: { id: string; name: string; names: string[] }[];
};

/** Where a spec lands inside the bundle, given the bundle root. */
export declare function bundleSpecPath(root: string, segments: string[]): string;
