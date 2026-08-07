// How fast a run goes, and how long it is allowed to take.
//
// Split out of playwright-runner.ts because it is pure policy — two small
// decisions with no I/O — while the runner it came from reaches the visual
// pipeline, the artifact store and the Playwright CLI. Testing a timeout rule
// should not require bundling a PNG decoder.
//
// The two decisions are related and must stay together: the step delay is what
// makes a run long, and the timeout is what tolerates it. Setting one without
// the other is how "crawl" ended up meaning "the resilient speed fails".

import {
  clampTestTimeoutMs,
  DEFAULT_TEST_TIMEOUT_MS,
  isTestTimeoutMs,
} from "./recorder-settings-store.js";
import type { TestSpeed } from "../recorder/types.js";

/** Delay (ms) Playwright inserts between actions via `launchOptions.slowMo`, so
 *  a "slow" run is easy to follow with the naked eye and "fast" matches the
 *  original default (no artificial delay). "crawl" is roughly double "slow",
 *  and is the smaller half of what that speed does — the page-settling waits
 *  (see settle-fixture-source.ts) are the rest. */
export const SLOW_MO_MS: Record<TestSpeed, number> = {
  fast: 0,
  medium: 400,
  slow: 1200,
  crawl: 2500,
};

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

/**
 * The per-test timeout for one run: explicit per-test value → global Settings
 * default → 1 minute, then the crawl floor.
 *
 * The floor is a FLOOR, not an override: a longer timeout, from Settings or set
 * on the test, is left exactly as it was.
 *
 * `raised` reports whether the floor actually moved the number, so the runner
 * can say so in the output. A timeout that silently changed itself is worse
 * than a slow run — the user set thirty seconds, watched four minutes go by,
 * and had nothing to read that explained it.
 */
export function resolveTestTimeoutMs(
  perTest: unknown,
  settingsDefault: unknown,
  speed: TestSpeed,
): { timeoutMs: number; raised: boolean } {
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
