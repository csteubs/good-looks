// `good-looks ingest DIR` — carry a CI run's results back into this library (R12).
//
// ── The problem it solves ──────────────────────────────────────────────────
// A container's library dies with the container. A suite that runs forty times
// a week in CI therefore produces forty run histories nobody ever sees, while
// Stability, the flake verdict and step health — the surfaces that make the app
// worth opening — are built from the handful of runs somebody triggered by
// hand. The plan calls this "the item that stops CI making the product worse",
// and that is the right framing: without it, wiring up CI actively dilutes the
// evidence the app reasons from.
//
// ── Where the safety lives ─────────────────────────────────────────────────
// In `shared/run-ingest.mjs`, not here. This file does the disk work; the gate
// decides what a foreign record may say. The one rule this file must not break
// is that it derives BOTH paths itself — where a log is read from, and where it
// is written to — from the validated id, never from the `logFile` the record
// arrived with. See that module's header for what carrying it would cost.

import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";

import { randomUUID } from "node:crypto";

import { listRuns, saveRunRecords } from "../mcp/run-history.mjs";
import { recordRun } from "../mcp/metrics.mjs";
import { isIngestableRunId, planIngest } from "../shared/run-ingest.mjs";
import { RUN_HEALS_FILE } from "../shared/heal-artifacts.mjs";
import { healIngestKey, planHealIngest } from "../shared/heal-ingest.mjs";
import { SITE_HEALTH_FILE } from "../shared/site-health.mjs";
import { EXIT } from "./exit.mjs";

/** Where the app keeps its heal journal, relative to `recorder/`. Named here
 *  rather than imported because the store that owns it is compiled TypeScript
 *  behind an Electron shim this process cannot load — the same reason
 *  `run-history.mjs` exists at all. */
const HEAL_JOURNAL_FILE = "heal-journal.json";

/** Cap per test, matching `heal-journal-store.ts`. A CI suite ingesting week
 *  after week is exactly the writer that would grow this file without bound,
 *  and the app's own cap is applied on ITS writes, not on this one. */
const MAX_HEALS_PER_TEST = 200;

/**
 * The two shapes an unpacked artifact turns up in.
 *
 * Being liberal here is not sloppiness. A CI artifact is a zip somebody made a
 * decision about the root of, so half the time you get the library directory and
 * half the time you get its `recorder/` — and the failure mode of guessing one
 * is "found no runs", which reads as "there was nothing to ingest" rather than
 * "you pointed at the wrong level". The command says which one it used.
 *
 * @param {string} dir
 * @returns {{recorderDir: string, historyFile: string} | null}
 */
function locateLibrary(dir) {
  const candidates = [path.join(dir, "recorder"), dir];
  for (const recorderDir of candidates) {
    const historyFile = path.join(recorderDir, "run-history.json");
    if (fs.existsSync(historyFile)) return { recorderDir, historyFile };
  }
  return null;
}

/**
 * Read a JSON array, or null when it is not one.
 *
 * @param {string} file
 * @returns {unknown[] | null}
 */
function readRecords(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Promote the heal evidence beside the runs just ingested into this library's
 * journal.
 *
 * WHY THIS IS A SEPARATE PASS, and why it runs only over runs that were
 * actually ingested: a heal entry names a run, and every reader joins the two
 * (the Heals view shows the run, the propagation engine reads the run's
 * outcome to decide whether the heal is trustworthy evidence). A heal whose
 * run this library refused — or already had — would be an entry pointing at
 * nothing, which is worse than an absent one.
 *
 * Best-effort by contract. The runs are already stored by the time this is
 * called; a heal file that is missing, unreadable or full of nonsense must
 * cost the user nothing but the heals it could not read.
 *
 * @param {{recorderDir: string, localRecorder: string, records: Record<string, unknown>[]}} io
 * @returns {{ingested: number, duplicate: number, unusable: number, runs: number}}
 */
function ingestHeals({ recorderDir, localRecorder, records }) {
  const out = { ingested: 0, duplicate: 0, unusable: 0, runs: 0 };
  const journalFile = path.join(localRecorder, HEAL_JOURNAL_FILE);

  /** @type {Record<string, unknown>[]} */
  let journal = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(journalFile, "utf-8"));
    if (Array.isArray(parsed)) journal = parsed;
  } catch {
    // No journal yet, or an unreadable one. Either way this pass adds to what
    // it can read — it must never truncate a file it failed to parse, which
    // would trade a CI heal for every heal the user already had.
    if (fs.existsSync(journalFile)) return out;
  }

  const keys = new Set(journal.map((e) => healIngestKey(/** @type {never} */ (e))));
  /** @type {Record<string, unknown>[]} */
  const added = [];

  for (const record of records) {
    const testId = String(record.testId ?? "");
    const runId = String(record.id ?? "");
    if (!testId || !runId) continue;
    // Derived from validated ids, never from a path the record carried —
    // the `logFile` rule, applied to the artifact directory.
    const file = path.join(recorderDir, "artifacts", testId, runId, RUN_HEALS_FILE);
    let envelope;
    try {
      envelope = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const entries = Array.isArray(envelope?.entries) ? envelope.entries : [];
    if (entries.length === 0) continue;
    out.runs++;
    const plan = planHealIngest(keys, entries, { testId, runId });
    out.duplicate += plan.duplicate;
    out.unusable += plan.unusable;
    for (const entry of plan.fresh) {
      keys.add(healIngestKey(entry));
      // The id is minted HERE, like the log path is: a foreign id can collide
      // with a local entry's, and every accept and revert in the app is keyed
      // by it.
      added.push({ ...entry, id: randomUUID() });
    }
  }

  if (added.length === 0) return out;

  // Cap per test — SETTLED entries first, oldest first, and never a pending
  // one. That is `heal-journal-store.ts`'s own rule and it is not a detail: a
  // pending heal is the only stored copy of the locator its step used to have,
  // so dropping one to make room for a CI import would destroy the undo for a
  // change already made to a test. Dropping by age alone (the first draft
  // here) would have done exactly that.
  const merged = [...journal, ...added];
  const byTest = new Map();
  for (const entry of merged) {
    const testId = String(entry.testId ?? "");
    const list = byTest.get(testId) ?? [];
    list.push(entry);
    byTest.set(testId, list);
  }
  const dropped = new Set();
  for (const list of byTest.values()) {
    if (list.length <= MAX_HEALS_PER_TEST) continue;
    list
      .filter((e) => e.status === "accepted" || e.status === "reverted")
      .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0))
      .slice(0, list.length - MAX_HEALS_PER_TEST)
      .forEach((e) => dropped.add(e));
  }

  try {
    fs.mkdirSync(localRecorder, { recursive: true });
    fs.writeFileSync(
      journalFile,
      JSON.stringify(
        merged.filter((e) => !dropped.has(e)),
        null,
        2,
      ),
      "utf-8",
    );
    out.ingested = added.length;
  } catch {
    // A journal this process could not write is a library that is exactly as
    // it was. The runs are already in; say nothing was carried rather than
    // claiming heals that are not there.
  }
  return out;
}

/**
 * Carry each ingested run's Site Health artifact (`site-health.json`) into
 * this library's artifact directory for that run.
 *
 * The per-host SUMMARY already travelled on the record, through the gate; this
 * is the per-page evidence the detail view's page table and the filed issue's
 * screenshot join read. Copied — never referenced — into a directory named
 * from ids the gate accepted, the `logFile` rule again: BOTH segments are
 * checked with the same token rule, because the test id is a path segment
 * here too and a `..` in it would write outside the artifacts tree.
 *
 * Only this one file. A run directory from another machine can hold
 * screenshots, console and network logs; those stay where they are, and the
 * app's readers already render a run without them.
 *
 * @returns {number} how many were carried
 */
function ingestSiteHealth({ recorderDir, localRecorder, records }) {
  let carried = 0;
  for (const record of records) {
    const testId = String(record.testId ?? "");
    const runId = String(record.id ?? "");
    if (!isIngestableRunId(testId) || !isIngestableRunId(runId)) continue;
    const from = path.join(recorderDir, "artifacts", testId, runId, SITE_HEALTH_FILE);
    if (!fs.existsSync(from)) continue;
    try {
      const dest = path.join(localRecorder, "artifacts", testId, runId);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(from, path.join(dest, SITE_HEALTH_FILE));
      carried++;
    } catch {
      // The record is in and its summary with it; only the page table is
      // poorer for this run.
    }
  }
  return carried;
}

/**
 * Carry the runs in `dir` into the library at `dataDir`.
 *
 * Async since Site Health: every ingested run is also rolled into metrics.db
 * here, through the same `recordRun` the MCP's own runs go through. Before
 * that, an ingested run reached the database only if the APP happened to
 * rebuild it — so the CI runs that measure a site most often were the ones
 * the Site Health series never saw.
 *
 * @param {{dir: string, dryRun: boolean, json: boolean}} options
 * @param {{out: (s: string) => void, err: (s: string) => void, dataDir: string, now?: () => number}} deps
 * @returns {Promise<number>} an exit code
 */
export async function ingestCommand({ dir, dryRun, json }, { out, err, dataDir, now = Date.now }) {
  const source = path.resolve(dir);

  if (!fs.existsSync(source)) {
    err(`No such directory: ${source}`);
    return EXIT.CANNOT_START;
  }

  // Ingesting a library into itself is every record a duplicate and no harm
  // done — which is exactly why it is worth refusing by name. "0 new, 412
  // already present" is a true sentence that leaves you no wiser about why.
  const localRecorder = path.resolve(dataDir, "recorder");
  const found = locateLibrary(source);
  if (found && path.resolve(found.recorderDir) === localRecorder) {
    err(`That is this library's own directory (${localRecorder}).`);
    err("Point ingest at the results from ANOTHER machine — a downloaded CI artifact.");
    return EXIT.CANNOT_START;
  }

  if (!found) {
    err(`No run history under ${source}.`);
    err("Expected recorder/run-history.json there, or run-history.json directly.");
    // 3 rather than 2. A selector matching nothing is a real answer about a
    // real library; this is "I could not find a library at all", which is the
    // same class as a missing store and wants the same one thing looked at.
    return EXIT.CANNOT_START;
  }

  const incoming = readRecords(found.historyFile);
  if (incoming === null) {
    err(`${found.historyFile} is not a readable run history.`);
    return EXIT.CANNOT_START;
  }

  const localIds = listRuns(dataDir).map((r) => r.id);
  const { fresh, duplicate, unusable } = planIngest(localIds, incoming);

  // Log text is read HERE, from a path derived from the id — never from the
  // record's own `logFile`, which is an absolute path on the machine that
  // produced the run and would be a read of whatever happens to be there.
  const sourceLogs = path.join(found.recorderDir, "logs");
  const localLogs = path.join(localRecorder, "logs");
  const stamp = now();
  let withLogs = 0;

  const entries = fresh.map((record) => {
    const from = path.join(sourceLogs, `${record.id}.log`);
    let logText = "";
    try {
      logText = fs.readFileSync(from, "utf-8");
      withLogs++;
    } catch {
      // A record whose log did not travel is still worth having: the outcome,
      // the timing and the commit are what the flake verdict reads. The store
      // already renders a missing log as "no longer available".
      logText = "(This run was ingested from another machine; its log did not travel with it.)";
    }
    return {
      record: {
        ...record,
        logFile: path.join(localLogs, `${record.id}.log`),
        logBytes: Buffer.byteLength(logText, "utf-8"),
        ingestedAt: stamp,
      },
      logText,
    };
  });

  if (!dryRun && entries.length > 0) saveRunRecords(dataDir, entries);

  // The heals those runs performed, promoted into this library's journal —
  // which is what puts a CI heal in front of the user for review AND into the
  // donor corpus the propagation engine reads. Only for runs actually stored:
  // a heal pointing at a run this library does not have is an entry pointing
  // at nothing. Never on a dry run, which must leave the library untouched.
  const heals =
    !dryRun && entries.length > 0
      ? ingestHeals({
          recorderDir: found.recorderDir,
          localRecorder,
          records: entries.map((e) => e.record),
        })
      : { ingested: 0, duplicate: 0, unusable: 0, runs: 0 };

  // The per-page Site Health evidence, and then the metrics rows for every
  // run just stored — after the heals, so the rollup sees the journal entries
  // the ingest just added. Best-effort by contract: the runs are already in.
  let siteHealth = 0;
  let metrics = 0;
  if (!dryRun && entries.length > 0) {
    siteHealth = ingestSiteHealth({
      recorderDir: found.recorderDir,
      localRecorder,
      records: entries.map((e) => e.record),
    });
    let journal = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(localRecorder, HEAL_JOURNAL_FILE), "utf-8"));
      if (Array.isArray(parsed)) journal = parsed;
    } catch {
      journal = [];
    }
    for (const entry of entries) {
      if (await recordRun(dataDir, entry.record, journal, entry.logText)) metrics++;
    }
  }

  const summary = {
    ingested: entries.length,
    alreadyPresent: duplicate,
    unusable,
    withLogs,
    heals: heals.ingested,
    healsFromRuns: heals.runs,
    siteHealth,
    metrics,
    from: found.recorderDir,
    into: dataDir,
    dryRun,
  };

  if (json) {
    out(JSON.stringify(summary, null, 2));
  } else {
    out(`${dryRun ? "Would ingest" : "Ingested"} ${entries.length} run(s) from ${found.recorderDir}`);
    if (duplicate > 0) out(`  ${duplicate} already in this library — skipped`);
    if (entries.length > 0 && withLogs < entries.length) {
      out(`  ${entries.length - withLogs} without a log file beside them`);
    }
    if (unusable > 0) {
      // Named rather than folded into "skipped". A record this library refused
      // is a different event from one it already had, and only the first is a
      // reason to look at what produced the directory.
      out(`  ${unusable} could not be read and were refused`);
    }
    if (heals.ingested > 0) {
      // Said out loud because it changes what the app shows: these land in the
      // Heals view awaiting review, and feed proposals for sibling tests.
      out(
        `  ${heals.ingested} Auto-Heal event(s) from ${heals.runs} run(s) — in the Heals view now`,
      );
    }
    if (siteHealth > 0) {
      out(`  ${siteHealth} Site Health reading set(s) — in the Site Health view now`);
    }
    if (entries.length === 0 && duplicate > 0) {
      out("Nothing new — this directory has been ingested already.");
    }
  }

  return EXIT.PASSED;
}

/** Usage, printed for `--help` and beside a refusal. */
export const INGEST_USAGE = `Usage: good-looks ingest <dir> [--dry-run] [--json]

Carry the runs a CI job recorded back into this library, so Stability, the flake
verdict and step health count them. Point it at an unpacked artifact — either
the library directory or its recorder/ directory.

A container's library dies with the container: without this, a suite running
forty times a week in CI leaves no trace in the app at all.

Options:
  --dry-run    report what would be ingested and write nothing
  --json       print the summary as JSON

Runs are matched by id, so ingesting the same directory twice is safe and
ingests nothing the second time.

Auto-Heal events those runs recorded are carried too, into the Heals view for
review and into the evidence the app proposes cross-test fixes from. They are
matched per run and step, so they dedupe the same way.
`;

/** @param {string} message */
const fail = (message) => ({ ok: /** @type {const} */ (false), error: message });

/**
 * Parse `good-looks ingest <dir> [--dry-run] [--json]`.
 *
 * The directory is POSITIONAL and has no default, for the reason `install`'s
 * browser does: there is no sensible guess. "Ingest whatever you assumed I
 * meant" writes into the user's real run history.
 *
 * @param {string[]} argv arguments AFTER the subcommand
 * @returns {{ok: true, options: {dir: string, dryRun: boolean, json: boolean}} | {ok: false, error: string} | {ok: "help"}}
 */
export function parseIngestArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { ok: "help" };

  let dir;
  let dryRun = false;
  let json = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    // An unknown flag is a REFUSAL, as everywhere in this CLI: a misspelt
    // option must not quietly become "ingest with defaults" against a real
    // store.
    if (arg.startsWith("-")) return fail(`Unknown option "${arg}".`);
    if (dir !== undefined) {
      return fail(`Ingest one directory at a time — got "${dir}" and "${arg}".`);
    }
    dir = arg;
  }
  if (dir === undefined) return fail("Which directory? Pass the unpacked CI artifact.");
  return { ok: true, options: { dir, dryRun, json } };
}
