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
//
// The database is EXERCISED FOR REAL against a temp file rather than asserted
// on as source text, because "the same run ingested twice yields one row set"
// is behaviour, and a source assertion would pass against a schema that does
// none of it.
//
// Run with: npm run check:metrics-db

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  stepBrowserMatrix,
  stepDurations,
  stepHealth,
  suiteCost,
} from "../../../shared/metrics-query.mjs";
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll metrics-db checks passed.");
