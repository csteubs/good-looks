// The playwright.config.ts written next to the generated specs.
//
// Pure (see the admission rule in run-pacing.mjs) — a string, not a file
// writer. Whoever writes it owns the I/O.
//
// Shared because the app and the MCP server write THE SAME FILE, in the same
// scripts directory, and whichever ran last wins. Two spellings of this config
// is therefore not a tidiness problem but a silent behaviour change depending
// on which process last touched the disk: the MCP's copy carried no `timeout`
// line at all, so an app run that fell back to the config (rather than passing
// `--timeout`) would get Playwright's built-in 30s.
//
// Playwright's test CLI has no --slow-mo flag; `launchOptions.slowMo` only ever
// comes from config, which is why this file has to exist at all. The per-test
// timeout CAN be set via --timeout (and is, by both callers); it is read from
// the environment here as well so a hand-run of the generated config outside
// the app still picks up a sensible default.

import { DEFAULT_TEST_TIMEOUT_MS } from "./run-pacing.mjs";

export const PLAYWRIGHT_CONFIG_FILE = "playwright.config.ts";

export const playwrightConfigSource =
  'import { defineConfig } from "@playwright/test";\n\n' +
  "export default defineConfig({\n" +
  `  timeout: Number(process.env.PW_TEST_TIMEOUT_MS || ${DEFAULT_TEST_TIMEOUT_MS}),\n` +
  "  use: {\n" +
  "    launchOptions: {\n" +
  "      slowMo: Number(process.env.PW_SLOWMO_MS || 0),\n" +
  "    },\n" +
  "  },\n" +
  "});\n";
