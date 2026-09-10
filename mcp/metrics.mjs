// The MCP server's half of the metrics database.
//
// The third of the plan's three ingest points. The other two are inside the app
// (run completion and the prune preflight); this one exists because a run
// started from here is a real run — it lands in run-history.json and in the
// app's Stats — and a suite whose agent-driven runs were missing from the trend
// would answer "is this getting worse?" with half the evidence.
//
// Both processes write the SAME file, which is safe for two reasons that have
// to hold together: WAL plus a busy timeout (see PRAGMAS) means neither blocks
// the other for long, and every write is idempotent — the rollup is a pure
// function of the run's own artifacts and every row carries its own key — so
// the app re-ingesting a run this process already wrote produces the same rows.
//
// NEVER FATAL, exactly as on the app side. A missing node:sqlite, an unwritable
// file, a locked database: all degrade to "this run wasn't recorded in the
// metrics" and the run itself is unaffected. An MCP tool that failed because
// bookkeeping failed would be worse than no bookkeeping.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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
} from "../shared/metrics-schema.mjs";
import { rollupRun } from "../shared/rollup.mjs";
import { readManifest, readReplay, readRunLogs, readSiteHealth } from "./artifacts.mjs";

/** Opened lazily and kept for the process's life — this server is long-lived
 *  and a per-call open would pay the WAL handshake every time. Keyed by the
 *  library it was opened for: one process serves one library, but the CLI's
 *  tests drive `ingest` at several throwaway libraries in one process, and a
 *  latch that ignored the directory handed the second one the first's file. */
let db;
let attempted = false;
let openedFor = null;

/** Mirrors metrics-store.ts. SQLite is flagged experimental in Node 24 and
 *  warns on first construction; on THIS side the warning would go to stderr,
 *  which for a stdio MCP server is the channel a client reads diagnostics from.
 *  Suppressed narrowly, and only while opening. */
async function openDatabase(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    return original.call(process, warning, ...rest);
  };
  try {
    return new DatabaseSync(file);
  } finally {
    process.emitWarning = original;
  }
}

/**
 * Open the metrics database, or return null if it can't be had.
 *
 * The schema is created if missing but the file is NOT backfilled from here:
 * that sweep reads every run's artifacts and belongs to whichever process is in
 * a position to do it once, at startup, rather than to a tool call an agent is
 * waiting on. A version mismatch drops and recreates, same as the app — the
 * data is derived either way, and the app's next start refills it.
 */
async function open(dataDir) {
  if (attempted && openedFor === dataDir) return db;
  attempted = true;
  openedFor = dataDir;
  try {
    const file = path.join(dataDir, "recorder", "metrics.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = await openDatabase(file);
    for (const pragma of PRAGMAS) handle.exec(pragma);
    const version = Number(handle.prepare("PRAGMA user_version").all()[0]?.user_version ?? 0);
    if (version !== SCHEMA_VERSION) {
      for (const sql of DROP_STATEMENTS) handle.exec(sql);
    }
    for (const sql of CREATE_STATEMENTS) handle.exec(sql);
    if (version !== SCHEMA_VERSION) handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db = handle;
  } catch {
    db = null;
  }
  return db;
}

/**
 * Record one finished MCP run.
 *
 * An MCP run currently produces no capture artifacts (no fixture loads here —
 * see the `fixtures` field on every run response), so this writes a run-level
 * row and no step rows. `has_artifacts` is what says so: without it a query
 * could not tell this run from one that captured and had nothing to report.
 */
export async function recordRun(dataDir, run, heals, logText) {
  try {
    const handle = await open(dataDir);
    if (!handle) return false;
    const rows = rollupRun({
      run,
      replay: readReplay(dataDir, run.testId, run.id),
      manifest: readManifest(dataDir, run.testId, run.id),
      logs: readRunLogs(dataDir, run.testId, run.id),
      healFailures: [],
      heals: (heals ?? []).filter((h) => h?.runId === run.id),
      logText,
      source: "mcp",
      siteHealth: readSiteHealth(dataDir, run.testId, run.id),
    });
    handle.prepare(INSERT_RUN).run(...bind(RUN_COLUMNS, rows.run));
    const stepStmt = handle.prepare(INSERT_STEP);
    for (const step of rows.steps) stepStmt.run(...bind(STEP_COLUMNS, step));
    const hostStmt = handle.prepare(INSERT_HOST_HEALTH);
    for (const host of rows.hosts) hostStmt.run(...bind(HOST_HEALTH_COLUMNS, host));
    const pageStmt = handle.prepare(INSERT_PAGE_HEALTH);
    for (const page of rows.pages) pageStmt.run(...bind(PAGE_HEALTH_COLUMNS, page));
    return true;
  } catch {
    // Bookkeeping. The run already happened and is already in run-history.json.
    return false;
  }
}

/** The open handle for the read tools, or null. Never opens one — a read tool
 *  should not be the thing that creates the database. */
export function handle() {
  return db ?? null;
}

/**
 * A handle for reading, opening an EXISTING database if one is on disk.
 *
 * The distinction `handle()` draws is worth keeping and is not quite the one it
 * enforced. "A read tool should not CREATE the database" is right: an empty
 * schema written by a triage call would then be backfilled by nobody, and every
 * later read would answer "no data" against a file that exists. But refusing to
 * open a database the app has already built and filled is a different rule, and
 * it made every read tool useless in a fresh MCP process — which is every MCP
 * process that has not itself run a test.
 *
 * So: `existsSync` first, and no CREATE_STATEMENTS. A missing file is an
 * ordinary "no metrics yet" answer. A version mismatch is left alone rather
 * than dropped — dropping is a write, this side is reading, and the app rebuilds
 * on its next start. The curated queries already tolerate a schema they don't
 * recognise by answering empty.
 */
export async function readHandle(dataDir) {
  if (db) return db;
  try {
    const file = path.join(dataDir, "recorder", "metrics.db");
    if (!fs.existsSync(file)) return null;
    const handle = await openDatabase(file);
    for (const pragma of PRAGMAS) handle.exec(pragma);
    const version = Number(handle.prepare("PRAGMA user_version").all()[0]?.user_version ?? 0);
    if (version !== SCHEMA_VERSION) {
      handle.close();
      return null;
    }
    db = handle;
    attempted = true;
    return db;
  } catch {
    return null;
  }
}
