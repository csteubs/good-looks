// Standalone regression check: the app and the MCP server write the SAME
// playwright.config.ts.
//
// Both processes write `<scriptsDir>/playwright.config.ts` — the app on every
// run, the MCP server whenever its copy differs — and they share that directory.
// Whichever ran last is the file Playwright actually reads. So a field that
// exists in one copy and not the other doesn't fail; it works intermittently,
// depending on which process happened to run more recently, which is close to
// the worst way for a bug to present.
//
// That is live right now for `outputDir`: parallel batch runs depend on it to
// keep each run's Playwright scratch directory separate, and a config missing
// it silently puts them all back in one shared folder.
//
// Pure modules on both sides (no @glaze/core/backend, no MCP transport), so
// this runs under plain tsx. Run with: npm run check:runner-config

import { PLAYWRIGHT_CONFIG_SOURCE as appConfig } from "../playwright-config-source.js";
import { PLAYWRIGHT_CONFIG_SOURCE as mcpConfig } from "../../../mcp/playwright-config.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

assert(appConfig === mcpConfig, "the app and the MCP server write an identical config");

// Named individually as well as compared, so that deleting a field from BOTH
// copies — which keeps them equal — still fails here rather than passing
// quietly. Each of these is a behaviour something depends on.
const required: [string, string][] = [
  ["outputDir", 'outputDir: process.env.PW_OUTPUT_DIR || "test-results"'],
  ["timeout", "timeout: Number(process.env.PW_TEST_TIMEOUT_MS || 60000)"],
  ["slowMo", "slowMo: Number(process.env.PW_SLOWMO_MS || 0)"],
];
for (const [name, line] of required) {
  assert(appConfig.includes(line), `the config still sets ${name} from the environment`);
}

// The env indirection is the point: a hard-coded value would apply to every
// run at once, and these files are shared by all of them.
assert(
  !/outputDir:\s*["']/.test(appConfig),
  "outputDir is never hard-coded (every run needs its own)",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll runner-config checks passed");
