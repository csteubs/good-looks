// Standalone regression check for the metrics database.
//
// WHY THIS EXISTS. The database is a DERIVED SHADOW of the JSON stores and the
// run artifacts, written at three points (run completion, the prune preflight,
// and the MCP's own runs) and read by everything downstream. Every failure mode
// it has is quiet:
//
//   1. A rollup that is not idempotent duplicates rows. Nothing errors — the
//      prune preflight re-ingesting a run already ingested at completion just
//      doubles its steps — and every count, median and rate computed from it is
//      then wrong in a way that looks like real data.
//   2. A rebuild that does not reproduce the same result makes the "corruption
//      is never fatal, just rebuild" guarantee false. That guarantee is what
//      lets this be treated as a cache rather than a store of record.
//   3. Attributing a log entry to the wrong step. The app counts steps two ways
//      — Step[] order and ACTION order — and every number still lands in a row
//      if the translation is wrong, just against the wrong step.
//   4. A metrics failure reaching the run. This must never fail a test run,
//      block teardown, or surface as an error; it is bookkeeping.
//   5. The launch sweep outrunning the preflight registration. The app prunes
//      at startup; if that prune runs before `setPrunePreflight`, every run it
//      removes — the "older than N days" population, precisely the runs
//      nothing will ever ingest again — is deleted unrolled, silently, because
//      pruning skips an unregistered preflight rather than waiting for one.
//
// The database is EXERCISED FOR REAL against a temp file rather than asserted
// on as source text, because "the same run ingested twice yields one row set"
// is behaviour, and a source assertion would pass against a schema that does
// none of it. Section 7 is the one exception — source-level, because its
// subject is `main/index.ts`, which nothing can execute under a check.
//
// Run with: npm run check:metrics-db

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";

import {
  bind,
  CREATE_STATEMENTS,
  DROP_STATEMENTS,
  INSERT_RUN,
  INSERT_STEP,
  PRAGMAS,
  RUN_COLUMNS,
  SCHEMA_VERSION,
  STEP_COLUMNS,
} from "../../../shared/metrics-schema.mjs";
import { rollupRun } from "../../../shared/rollup.mjs";
import {
  browserMatrix,
  counts,
  failureClusters,
  isPopulated,
  runEvidence,
  siblingRuns,
  siteHealthHostRows,
  siteHealthHosts,
  siteHealthPageRows,
  stepBrowserMatrix,
  stepDurations,
  testDurationTrend,
  stepHealth,
  suiteCost,
  lifetimeRunCounts,
} from "../../../shared/metrics-query.mjs";
import {
  HOST_HEALTH_COLUMNS,
  INSERT_HOST_HEALTH,
  INSERT_PAGE_HEALTH,
  PAGE_HEALTH_COLUMNS,
} from "../../../shared/metrics-schema.mjs";
import { auditsFromText, normalizeSiteHealthArtifact, summariseSiteHealth } from "../../../shared/site-health.mjs";
import { errorSignature, firstErrorLine } from "../../../shared/error-signature.mjs";
import { stripAnsi } from "../../../shared/strip-ansi.mjs";

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

// ── Fixtures ──────────────────────────────────────────────────────────
//
// One run with everything: two captured actions, an assertion that captures
// nothing, network and console tagged by ACTION index, a visual change, a
// failed heal.

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    testId: "test-1",
    testName: "Checkout",
    url: "https://example.test",
    status: "failed",
    exitCode: 1,
    startedAt: 1000,
    finishedAt: 5000,
    durationMs: 4000,
    runBrowser: "chromium",
    speed: "fast",
    runHeadless: true,
    healedSteps: 1,
    healFailedSteps: 1,
    testTimeoutMs: 60000,
    captureOverheadMs: 120,
    shotCount: 2,
    a11yMs: 300,
    ...overrides,
  };
}

const REPLAY = {
  failedIndex: 2,
  steps: [
    { index: 0, stepId: "s0", label: "goto", type: "goto", status: "passed", actionIndex: 0 },
    { index: 1, stepId: "s1", label: "click", type: "click", status: "passed", actionIndex: 1,
      diff: { state: "changed", ratio: 0.4 },
      a11y: { violations: [{ id: "contrast" }], newKeys: ["contrast"] } },
    // An assertion: no action, so no action index and nothing to attribute.
    { index: 2, stepId: "s2", label: "expect", type: "assert", status: "failed" },
  ],
};

const MANIFEST = {
  steps: [
    { index: 0, ms: 40, stepMs: 900 },
    { index: 1, ms: 35, stepMs: 2400 },
  ],
};

const LOGS = {
  console: [
    { step: 0, type: "error" },
    { step: 1, type: "pageerror" },
    { step: 1, type: "log" },
  ],
  network: [
    { step: 0, ms: 120, status: 200, ok: true, resourceType: "document" },
    { step: 0, ms: 90, status: 404, ok: false, resourceType: "document" },
    { step: 1, ms: 250, status: 503, ok: false, resourceType: "fetch" },
  ],
  consoleDropped: 12,
  networkDropped: 900,
};

function rollupFixture(overrides: Record<string, unknown> = {}) {
  return rollupRun({
    run: makeRun() as never,
    replay: REPLAY as never,
    manifest: MANIFEST as never,
    logs: LOGS as never,
    healFailures: [{ stepId: "s2", outcome: "no-candidates" }],
    heals: [{ stepId: "s1" }],
    logText: "Running 1 test\nError: Timed out 5000ms waiting for expect(locator)\n",
    source: "app",
    ...overrides,
  });
}

// ── 1. The rollup's step correlation ──────────────────────────────────

{
  const { steps } = rollupFixture();
  assert(steps.length === 3, "rollup: one row per replay step, including uncaptured ones");

  const s0 = steps[0];
  const s1 = steps[1];
  const s2 = steps[2];

  assert(s0.action_index === 0 && s1.action_index === 1, "rollup: carries the action index");
  // The bug this pins: an assertion has no action, so nothing may be attributed
  // to it. Falling back to the step index would hand it step 2's entries — and
  // there is no step 2 in action space, so it would silently borrow nothing or,
  // worse on a longer test, another step's requests.
  assert(
    s2.action_index === undefined && s2.net_requests === undefined,
    "rollup: a step that captured nothing is attributed nothing",
  );

  assert(s0.net_requests === 2 && s1.net_requests === 1, "rollup: requests land on the acting step");
  assert(s0.net_total_ms === 210 && s1.net_total_ms === 250, "rollup: sums request latency per step");
  assert(s0.net_failures === 1, "rollup: counts failed requests");

  // The split that carries the evidence: a 404 on a NAVIGATION is very often
  // the page under test, and must not read as a broken API contract.
  assert(
    s0.net_worst_status === 404 && s0.net_worst_api_status === undefined,
    "rollup: a 4xx on a navigation is not counted as an API failure",
  );
  assert(
    s1.net_worst_api_status === 503,
    "rollup: a 5xx on a non-navigational request IS an API failure",
  );

  // The other split: the page's own JS throwing is strong evidence; a
  // console.error is a log line healthy sites emit constantly.
  assert(
    s0.console_errors === 1 && s0.console_page_errors === 0,
    "rollup: a console.error is counted, but not as a page error",
  );
  assert(
    s1.console_errors === 1 && s1.console_page_errors === 1,
    "rollup: a pageerror counts as both",
  );

  assert(s1.diff_state === "changed" && s1.diff_ratio === 0.4, "rollup: carries the visual diff");
  assert(s1.a11y_violations === 1 && s1.a11y_new === 1, "rollup: carries the a11y result");
  assert(s1.healed === 1 && s0.healed === 0, "rollup: marks the step that healed");
  assert(s2.heal_failed === "no-candidates", "rollup: marks the step healing could not rescue");

  // The duration must be the ACTION's, not the screenshot's. Reading `ms`
  // instead of `stepMs` would make the suite-slowness view a chart of how long
  // PNGs take to write.
  assert(s0.ms === 900 && s1.ms === 2400, "rollup: step duration is the action's, not the shot's");
}

// ── 2. The run row ────────────────────────────────────────────────────

{
  const { run } = rollupFixture();
  assert(run.id === "run-1" && run.test_id === "test-1", "rollup: identity");
  assert(run.has_artifacts === true, "rollup: a run with a replay has artifacts");
  assert(run.failed_step_id === "s2", "rollup: names the failing step by id");
  assert(run.test_timeout_ms === 60000, "rollup: carries the timeout the run actually used");
  assert(
    run.console_dropped === 12 && run.network_dropped === 900,
    "rollup: carries what the per-run cap discarded",
  );
  assert(
    run.error_signature === "Error: Timed out <ms> waiting for expect(locator)",
    "rollup: normalizes the error into a clustering key",
  );

  const noArtifacts = rollupFixture({ replay: null, manifest: null, logs: null });
  assert(
    noArtifacts.run.has_artifacts === false && noArtifacts.steps.length === 0,
    "rollup: a run that captured nothing says so rather than looking clean",
  );
  // The heal-failure count survives even with no replay to attach it to a step.
  assert(
    noArtifacts.run.heal_failed_steps === 1,
    "rollup: run-level heal failures survive a run with no replay",
  );
}

// ── 3. The error signature ────────────────────────────────────────────

{
  // "Error Context:" is Playwright's pointer to the trace file, emitted AFTER
  // the failure. It matched first for 109 of 207 failing runs on the
  // development machine — one cluster swallowing every distinct failure.
  const log = "Error Context: test-results/foo/error-context.md\nError: locator.click failed\n";
  assert(
    firstErrorLine(log) === "Error: locator.click failed",
    "signature: skips Playwright's 'Error Context:' trace pointer",
  );
  // Colours land INSIDE the message, so an unstripped signature matches nothing
  // but an identically-coloured run. Stripped with the SAME function the rollup
  // uses — an inline regex here would be a second implementation of it, and
  // hand-writing one is exactly what `no-control-regex` exists to prevent.
  const coloured = `Error: ${ESC}[31mTimed out 5000ms${ESC}[39m waiting`;
  const colouredSignature = errorSignature(firstErrorLine(stripAnsi(coloured)));
  assert(
    !colouredSignature.includes(ESC),
    "signature: no escape sequence survives into the clustering key",
  );
  assert(
    colouredSignature === "Error: Timed out <ms> waiting",
    "signature: the stripped message is what gets normalized",
  );
  assert(
    errorSignature("Timeout 30000ms exceeded") === errorSignature("Timeout 5000ms exceeded"),
    "signature: the same failure at two durations is one cluster",
  );
  assert(
    errorSignature("Error: no element") !== errorSignature("Error: strict mode violation"),
    "signature: genuinely different failures stay apart",
  );
  assert(firstErrorLine("Running 1 test\n1 passed\n") === "", "signature: a clean log has none");
}

// ── 4. The database: idempotence and rebuild ──────────────────────────

const dir = mkdtempSync(join(tmpdir(), "glaze-metrics-check-"));
const file = join(dir, "metrics.db");
const db = new DatabaseSync(file);

function create(): void {
  for (const sql of CREATE_STATEMENTS) db.exec(sql);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function ingest(rows: ReturnType<typeof rollupFixture>): void {
  db.prepare(INSERT_RUN).run(...bind(RUN_COLUMNS, rows.run as never));
  const stmt = db.prepare(INSERT_STEP);
  for (const s of rows.steps) stmt.run(...bind(STEP_COLUMNS, s as never));
}

function scalar(sql: string): number {
  return Number((db.prepare(sql).all()[0] as Record<string, unknown>)?.n ?? -1);
}

try {
  for (const pragma of PRAGMAS) db.exec(pragma);
  create();
  assert(scalar("SELECT COUNT(*) AS n FROM runs") === 0, "db: the DDL applies to an empty file");

  const rows = rollupFixture();
  ingest(rows);
  assert(scalar("SELECT COUNT(*) AS n FROM runs") === 1, "db: one run row");
  assert(scalar("SELECT COUNT(*) AS n FROM step_metrics") === 3, "db: three step rows");

  // THE ONE THAT MATTERS. Run completion ingests; the prune preflight ingests
  // the same run again later. Without INSERT OR REPLACE the second write either
  // errors on the primary key or duplicates the rows, and duplicated rows make
  // every rate and median wrong while looking like real data.
  //
  // Caught rather than left to propagate: a plain INSERT throws "constraint
  // failed", and an uncaught throw here would end the run with a stack trace
  // instead of the named assertion that says what the property was.
  let reingestError: string | null = null;
  try {
    ingest(rollupFixture());
  } catch (err) {
    reingestError = String(err);
  }
  assert(reingestError === null, `db: re-ingesting a run does not error (${reingestError ?? "ok"})`);
  assert(
    scalar("SELECT COUNT(*) AS n FROM runs") === 1 &&
      scalar("SELECT COUNT(*) AS n FROM step_metrics") === 3,
    "db: ingesting the same run twice yields ONE row set",
  );

  // A rebuild has to reproduce the same thing, or "corruption is never fatal,
  // just rebuild" is not true.
  const before = JSON.stringify(db.prepare("SELECT * FROM step_metrics ORDER BY step_index").all());
  for (const sql of DROP_STATEMENTS) db.exec(sql);
  create();
  ingest(rollupFixture());
  const after = JSON.stringify(db.prepare("SELECT * FROM step_metrics ORDER BY step_index").all());
  assert(before === after, "db: a rebuild reproduces an identical result");

  // Cascade: a run's steps must not outlive it, or every aggregate counts rows
  // belonging to a run that no longer exists. `node:sqlite` enables foreign keys
  // by default and PRAGMAS asks for them explicitly; this pins the OUTCOME, so
  // it still fails if either of those stops being true.
  assert(
    Number((db.prepare("PRAGMA foreign_keys").all()[0] as Record<string, unknown>).foreign_keys) === 1,
    "db: foreign key enforcement is on",
  );
  db.prepare("DELETE FROM runs WHERE id = ?").run("run-1");
  assert(
    scalar("SELECT COUNT(*) AS n FROM step_metrics") === 0,
    "db: deleting a run cascades to its steps",
  );

  // ── 5. The curated queries ──────────────────────────────────────────

  create();
  ingest(rollupFixture());
  ingest(
    rollupFixture({
      run: makeRun({ id: "run-2", status: "passed", runBrowser: "webkit", startedAt: 2000 }),
    }),
  );

  assert(isPopulated(db), "query: reports a populated database");
  assert(counts(db).runs === 2 && counts(db).steps === 6, "query: counts runs and steps");

  const health = stepHealth(db);
  const s1Health = health.find((h) => h.stepId === "s1");
  assert(health.length === 3, "query: step health has one row per step");
  assert(
    s1Health?.runs === 2 && s1Health?.heals === 2 && s1Health?.visualChanges === 2,
    "query: step health joins heals and visual changes onto the same row",
  );
  const s2Health = health.find((h) => h.stepId === "s2");
  assert(s2Health?.healFailures === 2, "query: step health counts heals that could NOT rescue");
  assert(
    s2Health?.failRate === 1 && s1Health?.failRate === 0,
    "query: fail rate is per step, not per run",
  );

  const matrix = browserMatrix(db);
  assert(matrix.length === 2, "query: browser matrix has a row per engine");
  assert(
    matrix.find((m) => m.browser === "chromium")?.failed === 1 &&
      matrix.find((m) => m.browser === "webkit")?.failed === 0,
    "query: browser matrix separates the engines' outcomes",
  );

  // ── The Phase 4 queries, against a REAL database ────────────────────
  //
  // Exercised here rather than as pure functions because both are SQL, and the
  // one thing a fixture cannot catch is a statement SQLite rejects. That is not
  // hypothetical: `stepDurations` first computed its percentiles with `LIMIT 1
  // OFFSET <expression over aggregates>`, which SQLite accepted for p95 and
  // refused for p50 with "datatype mismatch" — and because `all()` swallows a
  // throw by contract (the DB is a cache, a failed read is a missing answer),
  // the broken half came back as `null` and read exactly like "this step was
  // never timed". A pure test of the arithmetic would have passed.
  {
    const durations = stepDurations(db, { window: 10 });
    assert(durations.length > 0, "query: step durations returns the timed steps");
    const timed = durations.filter((d) => d.recentRuns > 0);
    assert(
      timed.length > 0 && timed.every((d) => d.recentP50Ms !== null),
      "query: every step with timed runs has a median — a null here is the silent-failure shape",
    );
    assert(
      timed.every((d) => d.recentP95Ms !== null && d.recentP95Ms >= (d.recentP50Ms ?? 0)),
      "query: p95 is never below p50, and never null when p50 is not",
    );
    assert(
      durations.every((d) => d.previousRuns > 0 || d.changeRatio === null),
      "query: no change ratio is invented against a window with no samples",
    );

    const stepMatrix = stepBrowserMatrix(db);
    assert(
      stepMatrix.length > 0 && stepMatrix.every((r) => r.stepId && r.browser),
      "query: the step-browser matrix is keyed by step AND engine",
    );
    assert(
      stepMatrix.some((r) => r.browser === "chromium") &&
        stepMatrix.some((r) => r.browser === "webkit"),
      "query: …and both engines in the fixture are present",
    );
    // Every (step, browser) pair appears once — a duplicate would double every
    // count downstream and read as real data.
    const keys = stepMatrix.map((r) => `${r.testId}:${r.stepId}:${r.browser}`);
    assert(
      new Set(keys).size === keys.length,
      "query: one row per (test, step, engine), never a duplicate",
    );
  }

  const clusters = failureClusters(db);
  assert(
    clusters.length === 1 && clusters[0].runs === 1,
    "query: clusters failures by signature, excluding the passing run",
  );

  const cost = suiteCost(db);
  assert(cost.runs === 2 && cost.captureMs === 240, "query: suite cost sums the measured overhead");
  assert(cost.bySpeed[0]?.speed === "fast", "query: suite cost breaks down by speed");

  const evidence = runEvidence(db, "run-1");
  assert(evidence?.steps.length === 3, "query: run evidence returns the run and its steps");
  assert(
    Number(evidence?.run.network_dropped) === 900,
    "query: run evidence carries what the cap discarded, so silence can be read correctly",
  );
  assert(runEvidence(db, "nope") === null, "query: an unknown run is null, not an empty shell");

  const siblings = siblingRuns(db, "test-1", { excludeRunId: "run-1" });
  assert(
    siblings.length === 1 && siblings[0].id === "run-2",
    "query: sibling runs exclude the run being triaged",
  );
  // Step-scoped: the sibling's outcome ON a given step, so triage can tell
  // "passed on webkit" from "never ran there". run-2 is rolled up from the
  // same replay (s0 passed, s2 failed) under a run marked passed — which is
  // what shows the column is the STEP's outcome and not the run's.
  const ranS0 = siblingRuns(db, "test-1", { excludeRunId: "run-1", stepId: "s0" });
  assert(ranS0[0]?.step_status === "passed", "query: a sibling carries the asked-for step's own outcome");
  const ranS2 = siblingRuns(db, "test-1", { excludeRunId: "run-1", stepId: "s2" });
  assert(
    ranS2[0]?.step_status === "failed" && ranS2[0]?.status === "passed",
    "query: the step's outcome, not the run's",
  );
  const never = siblingRuns(db, "test-1", { excludeRunId: "run-1", stepId: "never-ran" });
  assert(
    never.length === 1 && never[0].step_status === null,
    "query: a step the sibling never executed is null, not borrowed from the run",
  );
  assert(
    siblings[0].step_status === null,
    "query: asked without a step id, every sibling reads as not having executed it",
  );

  // Its own database: the assertions below ingest extra runs, and doing that
  // to the shared one moves every count the earlier queries were checked
  // against.
  for (const sql of DROP_STATEMENTS) db.exec(sql);
  create();
  ingest(rollupFixture());
  ingest(
    rollupFixture({
      run: makeRun({ id: "run-2", status: "passed", runBrowser: "webkit", startedAt: 2000 }),
    }),
  );

  // ── 5b. testDurationTrend (C §6.3) ──────────────────────────────────
  //
  // Real SQL against a real database for the same reason as above: the one
  // thing a pure fixture cannot catch is a statement SQLite rejects, and
  // `all()` swallows a throw by contract — a broken query returns [] and
  // reads exactly like "this test has never passed".
    // The fixture holds run-1 (failed, 4000ms) and run-2 (passed, 4000ms).
    const trend = testDurationTrend(db, "test-1");
    assert(
      trend.recentRuns === 1 && trend.recentP50Ms === 4000,
      "query: a test's trend takes its median from its PASSED runs",
    );
    assert(
      trend.previousP50Ms === null && trend.changeRatio === null,
      "query: …and invents no ratio against a window with no samples",
    );

    // A slow FAILED run must not move the median. This is the whole reason
    // the statement filters on status: a run that timed out is as slow as
    // the budget, and one that died on step two is fast — either poisons a
    // median being used to say whether a PASS was unusual.
    ingest(
      rollupFixture({
        run: makeRun({ id: "run-3", status: "failed", durationMs: 900_000, startedAt: 3000 }),
      }),
    );
    assert(
      testDurationTrend(db, "test-1").recentP50Ms === 4000,
      "query: a failed run's duration never enters the median",
    );

    // Same for a baseline-update row, which is an audit event rather than
    // an execution — excluded everywhere else in the app for this reason.
    ingest(
      rollupFixture({
        run: makeRun({
          id: "run-4",
          status: "passed",
          kind: "baseline-update",
          durationMs: 1,
          startedAt: 4000,
        }),
      }),
    );
    assert(
      testDurationTrend(db, "test-1").recentP50Ms === 4000,
      "query: …nor does a baseline-update row",
    );

    assert(
      testDurationTrend(db, "no-such-test").recentP50Ms === null,
      "query: a test with no history reports no median rather than zero",
    );

  // ── 5c. stepDurations' scope (R1) ───────────────────────────────────
  //
  // The scope reaches SQL rather than filtering the output, because these rows
  // come back aggregated per step: filtering afterwards would drop whole steps
  // while leaving the surviving medians computed over runs OUTSIDE the scope —
  // "the p95 for this batch" with last month quietly in it.
  //
  // Real SQL for the reason the section above gives, and one more specific to
  // this change: the WHERE clause is now assembled from a list, so the risk is
  // a condition and its parameter drifting out of order. SQLite binds
  // positionally and would not complain — it would filter on the wrong column
  // and return a plausible, wrong set of rows. `all()` swallowing throws means
  // a genuinely malformed statement comes back as [] and reads as "no data".
  {
    for (const sql of DROP_STATEMENTS) db.exec(sql);
    create();
    // test-1 twice in batch b1, test-2 once in b2, test-1 once with no batch.
    ingest(rollupFixture({ run: makeRun({ id: "s-1", batchId: "b1", startedAt: 1000 }) }));
    ingest(rollupFixture({ run: makeRun({ id: "s-2", batchId: "b1", startedAt: 2000 }) }));
    ingest(
      rollupFixture({
        run: makeRun({ id: "s-3", testId: "test-2", batchId: "b2", startedAt: 3000 }),
      }),
    );
    ingest(rollupFixture({ run: makeRun({ id: "s-4", startedAt: 4000 }) }));

    const runsBehind = (opts: Parameters<typeof stepDurations>[1]) =>
      stepDurations(db, { ...opts, window: 10 }).reduce((n, d) => n + d.recentRuns, 0);

    // The fixture writes three steps per run, one of which has no `ms`, so the
    // arithmetic below counts the TIMED step-runs: two per run.
    const all = runsBehind({});
    assert(all > 0, "scope: an unscoped query still returns the timed steps");
    assert(
      runsBehind({ batchId: "b1" }) < all,
      "scope: a batch is a strict subset — if this equals the unscoped count the " +
        "condition never reached the statement",
    );
    assert(
      runsBehind({ batchId: "b2" }) + runsBehind({ batchId: "b1" }) < all,
      "scope: …and the batches do not between them cover the run that has no batch",
    );
    assert(runsBehind({ batchId: "nope" }) === 0, "scope: an unmatched batch selects nothing");
    assert(
      runsBehind({ testId: "test-2" }) === runsBehind({ batchId: "b2" }),
      "scope: testId and batchId reach the same single run here",
    );
    assert(
      runsBehind({ testId: "test-1", batchId: "b2" }) === 0,
      "scope: the fields AND together — this test is not in that batch",
    );
    assert(
      runsBehind({ since: 3000 }) < all && runsBehind({ since: 3000 }) > 0,
      "scope: since bounds the window from below",
    );
    assert(
      runsBehind({ since: 2000, until: 3000 }) === runsBehind({ runIds: ["s-2", "s-3"] }),
      "scope: an inclusive since/until window selects the same runs naming them does",
    );
    assert(runsBehind({ runIds: ["s-1"] }) > 0, "scope: an explicit run id selects that run");
    assert(
      stepDurations(db, { runIds: [] }).length === 0,
      "scope: an EMPTY runIds selects NOTHING — skipping the condition would widen " +
        "it to the whole database, which is the exact bug scoping exists to prevent",
    );
  }

  // ── 5b. The recovery query ──────────────────────────────────────────
  //
  // The one query here that exists for a NUMBER rather than a view. The run
  // index is capped and the counter that records what the cap prunes could only
  // start counting on the day it shipped — so on an app already past the cap,
  // everything pruned before then was deleted with nothing recording it. This
  // table is the only surviving trace: a row per run, and nothing deletes rows.
  {
    const day = (iso: string, hour: number) => new Date(`${iso}T0${hour}:00:00`).getTime();
    const write = (row: Record<string, unknown>) =>
      db.prepare(INSERT_RUN).run(...bind(RUN_COLUMNS, row));

    for (const sql of DROP_STATEMENTS) db.exec(sql);
    for (const sql of CREATE_STATEMENTS) db.exec(sql);

    write({ id: "a", test_id: "t", test_name: "T", status: "passed", kind: "run",
      started_at: day("2026-08-10", 9), duration_ms: 1 });
    write({ id: "b", test_id: "t", test_name: "T", status: "failed", kind: "run",
      started_at: day("2026-08-10", 5), duration_ms: 1 });
    write({ id: "c", test_id: "t", test_name: "T", status: "passed", kind: "run",
      started_at: day("2026-08-11", 3), duration_ms: 1 });
    // An event with an incidental status, excluded here exactly as it is
    // everywhere else — counting it would move a total nothing executed changed.
    write({ id: "d", test_id: "t", test_name: "T", status: "passed", kind: "baseline-update",
      started_at: day("2026-08-11", 4), duration_ms: 0 });

    const lifetime = lifetimeRunCounts(db);
    assert(lifetime.runs === 3, "recovery: counts every run the database still holds");
    assert(
      lifetime.passed === 2 && lifetime.failed === 1,
      "recovery: splits them by outcome",
    );
    assert(
      JSON.stringify(lifetime.days) ===
        JSON.stringify([
          { day: "2026-08-10", runs: 2, passed: 1, failed: 1 },
          { day: "2026-08-11", runs: 1, passed: 1, failed: 0 },
        ]),
      "recovery: groups by LOCAL calendar day, ascending — the bucketing the chart and the digest use",
    );

    // Two runs hours apart on ONE local day must not become two days. Grouping
    // on UTC would split them for anyone west of Greenwich, and the digest
    // would report a week that never happened.
    assert(lifetime.days.length === 2, "recovery: hours apart on one local day is one bucket");

    assert(
      lifetimeRunCounts(db, { sinceMs: day("2026-08-11", 0) }).days.length === 1,
      "recovery: `sinceMs` bounds the day breakdown without touching the totals",
    );
    assert(
      lifetimeRunCounts(db, { sinceMs: day("2026-08-11", 0) }).runs === 3,
      "recovery: …the lifetime total is a lifetime total",
    );
    assert(lifetimeRunCounts(null).runs === 0, "recovery: unavailable answers zero, not a throw");
  }

  // ── 6. Never fatal ──────────────────────────────────────────────────
  //
  // Metrics are unavailable on a runtime without node:sqlite, so every read has
  // to answer "nothing" rather than throw. A view that crashes when the cache is
  // absent is worse than one that shows no data.
  assert(isPopulated(null) === false, "unavailable: isPopulated answers false, not a throw");
  assert(counts(null).runs === 0, "unavailable: counts answers zero");
  assert(stepHealth(null).length === 0, "unavailable: step health answers empty");
  assert(runEvidence(null, "run-1") === null, "unavailable: run evidence answers null");
  assert(failureClusters(null).length === 0, "unavailable: clusters answer empty");

  // A query against a database whose tables are gone must degrade the same way.
  for (const sql of DROP_STATEMENTS) db.exec(sql);
  assert(
    stepHealth(db).length === 0 && counts(db).runs === 0,
    "corrupt: a database with no tables reads as empty rather than throwing",
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── 7. Launch ordering: the startup sweep cannot outrun the preflight ─
//
// Everything above proves the preflight DOES the right thing; none of it can
// prove the app REGISTERS it before the first prune. The startup sweep used to
// run at module scope while the registration waited inside `app.whenReady()`,
// and every run the sweep removed was deleted unrolled (failure mode 5 above).
//
// Source-level via the real TypeScript AST, because the subject is the
// Electron entry file — nothing can execute it under a check — and because the
// property is structural: the old broken layout also sat indented inside a
// bare `{}` block, so text position and indentation cannot tell the two
// shapes apart.
{
  const entry = readFileSync(join(process.cwd(), "main", "index.ts"), "utf-8");
  const sf = ts.createSourceFile("index.ts", entry, ts.ScriptTarget.Latest, true);

  const calls: ts.CallExpression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);

  const callee = (c: ts.CallExpression): string => c.expression.getText(sf).replace(/\s+/g, "");
  const callsTo = (name: string): ts.CallExpression[] => calls.filter((c) => callee(c) === name);

  const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p)) return p;
    }
    return undefined;
  };

  const sweeps = callsTo("applyRetention");
  const registrations = callsTo("setPrunePreflight");
  const opens = callsTo("metricsStore.init");

  assert(sweeps.length === 1, "ordering: index.ts sweeps retention exactly once");
  assert(registrations.length === 1, "ordering: index.ts registers the preflight exactly once");
  assert(opens.length === 1, "ordering: index.ts opens the metrics db exactly once");

  if (sweeps.length === 1 && registrations.length === 1 && opens.length === 1) {
    const fn = enclosingFunction(sweeps[0]);
    assert(fn !== undefined, "ordering: the startup sweep is not at module scope");
    assert(
      fn !== undefined &&
        enclosingFunction(registrations[0]) === fn &&
        enclosingFunction(opens[0]) === fn,
      "ordering: sweep, preflight registration and db open share one function",
    );

    let inWhenReady = false;
    for (let p: ts.Node | undefined = fn; p; p = p.parent) {
      if (ts.isCallExpression(p) && callee(p) === "app.whenReady().then") inWhenReady = true;
    }
    assert(inWhenReady, "ordering: that function is the whenReady callback");

    assert(
      opens[0].getStart(sf) < registrations[0].getStart(sf) &&
        registrations[0].getStart(sf) < sweeps[0].getStart(sf),
      "ordering: metrics open, then preflight registration, then the sweep",
    );
  }
}

// ── 7. Site Health rows (schema 2) ────────────────────────────────────
//
// Two tables with two provenances, and the split is the design: host rows come
// from the run RECORD's summary (which survives artifact retention) and page
// rows from the ARTIFACT (which does not). A rollup that derived both from the
// artifact would give a domain a series exactly as long as its screenshots.
{
  const reading = (over: Record<string, unknown>) => ({
    id: "doc",
    url: "https://shop.example.com/",
    host: "shop.example.com",
    path: "/",
    title: "Home",
    tab: 0,
    cold: true,
    navType: "navigate",
    engine: "chromium",
    action: 0,
    at: 1500,
    status: 200,
    xRobotsTag: null,
    facts: {
      titleLength: 4, descriptionLength: 90, lang: "en", viewport: true, canonical: [], robots: [],
      h1Count: 1, imagesTotal: 1, imagesMissingAlt: 0, links: { total: 3, generic: 0, uncrawlable: 0 },
      hreflang: [], jsonLd: { blocks: 0, invalid: 0, types: [] },
      og: { title: true, description: true, image: true }, twitterCard: true, protocol: "https:", insecureResources: 0,
    },
    metrics: { ttfb: 150, fcp: 800, lcp: 1600, cls: 0.01, tbt: 30, inp: null, dcl: 1000, load: 1800, requests: 20, transferBytes: 512000 },
    source: "lab",
    ...over,
  });
  const artifact = normalizeSiteHealthArtifact({
    testId: "test-1",
    runId: "run-1",
    attempt: 0,
    ms: 90,
    pages: [
      reading({}),
      reading({ id: "doc-2", url: "https://shop.example.com/cart", path: "/cart", title: "Cart", action: 1, facts: { ...reading({}).facts, h1Count: 0, descriptionLength: 0 }, metrics: { ...reading({}).metrics, lcp: 4200, cls: 0.3 } }),
      reading({ id: "doc-3", url: "https://blog.example.com/post", host: "blog.example.com", path: "/post", title: "Post", action: 1 }),
    ],
  });
  assert(artifact !== null && artifact.pages.length === 3, "site health: the fixture artifact normalises");
  const summary = summariseSiteHealth(artifact!);

  const rows = rollupFixture({ run: makeRun({ siteHealth: summary, ingestedAt: 7777 }) as never, siteHealth: artifact });
  assert(rows.hosts.length === 2, "rollup: one host row per host in the run's summary");
  const shop = rows.hosts.find((h) => h.host === "shop.example.com");
  assert(shop?.pages === 2 && typeof shop?.seo === "number" && typeof shop?.perf === "number", "rollup: a host row carries the page count and both scores");
  assert(rows.pages.length === 3, "rollup: one page row per reading in the artifact");
  const cart = rows.pages.find((p) => p.path === "/cart");
  assert(
    typeof cart?.seo === "number" && cart.seo < 100 && auditsFromText(cart.seo_audits).some((a) => a.id === "single-h1" && a.status === "fail"),
    "rollup: a page row is SCORED here, and its audit list reads back through the shared parser",
  );
  assert(cart?.lcp === 4200 && cart?.cls === 0.3 && cart?.coverage === "fcp lcp tbt cls" && cart?.action === 1, "rollup: the vitals, coverage and screenshot join land on the row");
  assert(rows.run.ingested_at === 7777, "rollup: the run row carries when it was ingested");

  // Retention took the artifact: the host rows are still there.
  const pruned = rollupFixture({ run: makeRun({ siteHealth: summary }) as never, siteHealth: null });
  assert(pruned.hosts.length === 2 && pruned.pages.length === 0, "rollup: a pruned run keeps its host rows and loses only its page rows");
  const unmeasured = rollupFixture({ run: makeRun() as never, siteHealth: null });
  assert(unmeasured.hosts.length === 0 && unmeasured.pages.length === 0 && unmeasured.run.ingested_at === undefined, "rollup: a run that did not measure writes no Site Health rows");
  // A hostile summary on an ingested record is rebuilt, not trusted.
  const hostile = rollupFixture({ run: makeRun({ siteHealth: { pages: 1, ms: 1, hosts: [{ host: "x".repeat(400), pages: 1, seo: 999, perf: -5 }, { host: "ok.example.com", pages: 1, seo: 50, perf: 50 }] } }) as never });
  assert(hostile.hosts.length === 1 && hostile.hosts[0]?.host === "ok.example.com", "rollup: a summary host that fails the gate is dropped, the rest kept");

  const dir2 = mkdtempSync(join(tmpdir(), "glaze-metrics-sh-"));
  const db2 = new DatabaseSync(join(dir2, "metrics.db"));
  try {
    for (const pragma of PRAGMAS) db2.exec(pragma);
    for (const sql of CREATE_STATEMENTS) db2.exec(sql);
    const write = (r: ReturnType<typeof rollupFixture>) => {
      db2.prepare(INSERT_RUN).run(...bind(RUN_COLUMNS, r.run as never));
      for (const st of r.steps) db2.prepare(INSERT_STEP).run(...bind(STEP_COLUMNS, st as never));
      for (const h of r.hosts) db2.prepare(INSERT_HOST_HEALTH).run(...bind(HOST_HEALTH_COLUMNS, h as never));
      for (const pg of r.pages) db2.prepare(INSERT_PAGE_HEALTH).run(...bind(PAGE_HEALTH_COLUMNS, pg as never));
    };
    write(rows);
    write(rows);
    const n = (sql: string) => Number((db2.prepare(sql).all()[0] as Record<string, unknown>)?.n ?? -1);
    assert(n("SELECT COUNT(*) AS n FROM host_health") === 2 && n("SELECT COUNT(*) AS n FROM page_health") === 3, "db: host and page rows insert, and re-ingesting yields ONE row set");

    const hostRows = siteHealthHostRows(db2, { sinceMs: 0 });
    assert(hostRows.length === 2 && hostRows[0]?.testName === "Checkout" && hostRows[0]?.at === 1000, "query: host rows come back joined to their run, camelCase");
    assert(Number(hostRows[0]?.ingested) === 1, "query: an ingested run's rows say so");
    assert(siteHealthHostRows(db2, { host: "blog.example.com" }).length === 1, "query: host rows filter by host");
    assert(siteHealthHostRows(db2, { sinceMs: 5000 }).length === 0, "query: host rows respect the window");
    const pageRows = siteHealthPageRows(db2, { host: "shop.example.com" });
    assert(pageRows.length === 2 && pageRows[1]?.path === "/cart" && pageRows[1]?.load === 1800 && pageRows[1]?.transferBytes === 512000, "query: page rows filter by host and alias every column");
    assert(typeof pageRows[1]?.seoAudits === "string" && pageRows[1]?.runAt === 1000, "query: a page row carries its audit text and the run's start");
    const hosts = siteHealthHosts(db2);
    assert(hosts.length === 2 && hosts.every((h) => h.runs === 1 && h.lastAt === 1000), "query: the host list counts runs per host");

    db2.prepare("DELETE FROM runs WHERE id = ?").run("run-1");
    assert(n("SELECT COUNT(*) AS n FROM host_health") === 0 && n("SELECT COUNT(*) AS n FROM page_health") === 0, "db: deleting a run cascades to its Site Health rows");
    assert(siteHealthHostRows(null).length === 0 && siteHealthPageRows(null).length === 0 && siteHealthHosts(null).length === 0, "query: no database is an empty answer, never a throw");
  } finally {
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
  assert(SCHEMA_VERSION >= 2, "schema: the version moved with the tables (a database at version 1 is dropped and replayed)");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll metrics-db checks passed.");
