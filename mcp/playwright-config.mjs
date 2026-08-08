// The MCP server's copy of the generated `playwright.config.ts`.
//
// A copy on purpose: this server is standalone .mjs by design — it must run
// without the app's build — so it cannot import main/services. Pure, like
// select-tests.mjs, so `npm run check:runner-config` can pin it byte-for-byte
// against main/services/playwright-config-source.ts. See that file for why the
// two agreeing matters.
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
