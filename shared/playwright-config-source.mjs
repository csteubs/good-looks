// The playwright.config.ts written next to the generated specs.
//
// Pure (see the admission rule in run-pacing.mjs) — a string, not a file
// writer. Whoever writes it owns the I/O.
//
// ONE definition, because TWO processes write this exact path in the shared
// scripts dir: the app (playwright-runner.ts) and the standalone MCP server.
// Whichever wrote last is the one Playwright reads, so if the copies ever
// disagree, a feature depending on a config field works or doesn't depending on
// which process happened to run more recently — close to the worst way for a
// bug to present. That was live: the MCP's copy carried no `timeout` line at
// all.
//
// This was independently found and fixed twice, and the two fixes met in a
// merge on 2026-08-07. The other one kept a copy per process and pinned them
// byte-equal with `check:runner-config`, on the reasoning that the MCP "must
// run without the app build" so it cannot import from main/. True — but it can
// import from shared/, which is plain ESM with a hand-written .d.mts and no
// build step, exactly as mcp/select-tests.mjs has always been. So the copies
// collapsed into this file and the check now guards that there is only one.
//
// Everything is driven by environment variables rather than baked in, because
// one file is shared by every run:
//
//  • PW_TEST_TIMEOUT_MS — the app also passes `--timeout`, which wins; the
//    config reads it too so a hand-run outside the app gets a sane limit rather
//    than Playwright's built-in 30s.
//  • PW_OUTPUT_DIR — Playwright derives its scratch directory from the SPEC's
//    path by default, so two runs of one spec would write to (and clean) the
//    same folder. Batch runs can be parallel, so each run passes its own.
//  • PW_SLOWMO_MS — the test CLI has no --slow-mo flag; launchOptions.slowMo
//    only ever comes from config, which is why this file has to exist at all.
//  • PW_EXPECT_TIMEOUT_MS — see DEFAULT_EXPECT_TIMEOUT_MS below.

import { DEFAULT_TEST_TIMEOUT_MS } from "./run-pacing.mjs";

export const PLAYWRIGHT_CONFIG_FILE = "playwright.config.ts";

/**
 * How long a web-first assertion retries before failing.
 *
 * Playwright's built-in default is 5s, and leaving it there put the app's own
 * two halves at odds: an explicit "wait until…" step generates a 10s timeout
 * (`DEFAULT_WAIT_TIMEOUT_MS`), on the stated reasoning that a user reaching for
 * a wait is waiting on something slow. But the ASSERTION that step is usually
 * followed by got half that budget — and after a navigating click, the
 * assertion IS the navigation wait, which is exactly the slow case. Matching
 * the two removes a timing cliff that had nothing to do with what was being
 * asserted.
 *
 * Still short of the test timeout by a wide margin, so a genuinely stuck
 * assertion reports as an assertion failure with the actual value rather than
 * as an opaque test timeout.
 */
export const DEFAULT_EXPECT_TIMEOUT_MS = 10_000;

export const playwrightConfigSource =
  'import { defineConfig } from "@playwright/test";\n\n' +
  "export default defineConfig({\n" +
  `  timeout: Number(process.env.PW_TEST_TIMEOUT_MS || ${DEFAULT_TEST_TIMEOUT_MS}),\n` +
  '  outputDir: process.env.PW_OUTPUT_DIR || "test-results",\n' +
  "  expect: {\n" +
  `    timeout: Number(process.env.PW_EXPECT_TIMEOUT_MS || ${DEFAULT_EXPECT_TIMEOUT_MS}),\n` +
  "  },\n" +
  "  use: {\n" +
  // An IMPORTED spec navigates the way its own project did — `page.goto("/")`,
  // relative to a `baseURL` that lived in that project's config and does not
  // survive being copied here. Without it Playwright fails in the protocol
  // layer, naming neither the config nor the missing field.
  //
  // Per-RUN via the environment rather than baked in, for the same reason as
  // every other value in this file: one config serves every test, and each test
  // carries its own base URL (or none). Empty is falsy, so a recorded test —
  // which always navigates to an absolute URL — is unaffected, and a hand-run
  // outside the app behaves exactly as it does today.
  "    baseURL: process.env.PW_BASE_URL || undefined,\n" +
  // For a HAND-RUN, which is the same reason `timeout` is read from the env
  // here rather than left to Playwright's 30s default: this file is also what
  // somebody gets when they run the spec themselves outside the app, and a
  // trace is the best failure artifact Playwright produces.
  //
  // It is NOT an app artifact, and the first version of this comment wrongly
  // claimed it answered the AI-debug session's request for page evidence. An
  // app-driven run writes the trace into `PW_OUTPUT_DIR`, which the runner
  // deletes in its `finally` (playwright-runner.ts) — as does the MCP server.
  // Nothing reads it, no IPC exposes it, and no prompt mentions it. Retaining
  // it is a feature with real storage and retention consequences, not a config
  // line; see DECISIONS 2026-08-14.
  '    trace: "retain-on-failure",\n' +
  "    launchOptions: {\n" +
  "      slowMo: Number(process.env.PW_SLOWMO_MS || 0),\n" +
  "    },\n" +
  "  },\n" +
  "});\n";

// The WRITE deliberately stays with each caller. Both already have one suited
// to them — the app's `writeIfChanged` in playwright-runner.ts, which every
// other fixture goes through too, and the MCP's own — and both are
// write-if-different via an atomic rename, which matters now that batch lanes
// run concurrently: an unconditional write can truncate the file while another
// lane's Playwright process is reading it.
//
// Only the CONTENT needs to be shared, because only the content is what drifted.
