// The metrics database: what it holds, and why each column is in it.
//
// Pure (see the admission rule in run-pacing.mjs) — DDL text and row shapes, no
// connection and no filesystem. Opening the database is metrics-store.ts's job.
//
// WHAT THIS IS FOR. The app already collects, per run, everything needed to
// answer "is this the site's fault or the test's?" — per-step timing, network
// with status and latency, console, visual diff ratios, accessibility results,
// heal events, cross-browser and cross-dataset outcomes. It just collects them
// in five different files, none of which join, and then RETENTION DELETES THEM.
// Screenshots age out at ten runs per test; the evidence about what happened
// ages out with them.
//
// So this is a DERIVED SHADOW of those files: rebuildable from them at any
// time, ~60 bytes per step against ~1.5 MB per run of artifacts, and rolled up
// BEFORE pruning. After it, retention costs you pictures, not history.
//
// Because it is derived, three things follow, and they are what make the rest
// of the design cheap:
//   • Corruption is never fatal. Delete the file, rebuild, carry on.
//   • It must never block or fail a run. A metrics write that throws into run
//     teardown would trade real function for bookkeeping.
//   • A schema change needs no incremental migration. Bumping SCHEMA_VERSION
//     drops and replays, because the source of truth is still on disk.

/** Bump to change the schema. On open, a database at any other version is
 *  dropped and rebuilt from the JSON stores and surviving artifacts.
 *
 *  This is why there are no migration scripts: the DB is a cache of files that
 *  still exist, so "migrate" and "rebuild" produce identical results and only
 *  one of them can be got wrong. */
export const SCHEMA_VERSION = 1;

/**
 * One row per run.
 *
 * `has_artifacts` earns its place: without it, a run with no step rows is
 * ambiguous between "captured nothing, so there is no evidence" and "captured
 * and had nothing to report". Those must not read alike — the triage
 * classifier's `unknown` verdict depends on being able to say a run had almost
 * no signal rather than guessing from status alone.
 *
 * `test_timeout_ms` is stored per run rather than read back from the test,
 * because the test's value is the CURRENT one — see RunRecord.testTimeoutMs.
 *
 * There is deliberately NO `triage` / `triage_confidence` column. A verdict
 * frozen at the classifier version that wrote it goes stale silently: improve
 * the classifier and old rows keep the old answer, so a trend mixes verdicts
 * from several generations with nothing saying so. Triage is pure and cheap —
 * it is computed on read from these columns and the artifacts, which also means
 * improving it improves every historical run at once.
 *
 * `console_dropped` / `network_dropped` are the second half of the same honesty
 * that `has_artifacts` provides, and they were added after measuring a real run
 * rather than from the design. The capture fixture keeps the first 100 and last
 * 400 entries of each log — OVERALL, not per step — so on a busy site the
 * middle is discarded wholesale: one run here retained 500 network entries and
 * dropped 1861, leaving three of its nine steps with no requests recorded at
 * all. Without these counts, "no 5xx on the failing step" is indistinguishable
 * from "that step's requests were thrown away", and the first reads as evidence
 * the site was healthy.
 */
export const RUNS_DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  test_id           TEXT NOT NULL,
  test_name         TEXT NOT NULL,
  url               TEXT,
  status            TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'run',
  started_at        INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL,
  browser           TEXT,
  speed             TEXT,
  headless          INTEGER,
  batch_id          TEXT,
  dataset_id        TEXT,
  dataset_name      TEXT,
  healed_steps      INTEGER NOT NULL DEFAULT 0,
  heal_failed_steps INTEGER NOT NULL DEFAULT 0,
  a11y_ms           INTEGER,
  a11y_checks       INTEGER,
  a11y_new_steps    INTEGER,
  capture_ms        INTEGER,
  shot_count        INTEGER,
  test_timeout_ms   INTEGER,
  failed_step_id    TEXT,
  error_signature   TEXT,
  source            TEXT,
  has_artifacts     INTEGER NOT NULL DEFAULT 0,
  console_dropped   INTEGER NOT NULL DEFAULT 0,
  network_dropped   INTEGER NOT NULL DEFAULT 0,
  replay_of_run_id  TEXT
)`;

/**
 * One row per step per run.
 *
 * Keyed on `(run_id, step_index)` with a secondary index on `step_id`, because
 * step ids are stable across runs while indices shift the moment a test is
 * edited — the same reasoning run-comparison already applies when matching
 * steps.
 *
 * Three columns exist as SPLITS of what would otherwise be one, because the
 * halves carry opposite evidence and merging them destroys the signal:
 *
 *   • `console_page_errors` vs `console_errors` — a `pageerror` is the page's
 *     own JavaScript throwing, which is strong evidence the SITE broke. A
 *     `console.error` is a log line; plenty of healthy sites emit them on every
 *     load. Counting them together makes the strong signal unusable.
 *   • `net_worst_api_status` vs `net_worst_status` — a 4xx on a navigation is
 *     often the page under test (a 404 page is a legitimate thing to test). A
 *     4xx on a non-navigational request means an API contract broke. Only the
 *     second is evidence.
 *   • `heal_failed` vs `healed` — a step that healed says the locator went
 *     stale (the test's fault). A step that could NOT be healed says the
 *     element is gone under every locator (the site's). Opposite conclusions
 *     from the same subsystem.
 */
export const STEP_METRICS_DDL = `
CREATE TABLE IF NOT EXISTS step_metrics (
  run_id               TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index           INTEGER NOT NULL,
  step_id              TEXT NOT NULL,
  action_index         INTEGER,
  label                TEXT,
  type                 TEXT,
  status               TEXT,
  ms                   INTEGER,
  diff_state           TEXT,
  diff_ratio           REAL,
  a11y_violations      INTEGER,
  a11y_new             INTEGER,
  healed               INTEGER NOT NULL DEFAULT 0,
  heal_failed          TEXT,
  net_requests         INTEGER,
  net_failures         INTEGER,
  net_worst_status     INTEGER,
  net_worst_api_status INTEGER,
  net_total_ms         INTEGER,
  console_errors       INTEGER,
  console_page_errors  INTEGER,
  PRIMARY KEY (run_id, step_index)
)`;

export const INDEX_DDL = [
  "CREATE INDEX IF NOT EXISTS idx_step_by_step ON step_metrics(step_id, run_id)",
  "CREATE INDEX IF NOT EXISTS idx_runs_by_test ON runs(test_id, started_at)",
  "CREATE INDEX IF NOT EXISTS idx_runs_by_batch ON runs(batch_id)",
];

/** Every statement needed to create an empty database, in order. */
export const CREATE_STATEMENTS = [RUNS_DDL, STEP_METRICS_DDL, ...INDEX_DDL];

/** Dropped in dependency order — step_metrics references runs. */
export const DROP_STATEMENTS = ["DROP TABLE IF EXISTS step_metrics", "DROP TABLE IF EXISTS runs"];

/** Column order for the runs insert. Named once so the statement, the row
 *  builder and the rebuild cannot disagree about it — a positional insert with
 *  two columns transposed writes cleanly and reads as garbage forever. */
export const RUN_COLUMNS = [
  "id",
  "test_id",
  "test_name",
  "url",
  "status",
  "kind",
  "started_at",
  "duration_ms",
  "browser",
  "speed",
  "headless",
  "batch_id",
  "dataset_id",
  "dataset_name",
  "healed_steps",
  "heal_failed_steps",
  "a11y_ms",
  "a11y_checks",
  "a11y_new_steps",
  "capture_ms",
  "shot_count",
  "test_timeout_ms",
  "failed_step_id",
  "error_signature",
  "source",
  "has_artifacts",
  "console_dropped",
  "network_dropped",
  "replay_of_run_id",
];

export const STEP_COLUMNS = [
  "run_id",
  "step_index",
  "step_id",
  "action_index",
  "label",
  "type",
  "status",
  "ms",
  "diff_state",
  "diff_ratio",
  "a11y_violations",
  "a11y_new",
  "healed",
  "heal_failed",
  "net_requests",
  "net_failures",
  "net_worst_status",
  "net_worst_api_status",
  "net_total_ms",
  "console_errors",
  "console_page_errors",
];

/** `INSERT OR REPLACE` so ingesting the same run twice yields one row set
 *  rather than a constraint error — the rollup has to be idempotent, because
 *  the backfill and the write-through path can both reach the same run. */
function upsert(table, columns) {
  return (
    `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")})`
  );
}

export const INSERT_RUN = upsert("runs", RUN_COLUMNS);
export const INSERT_STEP = upsert("step_metrics", STEP_COLUMNS);

/** Turn a row object into the positional array its insert expects. Booleans
 *  become 0/1 and `undefined` becomes null, because SQLite binds neither. */
export function bind(columns, row) {
  return columns.map((c) => {
    const v = row[c];
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  });
}
