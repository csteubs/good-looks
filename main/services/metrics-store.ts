// The metrics database: opening it, filling it, and rebuilding it.
//
// The impure half of Phase 2. The schema and the run→rows rollup are pure and
// live in shared/ so the MCP server can use the same ones; everything here
// touches the filesystem, the artifact store and node:sqlite, so it stays on
// the app's side of that boundary.
//
// THREE RULES, and every one of them is load-bearing:
//
//   1. NEVER FATAL. This is a derived cache of files that still exist. A
//      failure to open it, migrate it, or write to it must never fail a run,
//      block teardown, or surface as an error the user has to act on — it
//      degrades to "no metrics" and the app carries on exactly as before. Every
//      public method here swallows its own errors for that reason. `retention.ts`
//      already follows the same rule and for the same reason.
//   2. NEVER LOAD EAGERLY. `node:sqlite` is a builtin on the runtime this app
//      ships with, but a static import would throw at MODULE LOAD on a runtime
//      without it and take the whole backend down with it. It is imported
//      dynamically, once, inside a try.
//   3. ROLL UP BEFORE PRUNING. This is the entire point of the phase. Artifact
//      retention deletes per-step evidence at ten runs per test; the preflight
//      hook below distils a run into ~60 bytes of rows first. After it,
//      retention costs you pictures, not history.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import { artifactStore } from "./artifact-store.js";
import { healJournalStore } from "./heal-journal-store.js";
import { runHistoryStore } from "./run-history-store.js";
import {
  bind,
  CREATE_STATEMENTS,
  DROP_STATEMENTS,
  INSERT_HOST_HEALTH,
  INSERT_PAGE_HEALTH,
  INSERT_RUN,
  INSERT_STEP,
  HOST_HEALTH_COLUMNS,
  PAGE_HEALTH_COLUMNS,
  PRAGMAS,
  RUN_COLUMNS,
  SCHEMA_VERSION,
  STEP_COLUMNS,
} from "../../shared/metrics-schema.mjs";
import { lifetimeRunCounts, runEvidence, siblingRuns, stepHealth } from "../../shared/metrics-query.mjs";
import { rollupRun } from "../../shared/rollup.mjs";
import { TRIAGE_COHORT, triageRun } from "../../shared/triage.mjs";
import type { TriageResult } from "../../shared/triage.mjs";
import type { RunRecord } from "../recorder/types.js";

/** The minimal slice of node:sqlite's DatabaseSync this module uses. Declared
 *  rather than imported: the module is loaded dynamically (rule 2), so there is
 *  no static type to reach for. */
interface Db {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

let db: Db | null = null;
/** Set once the first open attempt has happened, successful or not, so a
 *  missing runtime feature is reported once rather than on every run. */
let attempted = false;

function dbPath(): string {
  return path.join(app.getPath("userData"), "recorder", "metrics.db");
}

/**
 * Open node:sqlite without its ExperimentalWarning reaching the log.
 *
 * SQLite is flagged experimental in Node 24 and warns on first construction.
 * The warning is true and irrelevant — this app ships with a pinned runtime, so
 * the feature cannot change underneath a user — and a warning printed on every
 * single launch is how a log stops being read. Suppressed narrowly (this exact
 * warning, only while opening) rather than by muting process warnings.
 */
async function openDatabase(file: string): Promise<Db> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (p: string) => Db;
  };
  const original = process.emitWarning;
  process.emitWarning = function (warning: unknown, ...rest: unknown[]): void {
    const text = String(warning);
    if (text.includes("SQLite is an experimental feature")) return;
    (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return new DatabaseSync(file);
  } finally {
    process.emitWarning = original;
  }
}

/** Current schema version recorded in the file, or -1 when it can't be read. */
function readVersion(handle: Db): number {
  try {
    const rows = handle.prepare("PRAGMA user_version").all() as { user_version?: number }[];
    return Number(rows[0]?.user_version ?? 0);
  } catch {
    return -1;
  }
}

/**
 * Bring the file to the current schema.
 *
 * There are no incremental migrations, on purpose. The database is a derived
 * shadow of JSON stores and artifacts that are all still on disk, so "migrate"
 * and "rebuild" produce identical results — and only one of them can be got
 * subtly wrong. Any version mismatch drops and replays.
 *
 * Returns whether the tables were (re)created, which is what tells the caller a
 * backfill is needed.
 */
function migrate(handle: Db): boolean {
  const version = readVersion(handle);
  const fresh = version !== SCHEMA_VERSION;
  if (fresh) {
    for (const sql of DROP_STATEMENTS) handle.exec(sql);
  }
  for (const sql of CREATE_STATEMENTS) handle.exec(sql);
  if (fresh) handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return fresh;
}

/** runId → the heals journalled against it.
 *
 *  Built ONCE per sweep and passed down. The journal is a single flat file with
 *  no per-run index, so asking it per run turns a backfill of 336 runs into 336
 *  reads and parses of the whole thing. */
function healIndex(): Map<string, { stepId: string }[]> {
  const out = new Map<string, { stepId: string }[]>();
  try {
    for (const entry of healJournalStore.listAll()) {
      if (!entry.runId) continue;
      const list = out.get(entry.runId);
      if (list) list.push(entry);
      else out.set(entry.runId, [entry]);
    }
  } catch (err) {
    // A heal journal that won't parse costs the `healed` column, not the sweep.
    logger.warn("metrics", "Could not index the heal journal", { err: String(err) });
  }
  return out;
}

/** Read everything one run left behind, and distil it into rows. */
function rowsFor(
  run: RunRecord,
  source: "app" | "mcp",
  heals: Map<string, { stepId: string }[]>,
) {
  let logText = "";
  try {
    logText = fs.readFileSync(run.logFile, "utf-8");
  } catch {
    // Pruned, or never written. The error signature is simply absent — which is
    // why it is computed at ingest and not left to be derived later.
  }
  return rollupRun({
    run: run as unknown as Record<string, unknown> & { id: string; testId: string },
    replay: artifactStore.readReplay(run.testId, run.id),
    manifest: artifactStore.readManifest(run.testId, run.id),
    // Redacted on the way out of the store, as everywhere else. Only counts are
    // taken from these, so redaction changes nothing here — but taking the
    // unredacted path "because it's only counts" is how the next field added
    // turns into a leak.
    logs: artifactStore.readLogs(run.testId, run.id),
    healFailures: artifactStore.readHealFailures(run.testId, run.id),
    heals: heals.get(run.id) ?? [],
    logText,
    source,
    // The per-page readings. Absent once retention has taken the run's
    // directory — which is why the host rows come from the record instead.
    siteHealth: artifactStore.readSiteHealth(run.testId, run.id),
  });
}

/** Write one run's rows. Caller owns error handling. */
function writeRows(handle: Db, rows: ReturnType<typeof rowsFor>): void {
  handle.prepare(INSERT_RUN).run(...bind(RUN_COLUMNS, rows.run as unknown as Record<string, unknown>));
  const stepStmt = handle.prepare(INSERT_STEP);
  for (const step of rows.steps) {
    stepStmt.run(...bind(STEP_COLUMNS, step as unknown as Record<string, unknown>));
  }
  const hostStmt = handle.prepare(INSERT_HOST_HEALTH);
  for (const host of rows.hosts) {
    hostStmt.run(...bind(HOST_HEALTH_COLUMNS, host as unknown as Record<string, unknown>));
  }
  const pageStmt = handle.prepare(INSERT_PAGE_HEALTH);
  for (const page of rows.pages) {
    pageStmt.run(...bind(PAGE_HEALTH_COLUMNS, page as unknown as Record<string, unknown>));
  }
}

export const metricsStore = {
  /**
   * Open the database and, if it was created or reset, fill it from history.
   *
   * Called once at startup. Everything after this point is synchronous, which
   * is what lets the prune preflight — reached from a sync code path — work at
   * all: `DatabaseSync` is synchronous by design.
   */
  async init(): Promise<void> {
    if (attempted) return;
    attempted = true;
    const file = dbPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const handle = await openDatabase(file);
      for (const pragma of PRAGMAS) handle.exec(pragma);
      const fresh = migrate(handle);
      db = handle;
      if (fresh) {
        const { runs, steps } = this.backfill();
        logger.info("metrics", "Built the metrics database from history", { runs, steps });
      }
      // THE ONE PLACE THIS DATABASE IS READ FOR SOMETHING OTHER THAN A VIEW.
      //
      // The run index is capped, and the counter that records what the cap
      // prunes could only start counting on the day it shipped: an app already
      // past the cap begins understating its own history by every run pruned
      // before then. Those runs left a row here and nothing deletes rows, so
      // this file is the only surviving evidence of them.
      //
      // It stays a SEED rather than a source. Reading the total from here on
      // every launch would make a derived cache the store of record for a
      // number that cannot be re-derived — and this table is dropped and
      // replayed FROM THE CAPPED INDEX whenever SCHEMA_VERSION moves, so that
      // total would silently fall back to the cap at the next schema change.
      // Seeded once, into a counter that is authoritative afterwards.
      this.seedRunHistoryFloor();
    } catch (err) {
      // A missing node:sqlite, an unwritable directory, a corrupt file. All the
      // same answer: no metrics, everything else works.
      db = null;
      logger.warn("metrics", "Metrics are unavailable this session", { err: String(err) });
    }
  },

  /** Whether metrics are being recorded. Everything reading the DB has to cope
   *  with `false` — it is the normal state on a runtime without node:sqlite. */
  get available(): boolean {
    return db !== null;
  },

  /**
   * Hand the run history whatever this database remembers of runs the cap has
   * already pruned. One-time; the store records that it ran.
   *
   * Non-throwing like everything else here (rule 1): a failed recovery leaves
   * the counter exactly where it was, which is the state the app shipped with.
   * Day buckets are converted from the query's local `YYYY-MM-DD` to local
   * midnight here, because the timestamp is the store's vocabulary and the date
   * string is SQLite's.
   */
  seedRunHistoryFloor(): void {
    if (!db) return;
    try {
      const lifetime = lifetimeRunCounts(db);
      runHistoryStore.adoptLifetimeFloor({
        runs: lifetime.runs,
        passed: lifetime.passed,
        failed: lifetime.failed,
        days: lifetime.days.map((d) => {
          const [y, m, day] = d.day.split("-").map(Number);
          return {
            dayStart: new Date(y, (m ?? 1) - 1, day ?? 1).getTime(),
            runs: d.runs,
            passed: d.passed,
            failed: d.failed,
          };
        }),
      });
    } catch (err) {
      logger.warn("metrics", "Could not recover pruned-run history", { err: String(err) });
    }
  },

  /**
   * Distil one finished run into rows.
   *
   * Best-effort and non-throwing: this is called from run teardown, where an
   * exception would turn a bookkeeping problem into a failed run.
   */
  ingest(runId: string, source: "app" | "mcp" = "app"): void {
    if (!db) return;
    try {
      const run = runHistoryStore.list().find((r) => r.id === runId);
      if (!run) return;
      writeRows(db, rowsFor(run, source, healIndex()));
    } catch (err) {
      logger.warn("metrics", "Could not record run metrics", { runId, err: String(err) });
    }
  },

  /**
   * Distil a run whose artifacts are ABOUT TO BE DELETED.
   *
   * The whole reason this phase exists. Registered as the artifact store's
   * prune preflight, so every retention sweep rolls a run up before removing
   * the evidence it was rolled up from. Idempotent — the rollup is a pure
   * function of the inputs and every row carries its own key — so a run already
   * ingested at completion is simply rewritten identically.
   */
  ingestBeforePrune(testId: string, runId: string): void {
    if (!db) return;
    try {
      const run = runHistoryStore.list().find((r) => r.id === runId && r.testId === testId);
      if (!run) return;
      writeRows(db, rowsFor(run, "app", healIndex()));
    } catch (err) {
      logger.warn("metrics", "Could not roll a run up before pruning", { runId, err: String(err) });
    }
  },

  /**
   * Fill the database from every run in history.
   *
   * A one-time sweep on first open, and the second half of `rebuild`. Runs that
   * lost their artifacts to retention still contribute a run-level row — status,
   * duration, browser, dataset, timings — which is strictly more than the
   * nothing they contribute today.
   */
  backfill(): { runs: number; steps: number } {
    if (!db) return { runs: 0, steps: 0 };
    let runs = 0;
    let steps = 0;
    try {
      const heals = healIndex();
      // One transaction: 336 runs is 336 inserts plus their steps, and
      // committing each separately turns a sub-second sweep into a slow one.
      db.exec("BEGIN");
      for (const run of runHistoryStore.list()) {
        try {
          const rows = rowsFor(run, "app", heals);
          writeRows(db, rows);
          runs++;
          steps += rows.steps.length;
        } catch (err) {
          // One unreadable run must not abandon the sweep.
          logger.warn("metrics", "Skipped a run during backfill", {
            runId: run.id,
            err: String(err),
          });
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      logger.warn("metrics", "Backfill failed", { err: String(err) });
    }
    return { runs, steps };
  },

  /**
   * Drop everything and replay from the JSON stores and surviving artifacts.
   *
   * What makes corruption a non-event: there is no state here that isn't
   * derived, so the recovery for any problem is to throw the file away.
   */
  rebuild(): { runs: number; steps: number } {
    if (!db) return { runs: 0, steps: 0 };
    try {
      for (const sql of DROP_STATEMENTS) db.exec(sql);
      for (const sql of CREATE_STATEMENTS) db.exec(sql);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } catch (err) {
      logger.warn("metrics", "Could not reset the metrics database", { err: String(err) });
      return { runs: 0, steps: 0 };
    }
    const result = this.backfill();
    logger.info("metrics", "Rebuilt the metrics database", result);
    return result;
  },

  /**
   * Classify one recorded run — site problem or runner problem.
   *
   * The reasoning is shared/triage.mjs; this is the impure gathering around it
   * (the evidence rows, the sibling window, the failing step's history), kept
   * HERE so the two callers cannot assemble it differently: the `runs:triage`
   * handler answers the run panel on demand, and the runner asks at run end to
   * auto-assign a failure reason. Null when metrics are unavailable or the run
   * has no rows — "no opinion", never an error (rule 1).
   */
  triage(runId: string): TriageResult | null {
    try {
      const evidence = runEvidence(db, runId);
      if (!evidence) return null;
      const { run, steps } = evidence;
      const failingStepId =
        run.failed_step_id ?? steps.find((s) => s.status === "failed")?.step_id;
      return triageRun({
        run,
        steps,
        // With the failing step's id, so each sibling carries THAT step's
        // outcome and a run that never executed it is not read as a pass.
        siblings: siblingRuns(db, run.test_id, {
          limit: TRIAGE_COHORT,
          excludeRunId: run.id,
          stepId: failingStepId,
        }),
        stepHistory:
          stepHealth(db, { testId: run.test_id }).find((s) => s.stepId === failingStepId) ?? null,
      });
    } catch (err) {
      logger.warn("metrics", "Could not triage a run", { runId, err: String(err) });
      return null;
    }
  },

  /** The open handle, for the curated queries in shared/metrics-query.mjs.
   *  Null when metrics are unavailable — every caller has to handle that. */
  handle(): Db | null {
    return db;
  },

  /** Test seam — closes and forgets the handle so a later init can reopen. */
  closeForTesting(): void {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
    attempted = false;
  },
};
