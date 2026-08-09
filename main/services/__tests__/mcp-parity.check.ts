// Standalone regression check for app ↔ MCP run parity.
//
// THE BUGS THIS EXISTS FOR. mcp/server.mjs spawns Playwright itself rather than
// going through playwright-runner.ts, and by 2026-08-07 the two had diverged in
// four ways. Every one of them was silent — the run executed, reported a normal
// pass or fail, and said nothing about what it had skipped:
//
//   1. The env carried no variable values. The generated spec resolves a secret
//      as `process.env.GLAZE_SECRET_<NAME> ?? ""` and a plain variable through
//      `JSON.parse(process.env.GLAZE_VARS || "{}")`, so a test with a secret
//      typed EMPTY STRINGS into the login form and failed on an assertion much
//      further down. Nothing in the output connected the two, and dataset
//      sweeps were unreachable entirely.
//   2. `testTimeoutMs` was ignored, so every MCP run silently used Playwright's
//      own default — failing a test given four minutes at one, and letting one
//      deliberately held to thirty seconds run far longer.
//   3. No fixture was loaded: no screenshots, no a11y, no console/network, no
//      Auto-Heal, no crawl settling. A test with capture switched on simply
//      stopped appearing in the Visual tab.
//   4. Raw child stdout went straight to the .log file, cursor-control bytes
//      and all — a file `get_run_log` hands back to a model.
//
// WHY THIS SHAPE. The parity that matters is not "the two files look alike", it
// is "the env this server builds satisfies what the generator actually emits".
// So the generator is RUN here, its `process.env.X` references are read out of
// the spec it produces, and the MCP's env is checked against that set. A
// source-text assertion would pass against a server that names the right
// variables and never sets them.
//
// mcp/run-plan.mjs exists so this can import the run's env, args and fixture
// report directly — importing server.mjs would start an MCP server on stdio.
//
// Run with: npm run check:mcp-parity

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  consoleNetworkWithheldReason,
  datasetRow,
  describeRun,
  runArgs,
  runEnv,
  sanitizeOutput,
  secretVariableNames,
} from "../../../mcp/run-plan.mjs";
import { compareReplays } from "../../../shared/run-comparison.mjs";
import { generateSpec, secretEnvName } from "../script-generator.js";
import { resolveTestTimeoutMs, CRAWL_MIN_TEST_TIMEOUT_MS } from "../../../shared/run-pacing.mjs";
import { playwrightConfigSource } from "../../../shared/playwright-config-source.mjs";
import { buildQueue } from "../../../shared/batch-queue.mjs";
import type { Step, TestVariable } from "../../recorder/types.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const ESC = String.fromCharCode(27);

/** A minimal recorded test, shaped like what tests.json holds. */
function testWith(overrides: Record<string, unknown> = {}) {
  const steps: Step[] = [
    {
      id: "s1",
      type: "fill",
      locator: { k: "label", v: "Email" },
      value: "${user}",
    } as Step,
  ];
  return {
    id: "t1",
    name: "Login",
    url: "https://example.test",
    steps,
    scriptPath: "/scripts/t1.spec.ts",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Every `process.env.X` the generated spec reads. This is the authoritative
 *  demand side — whatever the generator emits is what a run has to supply. */
function envRefsInSpec(variables: TestVariable[]): Set<string> {
  const source = generateSpec({
    name: "Login",
    url: "https://example.test",
    steps: testWith().steps,
    variables,
  });
  const refs = new Set<string>();
  // Case-INSENSITIVE on purpose: `secretEnvName` does not uppercase, so a
  // variable named `password` becomes `GLAZE_SECRET_password`. An uppercase-only
  // scan silently reads that as the prefix `GLAZE_SECRET_` and then finds it
  // "satisfied" by any secret at all.
  for (const m of source.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) refs.add(m[1]);
  return refs;
}

/** Source with comments removed. Prose about a field is not the field — an
 *  assertion that a shape omits `values` must not be satisfied or broken by a
 *  comment explaining why it omits them. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── 1. Variables: what the spec reads, the env supplies ───────────────
//
// Bug 1's first half. `GLAZE_VARS` is the single channel for plain values and
// dataset rows, and it is what makes one spec runnable once per row without
// being regenerated.

{
  const plain: TestVariable[] = [{ name: "user", kind: "plain", value: "alice" }];
  const refs = envRefsInSpec(plain);
  assert(
    refs.has("GLAZE_VARS"),
    "generator: a test with a plain variable reads GLAZE_VARS (the demand side)",
  );

  const env = runEnv({
    base: {},
    browsersPath: "/browsers",
    nodeModules: "/node_modules",
    speed: "fast",
    testTimeoutMs: 60_000,
    vars: { user: "bob" },
  });
  assert(env.GLAZE_VARS === '{"user":"bob"}', "mcp: supplies GLAZE_VARS as the spec's JSON blob");
  for (const ref of refs) {
    assert(
      env[ref] !== undefined,
      `mcp: the run env supplies ${ref}, which the generated spec reads`,
    );
  }
}

{
  // Omitted rather than set empty. An empty blob parses and spreads to nothing,
  // so this is not a correctness bug — but a run with no variables should not
  // appear in a process listing as though a sweep were in flight.
  const env = runEnv({
    base: {},
    browsersPath: "/b",
    nodeModules: "/n",
    speed: "fast",
    testTimeoutMs: 60_000,
  });
  assert(!("GLAZE_VARS" in env), "mcp: a run with no variable values sets no GLAZE_VARS");
}

// ── 2. Secrets: never injected, and never silently missing ────────────
//
// Bug 1's second half, and the reason bug 4 was harmless until it was fixed.
// The MCP process cannot decrypt test-secrets.bin — safeStorage is a native
// app-only API — so the guarantee is a PAIR: the env carries no secret, and a
// test that needs one is identified before it runs rather than after it fails.

{
  const withSecret: TestVariable[] = [
    { name: "user", kind: "plain", value: "alice" },
    { name: "password", kind: "secret" },
  ];
  const refs = envRefsInSpec(withSecret);
  const secretRef = secretEnvName("password");
  assert(
    refs.has(secretRef),
    `generator: a secret variable emits process.env.${secretRef}`,
  );

  const env = runEnv({
    base: {},
    browsersPath: "/b",
    nodeModules: "/n",
    speed: "fast",
    testTimeoutMs: 60_000,
    vars: { user: "alice" },
  });
  assert(
    Object.keys(env).every((k) => !k.startsWith("GLAZE_SECRET_")),
    "mcp: the run env carries no GLAZE_SECRET_* key (it cannot — see run-plan.mjs)",
  );
  // The env cannot satisfy the spec, so the ONLY thing that keeps this honest
  // is refusing the run. Without this pairing the test runs with empty strings.
  assert(
    secretVariableNames(testWith({ variables: withSecret })).includes("password"),
    "mcp: a test declaring a secret is identified as unrunnable from here",
  );
  assert(
    secretVariableNames(testWith({ variables: [{ name: "user", kind: "plain" }] })).length === 0,
    "mcp: a test with no secrets is not refused",
  );
  // A `captured` variable is written during the run by a capture step, not
  // supplied by the caller — refusing one would block a whole feature.
  assert(
    secretVariableNames(testWith({ variables: [{ name: "token", kind: "captured" }] })).length === 0,
    "mcp: a captured variable is not mistaken for a secret",
  );
}

// ── 3. The per-test timeout is honoured ───────────────────────────────
//
// Bug 2. Pinned on the ARGUMENT, because --timeout is what actually decides:
// the config is a fallback and a hand-edited one would win over the env var.

{
  const { timeoutMs } = resolveTestTimeoutMs(120_000, undefined, "fast");
  const args = runArgs({
    cliPath: "/cli.js",
    specFile: "t1.spec.ts",
    configPath: "/scripts/playwright.config.ts",
    browser: "chromium",
    testTimeoutMs: timeoutMs,
  });
  assert(
    args.includes(`--timeout=${timeoutMs}`),
    "mcp: passes the resolved per-test timeout as --timeout",
  );
  assert(
    args.includes("--config") && args.includes("/scripts/playwright.config.ts"),
    "mcp: names the config explicitly rather than relying on cwd discovery",
  );
  const env = runEnv({
    base: {},
    browsersPath: "/b",
    nodeModules: "/n",
    speed: "fast",
    testTimeoutMs: timeoutMs,
  });
  assert(
    env.PW_TEST_TIMEOUT_MS === String(timeoutMs),
    "mcp: the same timeout reaches the config through PW_TEST_TIMEOUT_MS",
  );
}

{
  // The crawl floor applies here too. Without it, asking an agent to run a
  // crawl test is asking it to fail one: crawl multiplies run time, and the
  // 60s default is nowhere near enough.
  const crawl = resolveTestTimeoutMs(30_000, undefined, "crawl");
  assert(
    crawl.timeoutMs === CRAWL_MIN_TEST_TIMEOUT_MS && crawl.raised,
    "mcp: a crawl run gets the same raised floor the app gives it",
  );
}

// ── 4. One config, one spelling ───────────────────────────────────────
//
// Both processes write playwright.config.ts into the SAME scripts directory, so
// whichever ran last wins. The MCP's old copy had no `timeout` line at all.

{
  const appSrc = readFileSync(resolve(process.cwd(), "main/services/playwright-runner.ts"), "utf8");
  const mcpSrc = readFileSync(resolve(process.cwd(), "mcp/server.mjs"), "utf8");
  assert(
    appSrc.includes("playwrightConfigSource") && mcpSrc.includes("playwrightConfigSource"),
    "both writers use the shared playwright config source",
  );
  assert(
    playwrightConfigSource.includes("PW_TEST_TIMEOUT_MS"),
    "shared config: reads the per-test timeout from the environment",
  );
  assert(
    playwrightConfigSource.includes("PW_SLOWMO_MS"),
    "shared config: reads the step delay from the environment (the CLI has no flag for it)",
  );
  // Always rewritten on both sides. "Only if absent" is how the MCP's
  // timeout-less config could outlive the app's.
  assert(
    !/if \(fs\.existsSync\(configPath\)\) return/.test(mcpSrc),
    "mcp: rewrites the config every run rather than leaving an older one in place",
  );
}

// ── 5. The log this server writes, and hands back ─────────────────────
//
// Bug 4. `get_run_log` reads this file straight into a model's context.

{
  const raw = `${ESC}[1A${ESC}[2K[1/1] [chromium] > t1.spec.ts:3:5 > Login`;
  assert(
    sanitizeOutput(raw) === "[1/1] [chromium] > t1.spec.ts:3:5 > Login",
    "mcp: run output is stripped of terminal escape sequences before it is stored",
  );
  assert(!sanitizeOutput(raw).includes(ESC), "mcp: no ESC byte survives sanitizeOutput");
  const mcpSrc = readFileSync(resolve(process.cwd(), "mcp/server.mjs"), "utf8");
  // The saved record's byte count must describe the text actually written. It
  // used to be measured on the raw output, so every log reported a size larger
  // than the file on disk.
  assert(
    /logBytes: Buffer\.byteLength\(safeOutput/.test(mcpSrc),
    "mcp: logBytes measures the sanitized text, not the raw child output",
  );
  assert(
    /saveRunRecord\([\s\S]*?safeOutput,\s*\)/.test(mcpSrc),
    "mcp: the sanitized text is what gets written to the log file",
  );
}

// ── 6. What the run did NOT do is reported ────────────────────────────
//
// Bug 3. This is the honest half: the fixtures still do not load here, so the
// requirement is that a run SAYS so rather than looking like an app run. These
// assertions are what has to change when capture parity lands — not silently,
// which is the whole point.

{
  const wantsEverything = testWith({
    captureArtifacts: true,
    a11yChecks: true,
    recordLogs: true,
    speed: "crawl",
  });
  const report = describeRun(wantsEverything, { autoHealEnabled: true }, {
    speed: "crawl",
    timeoutMs: CRAWL_MIN_TEST_TIMEOUT_MS,
    timeoutRaised: true,
  });
  const skipped = (report.skipped ?? []).join(" | ");
  for (const [feature, needle] of [
    ["screenshot capture", "Screenshot capture"],
    ["accessibility checks", "Accessibility checks"],
    ["console and network", "Console and network"],
    ["auto-heal", "Auto-Heal"],
    ["crawl settling", "Crawl page-settling"],
  ] as const) {
    assert(skipped.includes(needle), `report: names ${feature} as skipped`);
  }
  assert(
    typeof report.timeoutNote === "string",
    "report: says out loud when the crawl floor raised this run's timeout",
  );
  assert(report.stepDelayMs === 2500, "report: states the step delay that was actually applied");
}

{
  // Reported against what the TEST asks for. A test that wanted none of it
  // being told it got none of it is noise, and noise is what stops the useful
  // line from being read.
  const plain = testWith();
  const report = describeRun(plain, {}, { speed: "fast", timeoutMs: 60_000 });
  assert(
    report.skipped === undefined,
    "report: a test that asked for no fixtures is told about no fixtures",
  );
}

{
  // A test with a secret is refused, but if one is ever reached by another
  // path the report still has to name it. Belt and braces on the one gap that
  // fails at the login form rather than at the call.
  const report = describeRun(
    testWith({ variables: [{ name: "password", kind: "secret" }] }),
    {},
    { speed: "fast", timeoutMs: 60_000 },
  );
  assert(
    (report.skipped ?? []).some((s) => s.includes("password")),
    "report: names the secret variables a run could not supply",
  );
}

// ── 7. Dataset sweeps expand the same way as the app's ────────────────

{
  const datasets = [
    { id: "d1", name: "Row one", values: { user: "alice" } },
    { id: "d2", name: "Row two", values: { user: "bob" } },
  ];
  const test = testWith({ datasets });
  assert(datasetRow(test, "d2")?.name === "Row two", "mcp: resolves a dataset row by id");
  assert(datasetRow(test, "nope") === null, "mcp: an unknown dataset id resolves to null, not row 0");
  assert(datasetRow(test, undefined) === null, "mcp: no dataset id means no row");

  const swept = buildQueue({ testIds: ["t1"], allDatasets: true }, () => datasets);
  assert(swept.length === 2, "mcp: a sweep queues one execution per row");
  assert(
    swept[0].vars?.user === "alice" && swept[1].vars?.user === "bob",
    "mcp: each queued execution carries its own row's values",
  );
  const plain = buildQueue({ testIds: ["t1"] }, () => datasets);
  assert(
    plain.length === 1 && plain[0].datasetId === undefined,
    "mcp: without dataset options the queue is exactly the selection",
  );
  // A test with no matching rows still runs once. Dropping it would turn
  // "sweep my suite" into "silently skip the tests that aren't parameterized".
  const none = buildQueue({ testIds: ["t1"], allDatasets: true }, () => []);
  assert(none.length === 1, "mcp: a test with no rows still runs once in a sweep");
}

// ── 8. The values a sweep uses never reach the persisted batch ────────

{
  const mcpSrc = codeOnly(readFileSync(resolve(process.cwd(), "mcp/server.mjs"), "utf8"));
  // batch-history.json is read back by the app for display. A row's VALUES have
  // no business there; its id and name are what identify a failing row.
  const resultsBlock = /const results = queue\.map\(\(entry\) => \(\{[\s\S]*?\}\)\);/.exec(mcpSrc)?.[0] ?? "";
  assert(resultsBlock.length > 0, "mcp: found the persisted batch result shape");
  assert(
    !resultsBlock.includes("vars") && !resultsBlock.includes("values"),
    "mcp: the persisted batch record carries a row's id and name, never its values",
  );
}

// ── 8b. Parallel batches run the QUEUE, not the selection ─────────────
//
// Where two independently-developed features met: dataset sweeps expand one
// test into one entry per row, and parallel batches run a bounded pool. The
// pool has to iterate the expanded queue. Pointing it at the SELECTION instead
// is silent and specific — a sweep runs one row per test and leaves every other
// row sitting at "pending" forever, reported as a batch that finished.

{
  const mcpSrc = codeOnly(readFileSync(resolve(process.cwd(), "mcp/server.mjs"), "utf8"));
  assert(
    /runPool\(\s*queue\s*,/.test(mcpSrc),
    "mcp: the batch pool iterates the expanded queue, not the selection",
  );
  assert(
    /clampParallel\(\s*parallel\s*,\s*queue\.length\s*\)/.test(mcpSrc),
    "mcp: parallelism is clamped to the QUEUE's length (a sweep is longer than its selection)",
  );
  // Each run needs its own Playwright scratch dir, or concurrent runs of ONE
  // spec — which is exactly what a sweep is — clean each other's output
  // mid-flight. run-pool.mjs's "no lanes here" note depends on this being true.
  assert(
    /PW_OUTPUT_DIR/.test(readFileSync(resolve(process.cwd(), "mcp/run-plan.mjs"), "utf8")),
    "mcp: every run gets its own PW_OUTPUT_DIR, which is what makes a parallel sweep safe",
  );
}

{
  // The dedupe the parallel work added to buildQueue, exercised through the
  // shared copy the MCP uses. A repeated id breaks the queue's one structural
  // guarantee — that a test's entries sit together — which the app's lane
  // grouping depends on. The Batch view can't produce a repeat; IPC and an
  // agent calling run_batch can.
  const queue = buildQueue({ testIds: ["a", "b", "a"] }, () => []);
  assert(queue.length === 2, "queue: a repeated test id is deduped, not queued twice");
  assert(
    queue.map((e) => e.testId).join(",") === "a,b",
    "queue: dedupe keeps first-appearance order",
  );
}

// ── 9. Console + network are withheld when they cannot be redacted ────
//
// The one read tool that can leak. console.json and network.json are stored
// RAW; the app strips secret values on the way out, and this process has no
// secret values to strip with. Serving them would hand out exactly what
// artifact-store.readLogs is careful to remove.

{
  const clean = [testWith({ id: "a" }), testWith({ id: "b" })];
  assert(
    consoleNetworkWithheldReason(clean) === null,
    "logs: a library with no secrets may serve console and network",
  );

  const withOne = [
    testWith({ id: "a" }),
    testWith({ id: "b", variables: [{ name: "password", kind: "secret" }] }),
  ];
  const reason = consoleNetworkWithheldReason(withOne);
  assert(typeof reason === "string", "logs: one secret anywhere withholds them");
  // Keyed on the WHOLE library, not the run's own test — any run's log can
  // contain any test's secret, which is why the app's redaction snapshot holds
  // every value it knows rather than the current test's.
  assert(
    consoleNetworkWithheldReason([testWith({ id: "a" })]) === null &&
      consoleNetworkWithheldReason(withOne) !== null,
    "logs: the rule is library-wide, not per-test",
  );
  assert(
    (reason ?? "").includes("Visual tab"),
    "logs: the refusal says where the redacted version can be read instead",
  );
  assert(
    !(reason ?? "").includes("password"),
    "logs: the refusal does not name the secret variables it is protecting",
  );
}

// ── 10. Comparison reads the same way for both callers ────────────────

{
  const step = (stepId: string, status: string) => ({ stepId, label: stepId, status });
  const base = {
    testId: "t1",
    runId: "r1",
    steps: [step("s1", "passed"), step("s2", "passed"), step("s3", "failed")],
  };
  const later = {
    testId: "t1",
    runId: "r2",
    steps: [step("s1", "passed"), step("s2", "failed"), step("s3", "passed")],
  };
   
  const cmp = compareReplays(base as any, later as any);
  assert(cmp?.steps[0].delta === "stable", "compare: passed then, passed now → stable");
  // Never "regressed": the run alone cannot tell a real regression from
  // environment drift, and claiming one during an outage is expensive.
  assert(cmp?.steps[1].delta === "changed-since", "compare: passed then, failed now → changed-since");
  assert(cmp?.steps[2].delta === "fixed", "compare: failed then, passed now → fixed");
  assert(cmp?.changedSinceCount === 1 && cmp?.fixedCount === 1, "compare: counts the two deltas");
  assert(cmp?.stepsDiverged === false, "compare: matching step lists are not reported as diverged");

  const edited = { testId: "t1", runId: "r3", steps: [step("s9", "passed")] };
   
  const drifted = compareReplays(base as any, edited as any);
  assert(
    drifted?.stepsDiverged === true,
    "compare: a test edited between runs is reported as diverged, not silently mismatched",
  );
  // `=== true` rather than a bare `?.`: an undefined comparison would otherwise
  // read as a falsy pass-through, and this assertion would go quiet exactly
  // when compareReplays stopped returning anything.
  assert(
    drifted?.steps.every((s) => s.delta === "unknown") === true,
    "compare: an unmatched step is unknown rather than assumed failed",
  );
   
  assert(compareReplays(null, later as any) === null, "compare: a pruned run compares to null");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll MCP parity checks passed.");
