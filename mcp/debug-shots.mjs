// The MCP half of the debug-screenshot protocol.
//
// Mirrors main/services/debug-capture.ts. Both processes agree on one
// directory under the app's userData and a request/response file pair — no
// socket, no port, nothing left running when neither side is active.
//
// Kept in its own module (rather than inline in server.mjs) so the protocol and
// the selection logic can be tested without starting a server, the same way
// select-tests.mjs is.
//
// EVERY constant below is duplicated from the TypeScript side. A drift there
// produces no error on either side — the app writes files the client never
// looks for, and the client waits for a response that will never appear — so
// main/services/debug-capture.test.ts compares the two implementations
// directly.

import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers";

export const DEBUG_DIRNAME = "debug-shots";
export const REQUEST_FILE = "request.json";

/** How long to wait for the app to answer a capture request.
 *
 *  Generous, because the app has to render and encode one PNG per open window,
 *  and a slow answer is much better than a spurious "the app isn't running". */
export const REQUEST_TIMEOUT_MS = 15_000;
export const POLL_INTERVAL_MS = 150;

export function debugDir(dataDir) {
  return path.join(dataDir, "recorder", DEBUG_DIRNAME);
}

/** Mirror of `responseFileFor` in main/services/debug-capture.ts. */
export function responseFileFor(id) {
  return `response-${id}.json`;
}

/** Mirror of `shotFileFor` in main/services/debug-capture.ts. */
export function shotFileFor(id, index) {
  return `${id}-${index}.png`;
}

/** Mirror of `isValidRequestId`. Ids become filenames on both sides. */
export function isValidRequestId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** Mirror of `newCaptureId`. */
export function newCaptureId() {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Read every capture session on disk, newest first.
 *
 * Sessions written by a REQUEST have a response file. Sessions written by the
 * in-app shortcut have only PNGs, so those are reconstructed from the filenames
 * — otherwise a screenshot the user took by hand would be invisible here, which
 * is the commonest way one gets taken.
 */
export function listSessions(dataDir) {
  const dir = debugDir(dataDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const byId = new Map();
  // Which ids came from a response file. Tracked separately from `byId`,
  // because "this session already has an entry" and "this session has an
  // authoritative record" are different questions — conflating them made the
  // SECOND png of a shortcut capture look like one that was already described,
  // so a multi-window capture surfaced exactly one window.
  const fromResponse = new Set();

  // Responses first, so the PNG pass below can tell which sessions they cover
  // regardless of the order readdir happened to return.
  for (const name of entries) {
    const responseMatch = name.match(/^response-([A-Za-z0-9_-]+)\.json$/);
    if (!responseMatch) continue;
    try {
      const session = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (session && typeof session.id === "string") {
        byId.set(session.id, { ...session, shots: session.shots ?? [] });
        fromResponse.add(session.id);
      }
    } catch {
      // A half-written response — the PNG scan below still picks it up.
    }
  }

  for (const name of entries) {
    const shotMatch = name.match(/^([A-Za-z0-9_-]+?)-(\d+)\.png$/);
    if (!shotMatch) continue;
    const [, id, index] = shotMatch;
    if (fromResponse.has(id)) continue; // the response file is the better record
    let at = 0;
    try {
      at = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    const existing = byId.get(id) ?? { id, at, reason: "shortcut", shots: [] };
    existing.at = Math.max(existing.at, at);
    existing.shots.push({ file: name, window: `window ${Number(index) + 1}` });
    byId.set(id, existing);
  }

  return [...byId.values()]
    .map((s) => ({ ...s, shots: [...s.shots].sort((a, b) => a.file.localeCompare(b.file)) }))
    .sort((a, b) => b.at - a.at);
}

/** Read one session's PNGs as base64, ready for an MCP image content block. */
export function readShots(dataDir, session, maxShots = 4) {
  const dir = debugDir(dataDir);
  const out = [];
  for (const shot of session.shots.slice(0, maxShots)) {
    try {
      out.push({
        window: shot.window,
        width: shot.width,
        height: shot.height,
        base64: fs.readFileSync(path.join(dir, shot.file)).toString("base64"),
      });
    } catch {
      // A pruned file. Skipping is right: a missing image is not an error
      // worth failing the whole call over.
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the app for a fresh capture and wait for it.
 *
 * Returns `{ ok: false, reason }` rather than throwing, because the two ways
 * this fails are both ordinary and both need a specific explanation: the app
 * isn't running, or it is but the Debug screenshots toggle is off. "Timed out"
 * alone would send someone looking in the wrong place.
 */
export async function requestCapture(dataDir, timeoutMs = REQUEST_TIMEOUT_MS) {
  const dir = debugDir(dataDir);
  const id = newCaptureId();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, REQUEST_FILE),
      JSON.stringify({ id, at: Date.now() }),
      "utf8",
    );
  } catch (err) {
    return { ok: false, reason: `Could not write a capture request: ${String(err)}` };
  }

  const responsePath = path.join(dir, responseFileFor(id));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const session = JSON.parse(fs.readFileSync(responsePath, "utf8"));
      if (session && session.id === id) return { ok: true, session };
    } catch {
      // Not there yet, or still being written.
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Clean up so a stale request isn't served by a later launch, long after
  // whoever asked has stopped caring.
  try {
    fs.rmSync(path.join(dir, REQUEST_FILE), { force: true });
  } catch {
    /* best-effort */
  }
  return {
    ok: false,
    reason:
      "The app didn't answer. Either it isn't running, or Debug screenshots is off in " +
      "Settings — the app only listens for capture requests while that's enabled. You can " +
      "also press the capture shortcut in the app yourself, then use get_screenshot.",
  };
}
