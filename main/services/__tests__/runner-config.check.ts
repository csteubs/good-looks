// Standalone regression check: the app and the MCP server write the SAME
// playwright.config.ts.
//
// Both processes write `<scriptsDir>/playwright.config.ts` and they share that
// directory. Whichever ran last is the file Playwright actually reads. So a
// field that exists in one copy and not the other doesn't fail; it works
// intermittently, depending on which process happened to run more recently,
// which is close to the worst way for a bug to present.
//
// That was live for `outputDir`: parallel batch runs depend on it to keep each
// run's Playwright scratch directory separate, and a config missing it silently
// puts them all back in one shared folder.
//
// HOW THIS CHECK CHANGED, 2026-08-07. It used to compare two copies — one in
// main/services, one in mcp/ — because the MCP server "must run without the app
// build" and so was assumed unable to import from main/. True, but it can
// import from `shared/`: plain ESM with a hand-written `.d.mts` and no build
// step, exactly what mcp/select-tests.mjs has always been. The copies collapsed
// into shared/playwright-config-source.mjs, so there is nothing left to compare
// — and what this now guards is that no second copy comes back, which is the
// property that actually keeps the two in step.
//
// Pure modules on both sides (no @glaze/core/backend, no MCP transport), so
// this runs under plain tsx. Run with: npm run check:runner-config

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { playwrightConfigSource } from "../../../shared/playwright-config-source.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── One definition, and both writers reach it ─────────────────────────

for (const [label, relPath] of [
  ["the app runner", "main/services/playwright-runner.ts"],
  ["the MCP server", "mcp/run-tests.mjs"],
] as const) {
  const src = readFileSync(resolve(process.cwd(), relPath), "utf8");
  assert(
    src.includes("playwright-config-source.mjs"),
    `${label} writes the shared config source`,
  );
  // The failure mode this replaces the old byte-comparison with: someone adds a
  // field to one side by inlining a fresh copy of the config next to the write.
  // It would be right the day it was written and silent forever after.
  assert(
    !/defineConfig\(\{/.test(src),
    `${label} does not inline a config of its own`,
  );
}

// ── The fields something depends on ───────────────────────────────────
//
// Named individually as well as being shared, so that deleting a field — which
// keeps the two writers in agreement — still fails here rather than passing
// quietly. Each of these is a behaviour something depends on.

const required: [string, string][] = [
  ["outputDir", 'outputDir: process.env.PW_OUTPUT_DIR || "test-results"'],
  ["timeout", "timeout: Number(process.env.PW_TEST_TIMEOUT_MS || 60000)"],
  ["slowMo", "slowMo: Number(process.env.PW_SLOWMO_MS || 0)"],
  // An imported spec navigates relative to a baseURL that lived in ITS project's
  // config. Without this line the config declares none and every such
  // navigation fails in Playwright's protocol layer, naming neither.
  ["baseURL", "baseURL: process.env.PW_BASE_URL || undefined"],
];
for (const [name, line] of required) {
  assert(playwrightConfigSource.includes(line), `the config still sets ${name} from the environment`);
}

// The env indirection is the point: a hard-coded value would apply to every
// run at once, and these files are shared by all of them.
assert(
  !/outputDir:\s*["']/.test(playwrightConfigSource),
  "outputDir is never hard-coded (every run needs its own)",
);

// ── The one option that must never appear here ───────────────────────
//
// `use.extraHTTPHeaders` is CONTEXT-WIDE, so putting the Shopify crawler
// signature (or any other credential) here would send it to every host the page
// touches — a storefront's CDN, its analytics, its chat widget. Headers that
// belong to one host are attached per request by glaze-signature.mjs instead.
//
// It is also the drift this file exists to stop: the MCP server writes this
// same config and can never set an env var it cannot decrypt, so an
// env-driven header here would work in the app and silently not in the MCP.
// check:mcp-parity would not catch it — that scans the generated SPEC's
// `process.env` references, and this file is not a spec.
assert(
  !playwrightConfigSource.includes("extraHTTPHeaders"),
  "the shared config sets no extraHTTPHeaders — per-host headers go through the run fixture",
);

// Both writers have to actually SET the per-run output dir, or the config's
// fallback puts every concurrent run back in one shared folder.
for (const [label, relPath] of [
  ["the app runner", "main/services/playwright-runner.ts"],
  ["the MCP run planner", "mcp/run-plan.mjs"],
] as const) {
  const src = readFileSync(resolve(process.cwd(), relPath), "utf8");
  assert(src.includes("PW_OUTPUT_DIR"), `${label} passes a per-run PW_OUTPUT_DIR`);
}

// The MCP's runner is asked a DIFFERENT question, because it does not name the
// variable — `runEnv` does, and it emits nothing when handed no directory
// (`...(outputDir ? { PW_OUTPUT_DIR: outputDir } : {})`). So what has to be true
// here is that `executeTest` derives a per-RUN directory and hands it over.
//
// This entry used to sit in the loop above against `mcp/server.mjs`, where it
// matched a COMMENT mentioning the variable and nothing else — green whatever
// the code did, which is the failure this whole file exists to catch, one level
// up. Confirmed by deleting the real wiring and watching it stay green.
{
  const src = readFileSync(resolve(process.cwd(), "mcp/run-tests.mjs"), "utf8");
  assert(
    /const outputDir = path\.join\([^)]*runId\)/.test(src),
    "the MCP runner derives the output dir from the RUN's own id, not the test's",
  );
  assert(
    /runEnv\(\{[\s\S]*?\n\s*outputDir,/.test(src),
    "…and hands it to runEnv, which emits PW_OUTPUT_DIR only when it gets one",
  );
}

// Same shape, same reason, for the base URL an imported test runs against.
// Setting it in one writer only is the drift this whole file exists to catch:
// the same imported test would pass from the app and fail from the MCP, or the
// reverse, depending on nothing the user can see.
for (const [label, relPath] of [
  ["the app runner", "main/services/playwright-runner.ts"],
  ["the MCP run planner", "mcp/run-plan.mjs"],
] as const) {
  const src = readFileSync(resolve(process.cwd(), relPath), "utf8");
  assert(src.includes("PW_BASE_URL"), `${label} passes the test's PW_BASE_URL`);
}

// The value has to come off the RECORD in both. A hard-coded or globally
// configured base URL would be one address for a library of imported projects.
for (const [label, relPath, needle] of [
  ["the app runner", "main/services/playwright-runner.ts", "rec.baseUrl"],
  ["the MCP server", "mcp/run-tests.mjs", "test.baseUrl"],
] as const) {
  const src = readFileSync(resolve(process.cwd(), relPath), "utf8");
  assert(src.includes(needle), `${label} reads the base URL from the test record`);
}

// ── The installer and the runner look in ONE directory ──────────────────
//
// R11 added a third caller of "where do this library's browsers live": the
// install unpacks there, `isBrowserInstalled` reads it, and `executeTest` tells
// Playwright to launch from it. It was already spelled out twice before the
// installer arrived.
//
// Two spellings fail in the worst available way — `good-looks install chromium`
// reports success, and the very next run says chromium is not installed. There
// is no error anywhere in that loop, and the obvious next move (install again)
// makes no difference.
{
  const src = readFileSync(resolve(process.cwd(), "mcp/run-tests.mjs"), "utf8");
  const derivations = [...src.matchAll(/path\.join\(dataDir,\s*"recorder",\s*"browsers"\)/g)];
  assert(
    derivations.length === 1,
    derivations.length === 1
      ? "the browsers directory is derived exactly once in the MCP runner"
      : `the browsers directory is derived ${derivations.length} times — the installer and ` +
        `the runner can now disagree, which fails as "installed, and still not installed"`,
  );
  // …and every consumer goes through it. Deriving once and then hand-writing
  // the path at one call site would satisfy the count above.
  const uses = [...src.matchAll(/browsersDir\(\)/g)].length;
  assert(
    uses >= 4,
    `the install, the detection and the run all read browsersDir() (${uses} references)`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll runner-config checks passed");
