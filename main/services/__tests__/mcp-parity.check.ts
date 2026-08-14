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

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { chooseDataDir } from "../../../shared/user-data-rules.mjs";
import {
  appName,
  electronDefaultDir,
  findLegacyStores as mcpFindLegacy,
  hasRecorderStore as mcpHasStore,
} from "../../../mcp/data-dir.mjs";
import {
  findLegacyStores as appFindLegacy,
  hasRecorderStore as appHasStore,
  resolveUserData,
} from "../../shell/user-data.js";

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
import { routineRunPlan } from "../../../shared/routine-plan.mjs";
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

// ── 11. run_routine runs the routine the APP would run ────────────────
//
// `run_routine` is the second caller of `shared/routine-plan.mjs`, which is the
// only reason that module is in `shared/` at all: ROUTINES.md's rename table
// says to add the tool ALONGSIDE run_batch, so two processes build this payload
// and a transcribed copy of "what does this routine run" is right the day it is
// written and silently divergent after. What follows pins the four ways this
// tool could look correct and be wrong, none of which surface as an error.

{
  const mcpSrc = codeOnly(readFileSync(resolve(process.cwd(), "mcp/server.mjs"), "utf8"));

  // Renaming a tool breaks every external client SILENTLY — an MCP client gets
  // "unknown tool", not a redirect. The rename table rules it out, so the two
  // must coexist.
  assert(
    /registerTool\(\s*"run_batch"/.test(mcpSrc) && /registerTool\(\s*"run_routine"/.test(mcpSrc),
    "mcp: run_routine is added ALONGSIDE run_batch, never as a rename of it",
  );

  // SCOPED TO THE TOOL, not searched for in the whole file, and this is not
  // fastidiousness: the first draft of the `routineId` assertion below scanned
  // the file, and deleting the stamp from the persisted batch left it green
  // because the tool's own JSON RESPONSE contains the same text. Reporting
  // which routine ran is not the same fact as recording it. Every assertion
  // here reads only what run_routine's own body says. `run_batch` is registered
  // straight after it, and is the natural end marker.
  const routineSrc = mcpSrc.slice(
    mcpSrc.indexOf('registerTool(\n  "run_routine"'),
    mcpSrc.indexOf('registerTool(\n  "run_batch"'),
  );
  assert(
    routineSrc.length > 0 && routineSrc.includes("run_routine"),
    "mcp: isolated run_routine's own body (every assertion below reads only it)",
  );

  // The plan comes from the shared module, not from reading `routine.steps`
  // here. A second reading is how this tool and the app end up disagreeing
  // about a job in front of a user.
  assert(
    /routineRunPlan\(/.test(routineSrc) && !/step\.kind\s*===\s*"test"/.test(routineSrc),
    "mcp: run_routine plans through routineRunPlan rather than re-reading the steps",
  );
  // A routine whose tests were all deleted must be refused, not run as an empty
  // batch that reports a clean pass.
  assert(
    /routineBlockedReason\(/.test(routineSrc),
    "mcp: a routine that cannot run is refused with the app's own reason",
  );
  // Engine fan-out through buildQueue, so the ENGINE-MAJOR nesting that keeps a
  // test's entries contiguous is decided in one place. Hand-rolling it here
  // reproduces today's order and stops the day the shared one changes.
  assert(
    /buildQueue\(\{\s*testIds: plan\.testIds,\s*perTest: plan\.perTest\s*\}/.test(routineSrc),
    "mcp: run_routine expands engines through buildQueue, not a second loop",
  );

  // Stamped with the routine, or the batch lands under the migrated "Batch"
  // that owns unattributed ones and the routine's history looks empty.
  const persistBlock = /saveBatchRecord\(\{[\s\S]*?\n {6}\}\);/.exec(routineSrc)?.[0] ?? "";
  assert(persistBlock.length > 0, "mcp: found run_routine's saveBatchRecord call");
  assert(
    /routineId: routine\.id,/.test(persistBlock),
    "mcp: the persisted batch is stamped with the routine that ran it",
  );
  // `batchId` is the join key for every run in a batch, and it is passed to
  // executeTest rather than derived — omitting it writes RunRecords that no
  // batch can reach, which reads on screen as a batch whose rows link nowhere.
  const routineCall = /await executeTest\(test, \{[\s\S]*?\}\);/.exec(routineSrc)?.[0] ?? "";
  assert(routineCall.length > 0, "mcp: found run_routine's executeTest call");
  assert(
    routineCall.includes("batchId"),
    "mcp: a routine's runs carry the batchId that joins them back to the batch",
  );
  // The field the Batch view actually reads to reach a result's run. Assigning
  // executeTest's `runId` straight across leaves it undefined, and the symptom
  // is a finished batch whose rows have no link — no error, nothing in a log.
  assert(
    /results\[i\]\.runRecordId = r\.runId;/.test(routineSrc),
    "mcp: a result records runRecordId, the field the app reads, not runId",
  );

  // A step marked "stop on fail" has to mean the same thing here as in the
  // app, or a saved job behaves differently depending on who started it —
  // which is the failure `shared/routine-plan.mjs` exists to prevent, one
  // layer down.
  assert(
    /entry\.onFailure === "stopRoutine"/.test(routineSrc),
    "mcp: run_routine honours a step's stopRoutine policy",
  );
  // Read from the QUEUE ENTRY, not re-derived from the routine's steps here.
  // buildQueue copies the policy onto every entry a step fans out to, so one
  // red engine of a three-engine step triggers it — re-deriving would need a
  // second answer to "which step was that".
  assert(
    !/routine\.steps/.test(routineSrc),
    "mcp: the policy comes off the queue entry, not a second read of routine.steps",
  );
  // FIRST failure owns the stop. With entries in flight concurrently a second
  // one arriving would rewrite whose failure stopped the job, and every note
  // would then name a test that stopped nothing.
  assert(
    /stoppedByTest === null/.test(routineSrc),
    "mcp: the first failure owns the stop; a later one does not rewrite it",
  );
  // The record has to SAY it stopped. Persisting `stopped: false` for a run
  // that ended early is the app reading a truncated batch as a complete one.
  assert(
    /stopped: stoppedByTest !== null/.test(routineSrc),
    "mcp: a routine stopped by a policy is persisted as stopped",
  );
  // `skipGroup` too, and read off the queue entry's own `groupId` — the app's
  // runner and this one must agree about which entries are "the rest of this
  // group", or a saved job takes out different steps depending on who ran it.
  assert(
    /entry\.onFailure === "skipGroup"/.test(routineSrc) && /entry\.groupId/.test(routineSrc),
    "mcp: run_routine honours skipGroup, scoped by the entry's own groupId",
  );
  // The ungrouped degradation. Without the `entry.groupId` guard a `skipGroup`
  // step at the top level would key the map on undefined and take out every
  // other ungrouped entry — which is a stop, wearing the wrong name.
  assert(
    /entry\.onFailure === "skipGroup" &&\s*entry\.groupId/.test(routineSrc),
    "mcp: an ungrouped skipGroup step continues rather than skipping everything",
  );

  // BARRIERS. A `wait` means "everything before this has finished", so the pool
  // must drain per segment. Running one segment alongside the next would make
  // the barrier a no-op wearing a label — and the same Routine would then do
  // something different depending on who started it.
  assert(
    /for \(const seg of segments\)/.test(routineSrc),
    "mcp: run_routine runs one segment at a time rather than one flat pool",
  );
  assert(
    /plan\.barriers\.find\(\(b\) => b\.afterSegment === seg\)/.test(routineSrc),
    "mcp: …and pauses at the barrier the plan put after that segment",
  );
  // Not after a stopRoutine failure: the job is over, and sitting out a pause
  // would hold the tool open for a stretch in which nothing can happen.
  assert(
    /if \(!barrier \|\| stoppedByTest !== null\) continue;/.test(routineSrc),
    "mcp: a stopped routine does not sit out the pauses it never reached",
  );

  // NOTIFY IS NOT SENT FROM HERE, and this is the assertion that keeps it that
  // way. Both channels belong to the app: `desktop` is a native notification
  // this process cannot post, and `webhook` goes through `alert-service`, which
  // redacts with secret values only the app can decrypt. Reproducing the send
  // here would be a SECOND EGRESS PATH with weaker redaction.
  assert(
    !/sendAlert|Notification|webhookUrl/.test(routineSrc),
    "mcp: run_routine does not send a notify itself — that would be a second egress path",
  );
  // Reported rather than swallowed. A routine that announces things is one
  // somebody is relying on to announce them, so a run where they did not fire
  // has to say so.
  assert(
    /notificationsNotSent/.test(routineSrc),
    "mcp: …and the response says which messages did not fire",
  );
}

// ── 12. run_group is run_batch, not a second batch runner ─────────────
//
// REDESIGN §7.2 asked for `run_group` and said it needs no UI. The risk in
// granting a second entry point is the one this repo has spent two phases
// avoiding elsewhere: a second implementation that starts identical and
// diverges silently. What follows pins that there is exactly ONE, and that the
// selection semantics the folder feature depends on are the app's own.

{
  const mcpSrc = codeOnly(readFileSync(resolve(process.cwd(), "mcp/server.mjs"), "utf8"));

  // Both registered, and neither a rename of the other — same rule that keeps
  // run_batch and run_routine coexisting. An MCP client meeting a renamed tool
  // gets "unknown tool", not a redirect.
  assert(
    /registerTool\(\s*"run_batch"/.test(mcpSrc) && /registerTool\(\s*"run_group"/.test(mcpSrc),
    "mcp: run_group is added ALONGSIDE run_batch, never as a rename of it",
  );

  // THE WHOLE POINT: one body. Both registrations hand the SAME function to the
  // server, so there is no second queue expansion, no second pool and no second
  // BatchRecord shape that can drift. A `run_group` with an inline handler of
  // its own would satisfy the assertion above and defeat the reason for it.
  const registrations = [
    ...mcpSrc.matchAll(/registerTool\(\s*"(run_batch|run_group)"[\s\S]*?\n\);/g),
  ];
  assert(registrations.length === 2, "mcp: found both batch tool registrations");
  assert(
    registrations.every((m) => /\n {2}runBatchTool,\n\);$/.test(m[0])),
    "mcp: run_batch and run_group are the SAME handler, not two copies of one",
  );
  // …and that handler exists exactly once.
  assert(
    (mcpSrc.match(/async function runBatchTool\(/g) ?? []).length === 1,
    "mcp: there is one runBatchTool, so there is one batch runner",
  );

  // The selector reaches `selectTests` rather than being filtered here. The
  // app's rail and this tool have to agree about what "the Checkout folder"
  // contains, and that answer lives in one module for the reason the tags one
  // does — a second read is how the two end up running different sets.
  const batchSrc = /async function runBatchTool\([\s\S]*?\n\}\n/.exec(mcpSrc)?.[0] ?? "";
  assert(batchSrc.length > 0, "mcp: isolated runBatchTool's own body");
  assert(
    /selectTests\(listTests\(\), \{ testIds, tag, group \}\)/.test(batchSrc),
    "mcp: the group selector goes through selectTests, not a filter written here",
  );
  assert(
    !/\.group ===/.test(batchSrc) && !/\.group\?\./.test(batchSrc),
    "mcp: …and the tool does not read a test's group itself",
  );

  // A folder that selected nothing must SAY it was a folder. "No tests matched
  // the library" for an empty group sends someone to look at the wrong thing.
  assert(
    /group "\$\{group\}"/.test(batchSrc),
    "mcp: an empty folder is reported as that folder, not as the library",
  );
}

{
  // The segmentation itself, exercised through the shared planner rather than
  // asserted about the source — the two runners have to agree about WHICH
  // entries fall on which side of a barrier, and that answer comes from one
  // place.
  const routine = {
    id: "r1",
    name: "Nightly",
    createdAt: 0,
    updatedAt: 0,
    defaults: { captureArtifacts: false, concurrency: 1 },
    steps: [
      { kind: "test", testId: "a", browsers: ["chromium"], headless: true, onFailure: "continue" },
      { kind: "wait", id: "w1", ms: 30_000 },
      { kind: "test", testId: "b", browsers: ["chromium"], headless: true, onFailure: "continue" },
    ],
  };
  const plan = routineRunPlan(routine as never, ["a", "b"]);
  const queue = buildQueue({ testIds: plan.testIds, perTest: plan.perTest }, () => []);
  assert(
    queue.map((e) => `${e.testId}:${e.segment}`).join(",") === "a:0,b:1",
    "routine: the queue carries the segment each entry falls in, so both runners cut it the same way",
  );
  assert(
    plan.barriers.length === 1 && plan.barriers[0].afterSegment === 0,
    "routine: the barrier names the segment that must finish before it",
  );
}

{
  // The queue a routine produces, exercised through the shared functions rather
  // than asserted about the source. A three-engine step is three runs — the
  // count the tool reports and the number of processes it spawns have to be the
  // same number, and `plannedRuns` is what the app's own toolbar promises.
  const routine = {
    id: "r1",
    name: "Nightly",
    createdAt: 0,
    updatedAt: 0,
    defaults: { captureArtifacts: false, concurrency: 2 },
    steps: [
      { kind: "test", testId: "a", browsers: ["chromium", "firefox"], headless: true, onFailure: "continue" },
      { kind: "test", testId: "b", browsers: ["chromium"], headless: true, onFailure: "continue" },
      { kind: "test", testId: "gone", browsers: ["chromium"], headless: true, onFailure: "continue" },
    ],
  };

  const plan = routineRunPlan(routine as any, ["a", "b"]);
  const queue = buildQueue({ testIds: plan.testIds, perTest: plan.perTest }, () => []);
  assert(
    queue.length === plan.plannedRuns,
    "routine: the queue run_routine executes is exactly as long as the plannedRuns it reports",
  );
  // Contiguous per test, engine-major. The app's runner groups by testId, so an
  // interleaved queue reorders itself on the way in and the batch record's rows
  // stop matching the order the routine lists.
  assert(
    queue.map((e) => `${e.testId}:${e.browser}`).join(",") ===
      "a:chromium,a:firefox,b:chromium",
    "routine: entries are engine-major inside a test, in the routine's own order",
  );
  // The deleted step contributes nothing to the queue but is still REPORTED.
  // A routine silently running fewer tests than it lists is the same class of
  // bug as a batch that reports a pass having skipped half of it.
  assert(
    plan.skipped.join(",") === "gone",
    "routine: a step whose test was deleted is skipped and named, not queued",
  );
}

// ── 13. The two data-dir resolvers agree ──────────────────────────────
//
// THE PARITY THAT COST THE MOST. Both processes resolve where the app's data
// lives, and BOTH WRITE — the MCP appends run history and batch history — so a
// disagreement is the app reading a library the server is not writing to. That
// is the bug `main/shell/user-data.ts` was itself written against, one process
// over, and it would be just as quiet: two stores, each internally consistent.
//
// The DECISION is shared (`shared/user-data-rules.mjs`), so it cannot differ
// once the inputs match. What can still drift is the PROBING — each side does
// its own `fs` work, because `shared/` is pure by rule. So this drives both
// against ONE fixture tree and compares.

{
  const root = mkdtempSync(join(tmpdir(), "gl-userdata-parity-"));
  try {
    const appSupport = join(root, "Application Support");
    const defaultDir = join(appSupport, "Good Looks!");
    const legacyOld = join(appSupport, "app.glaze.macos.aaa-local");
    const legacyNew = join(appSupport, "app.glaze.macos.bbb-local");
    // Shapes that matter, and one that must NOT match: a flavoured directory.
    // The Glaze-era resolver handled `-local.<flavor>`; the rule the app has
    // shipped since the port does not, and widening it here would quietly
    // change which store an existing install adopts.
    const flavoured = join(appSupport, "app.glaze.macos.ccc-local.dev");
    for (const dir of [defaultDir, legacyOld, legacyNew, flavoured]) {
      mkdirSync(join(dir, "recorder"), { recursive: true });
    }
    // Only the legacy pair and the flavoured one get a store; the default is
    // the empty directory the port started writing to.
    for (const dir of [legacyOld, legacyNew, flavoured]) {
      writeFileSync(join(dir, "recorder", "tests.json"), "[]");
    }
    // `legacyNew` is the newer of the two, by the mtime both sides sort on.
    const now = Date.now();
    utimesSync(join(legacyOld, "recorder"), new Date(now - 60_000), new Date(now - 60_000));
    utimesSync(join(legacyNew, "recorder"), new Date(now), new Date(now));

    // Same question, both implementations.
    for (const dir of [defaultDir, legacyOld, flavoured, join(root, "nope")]) {
      assert(
        appHasStore(dir) === mcpHasStore(dir),
        `user-data: both resolvers agree whether ${basename(dir)} is a store`,
      );
    }
    // The empty default is the case the whole feature turns on.
    assert(!appHasStore(defaultDir), "user-data: an empty default is not a store");

    const appLegacy = appFindLegacy(appSupport);
    const mcpLegacy = mcpFindLegacy(appSupport);
    assert(
      appLegacy.join(",") === mcpLegacy.join(","),
      "user-data: both resolvers find the same legacy stores, in the same order",
    );
    // Not vacuous: it has to find something, and it has to exclude the
    // flavoured one rather than merely returning a short list.
    assert(
      appLegacy.length === 2 && appLegacy[0] === legacyNew,
      "user-data: …newest first, and a FLAVOURED directory is not one of them",
    );

    // And the whole decision, composed the way each side composes it.
    const appChoice = resolveUserData(defaultDir, {});
    const mcpChoice = chooseDataDir({
      override: undefined,
      defaultDir,
      defaultHasStore: mcpHasStore(defaultDir),
      legacyDirs: mcpFindLegacy(dirname(defaultDir)),
    });
    assert(
      appChoice.dir === mcpChoice.dir && appChoice.reason === mcpChoice.reason,
      "user-data: both reach the same directory FOR THE SAME REASON",
    );
    assert(
      appChoice.reason === "adopted-legacy" && appChoice.dir === legacyNew,
      "user-data: …which here is adopting the newest legacy store",
    );

    // The override short-circuits both, or the escape hatch is only an escape
    // from one of them.
    const env = { GOOD_LOOKS_USERDATA: join(root, "elsewhere") };
    assert(
      resolveUserData(defaultDir, env).dir === env.GOOD_LOOKS_USERDATA &&
        chooseDataDir({ override: env.GOOD_LOOKS_USERDATA, defaultDir, defaultHasStore: true })
          .dir === env.GOOD_LOOKS_USERDATA,
      "user-data: the override wins on both sides, even over an existing store",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The MCP derives the default from `productName`, which Electron PREFERS over
// `name`. Getting that backwards lands the server in `good-looks` beside a real
// store in `Good Looks!` — the misdirected-read bug, exactly.
{
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  assert(
    pkg.productName === "Good Looks!" && pkg.name !== pkg.productName,
    "user-data: productName and name differ, so preferring the wrong one is observable",
  );
  // Reads `appName()`'s OWN answer rather than handing it `productName` — the
  // first draft of this did the latter and survived swapping the preference,
  // because it only ever exercised the function it fed the right value to.
  // Nor would the boot check catch it: that drives the server through the
  // override, which short-circuits the default entirely. This assertion is the
  // only thing standing between a rename and a silently misdirected read.
  assert(
    appName(process.cwd()) === pkg.productName,
    "mcp: the app's name is productName — the one Electron PREFERS, not `name`",
  );
  assert(
    electronDefaultDir(appName(process.cwd()), "darwin").endsWith("/Library/Application Support/Good Looks!"),
    "mcp: the default dir is Electron's own — productName under Application Support",
  );
  assert(
    electronDefaultDir(appName(process.cwd()), "linux").includes("Good Looks!"),
    "mcp: …and it still resolves off macOS, which is what lets CI boot the server",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll MCP parity checks passed.");
