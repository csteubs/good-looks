// Reading a run's captured artifacts from a standalone process.
//
// Mirrors the LAYOUT main/services/artifact-store.ts owns:
//
//   <dataDir>/recorder/artifacts/<testId>/<runId>/<stepIndex>.png
//   <dataDir>/recorder/artifacts/<testId>/<runId>/manifest.json
//   <dataDir>/recorder/artifacts/<testId>/<runId>/replay.json
//   <dataDir>/recorder/artifacts/<testId>/<runId>/console.json | network.json
//   <dataDir>/recorder/artifacts/<testId>/baseline/            (never a run)
//
// Read-only, on purpose. The MCP's remit is read + run + analyze, never
// mutation — nothing here writes, prunes, or seeds a baseline, and the pruning
// rules stay the app's business so two processes can't disagree about what
// retention means.
//
// Kept out of server.mjs so it can be exercised without starting a server.

import fs from "node:fs";
import path from "node:path";

/** Subdirectories of a test's artifact dir that are NOT runs. Mirrors
 *  RESERVED_DIRS in artifact-store.ts — listing `baseline/` as a run would
 *  offer a pinned-baseline directory as though it were a run to report on. */
const RESERVED_DIRS = new Set(["baseline"]);

export function artifactsRoot(dataDir) {
  return path.join(dataDir, "recorder", "artifacts");
}

export function runDir(dataDir, testId, runId) {
  return path.join(artifactsRoot(dataDir), testId, runId);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Missing is the common case — a run that captured nothing has no run dir
    // at all, and retention deletes older ones. Not an error worth throwing.
    return null;
  }
}

/** The canonical per-run model: per-step outcome, visual diff, a11y result. */
export function readReplay(dataDir, testId, runId) {
  return readJson(path.join(runDir(dataDir, testId, runId), "replay.json"));
}

/** The capture fixture's own record: per-step action, target, and the wall-clock
 *  ms each screenshot cost. */
export function readManifest(dataDir, testId, runId) {
  return readJson(path.join(runDir(dataDir, testId, runId), "manifest.json"));
}

/**
 * Console + network as recorded, or null when this run recorded neither.
 *
 * Both files are `{ testId, runId, dropped, entries[] }` — an envelope, not a
 * bare array. `dropped` and `headersFiltered` are carried through rather than
 * discarded: a log truncated by the per-run cap has to SAY it was truncated,
 * or "no request matched" and "the request was past the cap" read identically.
 *
 * Matches artifact-store.readLogs field for field, minus its redaction — which
 * this process cannot do, and which is why `get_run_logs` withholds these
 * whenever any test in the library declares a secret. See that tool.
 */
export function readRunLogs(dataDir, testId, runId) {
  const dir = runDir(dataDir, testId, runId);
  const consoleFile = readJson(path.join(dir, "console.json"));
  const networkFile = readJson(path.join(dir, "network.json"));
  if (!consoleFile && !networkFile) return null;
  return {
    console: consoleFile?.entries ?? [],
    network: networkFile?.entries ?? [],
    consoleDropped: consoleFile?.dropped ?? 0,
    networkDropped: networkFile?.dropped ?? 0,
    // Only an explicit `false` means every header was recorded — an older file
    // without the field was written under the allowlist.
    headersFiltered: networkFile?.headersFiltered !== false,
  };
}

/** Run ids with an artifact directory for this test, newest first. */
export function listRunDirs(dataDir, testId) {
  const dir = path.join(artifactsRoot(dataDir), testId);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((e) => e.isDirectory() && !RESERVED_DIRS.has(e.name))
    .map((e) => {
      let at = 0;
      try {
        at = fs.statSync(path.join(dir, e.name)).mtimeMs;
      } catch {
        /* unreadable — sorts last rather than dropping the run */
      }
      return { runId: e.name, at };
    })
    .sort((a, b) => b.at - a.at)
    .map((r) => r.runId);
}
