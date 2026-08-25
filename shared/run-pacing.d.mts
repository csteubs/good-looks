// Types for run-pacing.mjs.
//
// Hand-written, like mcp/select-tests.d.mts: the implementation is plain ESM so
// the standalone MCP server can import it without a build step, and this file is
// what keeps `npm run type-check` a real gate over every TypeScript caller.
//
// A type-only import of `TestSpeed` — erased at runtime, so the .mjs stays free
// of any dependency on main/. Keying SLOW_MO_MS by the union rather than by
// `string` is the point: a speed added to the union with no delay here is a
// compile error, instead of an `undefined` that reads as zero at run time.

import type { TestSpeed } from "../main/recorder/types.js";

export declare const SLOW_MO_MS: Record<TestSpeed, number>;

export declare const MIN_TEST_TIMEOUT_MS: number;
export declare const MAX_TEST_TIMEOUT_MS: number;
export declare const DEFAULT_TEST_TIMEOUT_MS: number;
export declare const CRAWL_MIN_TEST_TIMEOUT_MS: number;

export declare function clampTestTimeoutMs(n: number): number;

export declare function isTestTimeoutMs(n: unknown): n is number;

export declare function resolveTestTimeoutMs(
  perTest: unknown,
  settingsDefault: unknown,
  speed: TestSpeed,
): { timeoutMs: number; raised: boolean };

export declare function slowMoFor(speed: TestSpeed | string | undefined): number;

/** Which pace a run goes at: this run's override, then the test's own pin, then
 *  the global default, then `"fast"`. Anything unrecognised at any layer is
 *  skipped rather than passed on — an unknown key reaching `SLOW_MO_MS` runs the
 *  test at full speed, the opposite of what asking for `crawl` meant. */
export declare function resolveRunSpeed(
  override: string | undefined,
  pinned: string | undefined,
  fallback: string | undefined,
): TestSpeed;
