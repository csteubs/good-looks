// How fast a run goes, and how long it is allowed to take.
//
// The definitions MOVED to shared/run-pacing.mjs on 2026-08-07, so the
// standalone MCP server can import the same ones instead of keeping a copy.
// This file is now the app's import surface for them and nothing else: it exists
// so `./run-pacing.js` keeps meaning what it meant to playwright-runner.ts and
// to check:crawl-speed, and so the move is invisible to the app side.
//
// Add nothing here. Anything pure belongs in shared/ where both sides can reach
// it; anything impure belongs with the service that does the I/O.

export {
  CRAWL_MIN_TEST_TIMEOUT_MS,
  DEFAULT_TEST_TIMEOUT_MS,
  MAX_TEST_TIMEOUT_MS,
  MIN_TEST_TIMEOUT_MS,
  SLOW_MO_MS,
  clampTestTimeoutMs,
  isTestTimeoutMs,
  resolveTestTimeoutMs,
  slowMoFor,
} from "../../shared/run-pacing.mjs";
