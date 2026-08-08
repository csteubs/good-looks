// The generated `playwright.config.ts` that sits next to the specs.
//
// Its own module, with no imports, for one reason: TWO processes write this
// exact path in the shared scripts dir — the app (playwright-runner.ts) and the
// standalone MCP server (mcp/server.mjs, which carries its own copy because it
// must run without the app build). Whichever wrote last is the one Playwright
// reads, so if the two ever disagree, a feature that depends on a config field
// works or doesn't depending on which process happened to run more recently.
// `npm run check:runner-config` pins them equal.
//
// Everything here is driven by environment variables rather than baked in,
// because one file is shared by every run:
//
//  • PW_TEST_TIMEOUT_MS — the app also passes `--timeout`, which wins; the
//    config reads it too so a hand-run outside the app gets a sane limit rather
//    than Playwright's built-in 30s.
//  • PW_OUTPUT_DIR — Playwright derives its scratch directory from the SPEC's
//    path by default, so two runs of one spec would write to (and clean) the
//    same folder. Batch runs can now be parallel, so each run passes its own.
//  • PW_SLOWMO_MS — the test CLI has no --slow-mo flag; launchOptions.slowMo
//    only comes from config.
export const PLAYWRIGHT_CONFIG_SOURCE =
  'import { defineConfig } from "@playwright/test";\n\n' +
  "export default defineConfig({\n" +
  "  timeout: Number(process.env.PW_TEST_TIMEOUT_MS || 60000),\n" +
  '  outputDir: process.env.PW_OUTPUT_DIR || "test-results",\n' +
  "  use: {\n" +
  "    launchOptions: {\n" +
  "      slowMo: Number(process.env.PW_SLOWMO_MS || 0),\n" +
  "    },\n" +
  "  },\n" +
  "});\n";
