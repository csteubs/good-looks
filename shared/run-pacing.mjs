// How fast a run goes, and how long it is allowed to take.
//
// THE FIRST FILE IN shared/. The admission rule for this directory is PURE
// ONLY: no `fs`, no `@glaze/core`, no IPC, no `process`. Anything needing the
// filesystem stays on its own side of the boundary and hands data in.
//
// Plain ESM with a hand-written `.d.mts` beside it, following the precedent set
// by mcp/select-tests.mjs and mcp/debug-shots.mjs. That shape is what lets ONE
// definition be imported by both the app's TypeScript backend (compiled by
// Vite/tsc against @glaze/core) and the standalone `mcp/*.mjs` server (no build
// step, no SDK), while `npm run type-check` still checks every caller.
//
// This module used to be main/services/run-pacing.ts, reachable only from the
// app — so mcp/server.mjs kept its own copy of the delay table, pinned by a
// text-scraping assertion in check:crawl-speed because a copy is all a check
// can pin. It also never got the timeout half at all, so every MCP run used
// Playwright's default no matter what the test said. One import replaces both.
//
// The two decisions here are related and must stay together: the step delay is
// what makes a run long, and the timeout is what tolerates it. Setting one
// without the other is how "crawl" ended up meaning "the resilient speed fails".

/** Delay (ms) Playwright inserts between actions via `launchOptions.slowMo`, so
 *  a "slow" run is easy to follow with the naked eye and "fast" matches the
 *  original default (no artificial delay). "crawl" is roughly double "slow",
 *  and is the smaller half of what that speed does — the page-settling waits
 *  (see settle-fixture-source.ts) are the rest. */
/**
 * Which pace a run actually goes at, given the three places it can come from.
 *
 * Most specific first, and each layer means something different:
 *   • `override` — this run only. Set from the detail view's Pace control or
 *     over `runner:run`; never written back to the test, because "run this one
 *     slowly while I watch it" is a decision about one run.
 *   • `pinned` — the test's own `speed`, set from the sidebar's speed menu. A
 *     test that has one keeps it whatever the setting later becomes.
 *   • `fallback` — the global default, which is what an UNPINNED test inherits.
 *     Recordings stopped stamping their speed for this reason (R18): stamping
 *     froze every test at the default of the day it was recorded.
 *
 * `"fast"` is the floor for a caller with no setting to read at all — the MCP,
 * and anything predating the setting. Anything unrecognised at any layer is
 * ignored rather than passed on, since an unknown key reaching `SLOW_MO_MS`
 * resolves to `undefined` and runs the test at full speed, which is the exact
 * opposite of what someone asking for `crawl` wanted.
 */
export function resolveRunSpeed(override, pinned, fallback) {
  for (const candidate of [override, pinned, fallback]) {
    if (candidate && Object.prototype.hasOwnProperty.call(SLOW_MO_MS, candidate)) {
      return candidate;
    }
  }
  return "fast";
}

export const SLOW_MO_MS = {
  fast: 0,
  medium: 400,
  slow: 1200,
  crawl: 2500,
};

/** Bounds for the Playwright per-test timeout. 5s is the floor so a fat-fingered
 *  "1" can't make every run fail instantly; 30 min is high enough for long
 *  multi-step flows without letting a wedged process sit forever. */
export const MIN_TEST_TIMEOUT_MS = 5_000;
export const MAX_TEST_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;

/**
 * Floor on the per-test timeout for a "crawl" run.
 *
 * Crawl waits for load, network quiet and a painted frame after EVERY action,
 * on top of a 2.5s step delay. A twenty-step test that finished in 40s on
 * "slow" can pass several minutes on "crawl" — so against the default 60s
 * timeout, choosing the speed built for resilience would make tests fail. This
 * floor is what stops the feature from doing the opposite of its purpose.
 */
export const CRAWL_MIN_TEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Clamp a Playwright per-test timeout. Shared so the per-test handler, the
 *  runner and the MCP server share one definition of "valid". */
export function clampTestTimeoutMs(n) {
  return Math.min(MAX_TEST_TIMEOUT_MS, Math.max(MIN_TEST_TIMEOUT_MS, Math.round(n)));
}

/** True when `n` is a finite number in the accepted timeout range (pre-clamp). */
export function isTestTimeoutMs(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_TEST_TIMEOUT_MS;
}

/**
 * The per-test timeout for one run: explicit per-test value → global Settings
 * default → 1 minute, then the crawl floor.
 *
 * The floor is a FLOOR, not an override: a longer timeout, from Settings or set
 * on the test, is left exactly as it was.
 *
 * `raised` reports whether the floor actually moved the number, so the caller
 * can say so in its output. A timeout that silently changed itself is worse
 * than a slow run — the user set thirty seconds, watched four minutes go by,
 * and had nothing to read that explained it.
 */
export function resolveTestTimeoutMs(perTest, settingsDefault, speed) {
  // Clamped here as well as at the handler so a hand-edited tests.json can't
  // smuggle an out-of-range value past it into the Playwright CLI.
  const chosen = isTestTimeoutMs(perTest)
    ? clampTestTimeoutMs(perTest)
    : isTestTimeoutMs(settingsDefault)
      ? clampTestTimeoutMs(settingsDefault)
      : DEFAULT_TEST_TIMEOUT_MS;
  if (speed !== "crawl") return { timeoutMs: chosen, raised: false };
  // Clamp the floor too: the app-wide maximum is the ceiling for every timeout
  // this app runs with, and a floor is not a licence to exceed it.
  const floor = clampTestTimeoutMs(CRAWL_MIN_TEST_TIMEOUT_MS);
  return chosen >= floor
    ? { timeoutMs: chosen, raised: false }
    : { timeoutMs: floor, raised: true };
}

/** The step delay for a speed, defaulting to "fast" for an absent or unknown
 *  one. A bare `SLOW_MO_MS[speed] ?? 0` at each call site is how the MCP server
 *  turned an unrecognised speed into a FULL-SPEED run of a test the user had
 *  deliberately slowed down — silently, since 0 is also a legitimate delay. */
export function slowMoFor(speed) {
  return SLOW_MO_MS[speed] ?? SLOW_MO_MS.fast;
}
