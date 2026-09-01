// Types for propagations.mjs.
//
// Hand-written like the other .d.mts files here: the server is plain ESM with
// no build step, and this exists so the vitest suite consumes these with types
// rather than `any`.

export declare const SITE_CHANGING_MIN_TESTS: number;

export interface PropagationDigestOptions {
  testId?: string;
  status?: string;
  limit?: number;
  nameOf?: (testId: string) => string | null;
}

export interface PropagationDigestSite {
  origin: string;
  proposals: number;
  tests: number;
}

export interface PropagationDigest {
  total: number;
  pending: number;
  sitesChanging: PropagationDigestSite[];
  entries: Array<Record<string, unknown>>;
}

/** The `list_propagations` payload: the picked entries, rebuilt for the wire,
 *  plus the site-level aggregate a chronological list hides. */
export declare function propagationDigest(
  entries: unknown[],
  options?: PropagationDigestOptions,
): PropagationDigest;
