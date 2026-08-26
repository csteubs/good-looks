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

import { listRuns, saveRunRecords } from "../mcp/run-history.mjs";
import { planIngest } from "../shared/run-ingest.mjs";
import { EXIT } from "./exit.mjs";

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
 * Carry the runs in `dir` into the library at `dataDir`.
 *
 * @param {{dir: string, dryRun: boolean, json: boolean}} options
 * @param {{out: (s: string) => void, err: (s: string) => void, dataDir: string, now?: () => number}} deps
 * @returns {number} an exit code
 */
export function ingestCommand({ dir, dryRun, json }, { out, err, dataDir, now = Date.now }) {
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

  const summary = {
    ingested: entries.length,
    alreadyPresent: duplicate,
    unusable,
    withLogs,
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
