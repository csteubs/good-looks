// The app's JSON stores, read and written from plain Node.
//
// These were module-private functions inside `server.mjs`, which is a 2,150-line
// file that BOOTS AN MCP SERVER ON IMPORT — so nothing else could call them. The
// CLI (docs/plans/test-runner-improvements.md §3.3) has to be a third caller of
// the same readers the MCP uses rather than a third set, for the reason
// `run-plan.mjs` records: the app's runner and this server's had already
// silently diverged in four ways by 2026-08-07, and `check:mcp-parity` exists to
// stop a third.
//
// A FACTORY OVER A MODULE OF FREE FUNCTIONS, because every one of these is
// bound to one `dataDir` and passing it to each call site would be a parameter
// nobody reads and everybody can get wrong. `server.mjs` destructures the result
// into the names it already used, so no call site there changed.
//
// Pure I/O over the app's files. No Electron, no `safeStorage`, no assumption
// that the app has ever run: `readJsonFile` answers the fallback for a file that
// is not there.

import { readJsonFile, writeJsonFile } from "./data-dir.mjs";
import { listRuns as listRunsFrom, saveRunRecord as saveRunRecordTo } from "./run-history.mjs";

/** Newest-first cap on `batch-history.json`, mirroring the app's
 *  batch-history-store. */
const MAX_BATCH_RECORDS = 50;

/**
 * The app's stores, bound to one data directory.
 *
 * @param {string} dataDir
 */
export function createStore(dataDir) {
  function listTests() {
    return readJsonFile(dataDir, "recorder/tests.json", []);
  }

  function listRuns() {
    return listRunsFrom(dataDir);
  }

  /** Bound to this process's data dir. The pruning rules live in
   *  `mcp/run-history.mjs` so they can be driven against a fixture — see that
   *  file's header for the drift that made it necessary. */
  function saveRunRecord(record, logText) {
    saveRunRecordTo(dataDir, record, logText);
  }

  function listBatches() {
    return readJsonFile(dataDir, "recorder/batch-history.json", []);
  }

  /** The user's CUSTOM failure reasons. Run records carry a reason ID; the
   *  built-ins live in shared/failure-reasons.mjs and this file holds the rest,
   *  which is what lets a rename in the app reach every historical label this
   *  server displays. */
  function readFailureReasons() {
    return readJsonFile(dataDir, "recorder/failure-reasons.json", []);
  }

  /**
   * Saved Routines. docs/ROUTINES.md.
   *
   * The file is an ENVELOPE, not a bare array — `routines.json` carries a version
   * and the one-time migration flag beside the list, so reading it as an array
   * would answer `undefined` and `list_routines` would report an empty library
   * for every user who has one.
   */
  function listRoutines() {
    const file = readJsonFile(dataDir, "recorder/routines.json", {});
    return Array.isArray(file?.routines) ? file.routines : [];
  }

  /** The app's global preferences. Read fresh per run rather than cached: this
   *  process outlives many app sessions, and a stale `defaultTestTimeoutMs` is
   *  exactly the kind of drift this file is being fixed for. */
  function readSettings() {
    return readJsonFile(dataDir, "recorder/recorder-settings.json", {});
  }

  /** The app's plaintext Shopify signature register — hosts and expiries, never a
   *  header value (those live in the .bin beside it, encrypted to the app).
   *
   *  Read so a run can SAY it went unsigned. Without this file the two states
   *  "nothing is configured" and "something is, and I can't read it" are the same
   *  silence from here, and a store that throttles the run turns into a test
   *  failure with nothing pointing at the cause. */
  function readSignatures() {
    const register = readJsonFile(dataDir, "recorder/shopify-signatures.json", {});
    return Array.isArray(register?.entries) ? register.entries : [];
  }

  /** The app's standing overlay rules.
   *
   *  Read for the same reason the signature register is: so a run can SAY what it
   *  did not do. This server writes no fixtures, so a rule that dismisses a
   *  consent banner in an app run does not fire here — and a run that fails on an
   *  element the banner is covering fails with nothing pointing at the cause.
   *
   *  Through `shared/overlay-rules.mjs` rather than a local copy of the matching
   *  rule. Both processes read this file, and a second spelling of "does this
   *  rule apply to this URL" is the drift that has already cost this repo three
   *  bugs — see the header of `mcp/data-dir.mjs`. */
  function readOverlayRules() {
    const rules = readJsonFile(dataDir, "recorder/overlay-rules.json", []);
    return Array.isArray(rules) ? rules : [];
  }

  /** Persist a batch in the SAME file and shape the app's batch-history-store
   *  uses, so a batch run from an MCP client shows up in the app's Batch view. */
  function saveBatchRecord(record) {
    const all = listBatches().filter((b) => b.batchId !== record.batchId);
    all.push(record);
    all.sort((a, b) => b.startedAt - a.startedAt);
    writeJsonFile(dataDir, "recorder/batch-history.json", all.slice(0, MAX_BATCH_RECORDS));
  }

  return {
    listTests,
    listRuns,
    saveRunRecord,
    listBatches,
    readFailureReasons,
    listRoutines,
    readSettings,
    readSignatures,
    readOverlayRules,
    saveBatchRecord,
  };
}
