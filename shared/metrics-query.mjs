// The curated queries behind every tool and every view.
//
// Pure in the sense shared/ means it: no filesystem, no @glaze/core, no IPC.
// It takes a connection HANDLE and returns plain objects. Opening the database
// is the caller's business — metrics-store.ts on the app side, mcp/metrics.mjs
// on the other.
//
// ONE RULE: no SQL escapes this file. Not into a tool body, not into a React
// component, not into an emitter. That is what makes the plan's "strictly
// local, per-machine" decision reversible — swapping the backing store later
// means reimplementing this one file, rather than auditing every call site that
// had grown its own query.
//
// It is also why the MCP exposes curated TOOLS and not a SQL escape hatch: an
// escape hatch makes the schema a public contract, and this schema is a derived
// cache that gets dropped and rebuilt whenever its version changes.
//
// Every function takes `db` first and tolerates `db` being null — metrics are
// unavailable on a runtime without node:sqlite, and "no data" has to be an
// ordinary answer rather than a crash.

/** Run a query, returning [] if anything goes wrong. The database is a cache;
 *  a failed read is a missing answer, never an error worth propagating. */
function all(db, sql, params = []) {
  if (!db) return [];
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function one(db, sql, params = []) {
  return all(db, sql, params)[0] ?? null;
}

/** Whether there is anything to read. Callers show a "run some tests" state
 *  rather than an empty table, which reads as a bug. */
export function isPopulated(db) {
  return Number(one(db, "SELECT COUNT(*) AS n FROM runs")?.n ?? 0) > 0;
}

export function counts(db) {
  const r = one(
    db,
    `SELECT (SELECT COUNT(*) FROM runs) AS runs,
            (SELECT COUNT(*) FROM step_metrics) AS steps,
            (SELECT COUNT(*) FROM runs WHERE has_artifacts = 1) AS runsWithArtifacts`,
  );
  return {
    runs: Number(r?.runs ?? 0),
    steps: Number(r?.steps ?? 0),
    runsWithArtifacts: Number(r?.runsWithArtifacts ?? 0),
  };
}

/**
 * Step Health — one row per step across all retained history.
 *
 * The join the whole phase exists for. Each of these five columns lives in a
 * different file today and is shown in a different panel, so the rows that
 * matter are invisible: a step that never fails but has healed four times, or
 * one whose median time doubled while still passing. Neither is visible in any
 * view that holds only one of the columns.
 *
 * Keyed by `step_id`, not by index — indices shift the moment a test is edited,
 * and a health history that resets on every edit is not a history.
 *
 * `p50_ms` is NULL for steps whose runs predate the fixture measuring step
 * duration. Left null rather than substituted: a made-up median in a column
 * people sort by is worse than a gap.
 */
export function stepHealth(db, { testId, limit = 200 } = {}) {
  const where = testId ? "WHERE r.test_id = ?" : "";
  const params = testId ? [testId, limit] : [limit];
  return all(
    db,
    `SELECT s.step_id                                        AS stepId,
            MAX(s.label)                                     AS label,
            MAX(s.type)                                      AS type,
            r.test_id                                        AS testId,
            MAX(r.test_name)                                 AS testName,
            COUNT(*)                                         AS runs,
            SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(s.healed)                                    AS heals,
            SUM(CASE WHEN s.heal_failed IS NOT NULL THEN 1 ELSE 0 END) AS healFailures,
            SUM(CASE WHEN s.diff_state = 'changed' THEN 1 ELSE 0 END)  AS visualChanges,
            SUM(COALESCE(s.a11y_new, 0))                     AS a11yNew,
            SUM(COALESCE(s.console_page_errors, 0))          AS pageErrors,
            COUNT(s.ms)                                      AS timedRuns,
            MIN(s.ms)                                        AS minMs,
            MAX(s.ms)                                        AS maxMs,
            MAX(r.started_at)                                AS lastSeenAt
     FROM step_metrics s
     JOIN runs r ON r.id = s.run_id
     ${where}
     GROUP BY s.step_id, r.test_id
     ORDER BY failed DESC, heals DESC, runs DESC
     LIMIT ?`,
    params,
  ).map((row) => ({
    ...row,
    failRate: row.runs > 0 ? row.failed / row.runs : 0,
  }));
}

/**
 * The median duration of one step over its most recent runs, and over the N
 * before those.
 *
 * SQLite has no percentile function, so the median is taken by offset into an
 * ordered window. Two windows rather than a single trend line because the
 * question people actually ask is "is this slower than it was?", and answering
 * it needs a before to compare the after against.
 *
 * Returns nulls when a window has no timed runs, which is the common case for
 * history recorded before the fixture measured step duration.
 */
export function stepDurationTrend(db, stepId, window = 10) {
  const median = (offset) =>
    one(
      db,
      `SELECT ms FROM (
         SELECT s.ms AS ms
         FROM step_metrics s JOIN runs r ON r.id = s.run_id
         WHERE s.step_id = ? AND s.ms IS NOT NULL
         ORDER BY r.started_at DESC LIMIT ? OFFSET ?
       ) ORDER BY ms LIMIT 1 OFFSET (
         SELECT COUNT(*) / 2 FROM (
           SELECT s.ms FROM step_metrics s JOIN runs r ON r.id = s.run_id
           WHERE s.step_id = ? AND s.ms IS NOT NULL
           ORDER BY r.started_at DESC LIMIT ? OFFSET ?
         )
       )`,
      [stepId, window, offset, stepId, window, offset],
    )?.ms ?? null;
  const recent = median(0);
  const previous = median(window);
  return {
    stepId,
    window,
    recentMedianMs: recent,
    previousMedianMs: previous,
    // Only when BOTH windows have data. A ratio against a missing baseline
    // would read as "no change" when it means "nothing to compare".
    changeRatio: recent !== null && previous ? recent / previous : null,
  };
}

/**
 * Where a suite's time goes.
 *
 * Answers pain 3 with the part the user can actually act on separated out:
 * capture and accessibility are measured, and the step delay is exactly
 * derivable from the speed each run used, so the instrumentation's share is
 * known rather than estimated. "3m20s of your 5m suite is capture, a11y and the
 * Slow speed you chose" is a different conversation from "your suite is slow".
 */
export function suiteCost(db, { since = 0 } = {}) {
  const r = one(
    db,
    `SELECT COUNT(*)                        AS runs,
            SUM(duration_ms)                AS totalMs,
            SUM(COALESCE(capture_ms, 0))    AS captureMs,
            SUM(COALESCE(a11y_ms, 0))       AS a11yMs,
            SUM(COALESCE(shot_count, 0))    AS shots
     FROM runs WHERE started_at >= ?`,
    [since],
  );
  const bySpeed = all(
    db,
    `SELECT COALESCE(speed, 'unknown') AS speed, COUNT(*) AS runs, SUM(duration_ms) AS totalMs
     FROM runs WHERE started_at >= ? GROUP BY speed ORDER BY totalMs DESC`,
    [since],
  );
  return {
    runs: Number(r?.runs ?? 0),
    totalMs: Number(r?.totalMs ?? 0),
    captureMs: Number(r?.captureMs ?? 0),
    a11yMs: Number(r?.a11yMs ?? 0),
    shots: Number(r?.shots ?? 0),
    bySpeed,
  };
}

/**
 * A test × engine matrix of outcomes.
 *
 * Feeds triage directly — "fails on all three engines" versus "only on WebKit"
 * is one of the strongest discriminators available between a site problem and a
 * test problem — and is worth showing on its own, since a step that fails on
 * one engine is a different bug report from one that fails everywhere.
 */
export function browserMatrix(db, { testId } = {}) {
  const where = testId ? "WHERE test_id = ?" : "";
  return all(
    db,
    `SELECT test_id AS testId, MAX(test_name) AS testName,
            COALESCE(browser, 'unknown') AS browser,
            COUNT(*) AS runs,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM runs ${where}
     GROUP BY test_id, browser
     ORDER BY testName, browser`,
    testId ? [testId] : [],
  );
}

/**
 * Failures grouped by what they say, most common first.
 *
 * One root cause showing up in twenty runs should read as one problem, not
 * twenty. Runs with no signature are excluded rather than lumped into an
 * "unknown" cluster — a cluster is read as "these all failed the same way", and
 * "we could not tell" is not that.
 */
export function failureClusters(db, { limit = 20, since = 0 } = {}) {
  return all(
    db,
    `SELECT error_signature AS signature,
            COUNT(*)        AS runs,
            COUNT(DISTINCT test_id) AS tests,
            MAX(started_at) AS lastSeenAt,
            MIN(started_at) AS firstSeenAt
     FROM runs
     WHERE status = 'failed' AND error_signature <> '' AND started_at >= ?
     GROUP BY error_signature
     ORDER BY runs DESC, lastSeenAt DESC
     LIMIT ?`,
    [since, limit],
  );
}

/**
 * Everything known about one run, in the shape triage needs.
 *
 * `console_dropped` / `network_dropped` come back with it deliberately: a
 * verdict drawn from "no failing request on that step" must be able to tell
 * that from "that step's requests were discarded by the per-run cap", and on a
 * busy site the second is common.
 */
export function runEvidence(db, runId) {
  const run = one(db, "SELECT * FROM runs WHERE id = ?", [runId]);
  if (!run) return null;
  const steps = all(
    db,
    "SELECT * FROM step_metrics WHERE run_id = ? ORDER BY step_index",
    [runId],
  );
  return { run, steps };
}

/**
 * Per-step duration percentiles over the most recent runs, and over the N
 * before those.
 *
 * `stepDurationTrend` answers this for ONE step; the slowness view needs it for
 * every step at once, and 200 round trips to answer "what got slower" is the
 * shape that makes a view feel broken. Same two-window reasoning: the question
 * is "is this slower than it was", which needs a before.
 *
 * p95 as well as p50 because they answer different questions and the plan asked
 * for both. A p50 that moved says the step genuinely got slower; a p50 that held
 * while p95 doubled says it usually fine and occasionally terrible, which is the
 * profile of a step about to start failing on the timeout.
 *
 * SQLite has no percentile function, so each is taken by offset into an ordered
 * window — `NTILE`/`PERCENT_RANK` would need a window function per group and
 * this stays one pass. The offset is `(n * pct) / 100` clamped to the last row,
 * which is the nearest-rank definition; with fewer than ~20 samples p95 IS the
 * maximum, and that is the honest answer rather than an interpolation invented
 * from four points.
 *
 * Steps with no timed runs in a window come back null there rather than zero: a
 * made-up duration in a column people sort by is worse than a gap, same rule
 * `stepHealth.p50_ms` follows.
 */
export function stepDurations(db, { testId, window = 10, limit = 200 } = {}) {
  const rows = all(
    db,
    `WITH ranked AS (
       SELECT s.step_id, s.ms, s.label, s.type, r.test_id, r.test_name,
              row_number() OVER (PARTITION BY s.step_id ORDER BY r.started_at DESC) AS rn
       FROM step_metrics s JOIN runs r ON r.id = s.run_id
       WHERE s.ms IS NOT NULL ${testId ? "AND r.test_id = ?" : ""}
     )
     SELECT step_id AS stepId, ms, label, type,
            test_id AS testId, test_name AS testName, rn
     FROM ranked
     WHERE rn <= ?
     ORDER BY step_id, rn`,
    testId ? [testId, window * 2] : [window * 2],
  );

  // The percentiles are computed HERE rather than in the statement, and that is
  // deliberate after getting it wrong the other way. Nearest-rank by `LIMIT 1
  // OFFSET <expression>` needs the offset to be an expression over aggregates
  // of the same window, and SQLite rejected it with "datatype mismatch" for p50
  // while accepting the identical shape for p95. Worse, `all()` swallows a
  // throw by contract — it treats the database as a cache — so the broken half
  // came back as `null` and read exactly like "this step has no timings". A
  // query that can fail SILENTLY is not worth the cleverness when the same
  // arithmetic over at most `window * 2` numbers per step is four lines of JS.
  const byStep = new Map();
  for (const r of rows) {
    const g = byStep.get(r.stepId) ?? { row: r, recent: [], previous: [] };
    (r.rn <= window ? g.recent : g.previous).push(r.ms);
    byStep.set(r.stepId, g);
  }

  return [...byStep.values()]
    .sort((a, b) => b.recent.length - a.recent.length)
    .slice(0, limit)
    .map(({ row, recent, previous }) => {
      const recentP50 = percentile(recent, 50);
      const previousP50 = percentile(previous, 50);
      return {
        stepId: row.stepId,
        label: row.label,
        type: row.type,
        testId: row.testId,
        testName: row.testName,
        recentRuns: recent.length,
        previousRuns: previous.length,
        recentP50Ms: recentP50,
        recentP95Ms: percentile(recent, 95),
        previousP50Ms: previousP50,
        // Only when BOTH windows have data. A ratio against a missing baseline
        // reads as "no change" when it means "nothing to compare".
        changeRatio: recentP50 !== null && previousP50 ? recentP50 / previousP50 : null,
      };
    });
}

/**
 * A TEST's own duration, recent median against the median before that.
 *
 * The step-level answer to "is this slower than it was?" is `stepDurations`;
 * this is the same question one level up, and C §6.3 is why it exists — `Temp`
 * needs a real median to measure a run against, and until now the only one
 * available to the renderer came from `run-history.json`.
 *
 * WHICH MATTERS BECAUSE RETENTION PRUNES THAT FILE AND NOT THIS ONE. The
 * metrics DB is rolled up BEFORE retention runs (see CLAUDE.md), so after a
 * prune it holds strictly more history than the JSON does — and a median is
 * exactly the statistic that degrades when its sample is silently truncated.
 *
 * PASSED RUNS ONLY. A failure's duration is not evidence about how long this
 * test takes: a run that died on step two is fast, and a run that timed out is
 * as slow as the budget. Either one poisons a median that is being used to say
 * whether a PASS was unusual. `baseline-update` rows are excluded for the
 * reason they are everywhere else — accepting screenshots is an audit event,
 * not an execution.
 *
 * Both windows come back null when there is nothing to measure, which is the
 * ordinary state of a test that has run twice.
 */
export function testDurationTrend(db, testId, window = 10) {
  const rows = all(
    db,
    `SELECT duration_ms AS ms
     FROM runs
     WHERE test_id = ? AND status = 'passed' AND COALESCE(kind, 'run') = 'run'
     ORDER BY started_at DESC
     LIMIT ?`,
    [testId, window * 2],
  );

  // Sliced in JS rather than by two OFFSET queries, for the reason written out
  // at length in `stepDurations`: `all()` swallows a throw by contract, so a
  // statement SQLite rejects comes back as an empty array and reads exactly
  // like "this test has no timings".
  const ms = rows.map((r) => r.ms);
  const recentP50 = percentile(ms.slice(0, window), 50);
  const previousP50 = percentile(ms.slice(window), 50);

  return {
    testId,
    window,
    recentRuns: Math.min(ms.length, window),
    previousRuns: Math.max(0, ms.length - window),
    recentP50Ms: recentP50,
    previousP50Ms: previousP50,
    // Only when BOTH windows have data — a ratio against a missing baseline
    // reads as "no change" when it means "nothing to compare".
    changeRatio: recentP50 !== null && previousP50 ? recentP50 / previousP50 : null,
  };
}

/**
 * Nearest-rank percentile, or null for an empty sample.
 *
 * Nearest-rank rather than interpolated: with the ten-run windows this uses,
 * p95 IS the maximum, and that is the honest answer — an interpolated value
 * invented from four points reads as a measurement.
 */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return sorted[index];
}

/**
 * A step × engine matrix of outcomes.
 *
 * `browserMatrix` answers this per TEST, which is what triage needs. The
 * divergence view needs it per STEP, because that is where the answer is
 * actionable: "this test fails on WebKit" sends you to read the whole test,
 * "step 7 fails on WebKit and nowhere else" sends you to one locator.
 *
 * Keyed on `step_id`, not index — a step's index changes the moment the test is
 * edited, and a matrix that reshuffles on every edit is not a matrix.
 */
export function stepBrowserMatrix(db, { testId, limit = 400 } = {}) {
  const where = testId ? "WHERE r.test_id = ?" : "";
  return all(
    db,
    `SELECT s.step_id                 AS stepId,
            MAX(s.label)              AS label,
            r.test_id                 AS testId,
            MAX(r.test_name)          AS testName,
            COALESCE(r.browser, 'unknown') AS browser,
            COUNT(*)                  AS runs,
            SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM step_metrics s JOIN runs r ON r.id = s.run_id
     ${where}
     GROUP BY s.step_id, r.test_id, browser
     ORDER BY testName, stepId, browser
     LIMIT ?`,
    testId ? [testId, limit] : [limit],
  );
}

/** Past runs of the same test, for the cross-run half of triage: did this fail
 *  on every engine, on every dataset row, only when capture was on? */
export function siblingRuns(db, testId, { limit = 50, excludeRunId } = {}) {
  return all(
    db,
    `SELECT id, status, browser, speed, dataset_id, dataset_name, capture_ms,
            failed_step_id, error_signature, started_at, has_artifacts
     FROM runs
     WHERE test_id = ? AND id <> COALESCE(?, '')
     ORDER BY started_at DESC LIMIT ?`,
    [testId, excludeRunId ?? null, limit],
  );
}
