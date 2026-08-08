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

import { DEFAULT_TEST_TIMEOUT_MS } from "./run-pacing.mjs";

export const PLAYWRIGHT_CONFIG_FILE = "playwright.config.ts";

export const playwrightConfigSource =
  'import { defineConfig } from "@playwright/test";\n\n' +
  "export default defineConfig({\n" +
  `  timeout: Number(process.env.PW_TEST_TIMEOUT_MS || ${DEFAULT_TEST_TIMEOUT_MS}),\n` +
  '  outputDir: process.env.PW_OUTPUT_DIR || "test-results",\n' +
  "  use: {\n" +
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
