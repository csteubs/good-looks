// Debug screenshots: capture the app's own windows, on demand or on request.
//
// The problem this solves is specific. Claude Code (and the MCP server it talks
// to) can read this project's files, run its tests and read its logs — but it
// cannot see the app. Every UI change so far has been described rather than
// shown, and "NOT yet verified in the running app" appears in the project notes
// more often than anything else.
//
// Two ways in, deliberately:
//
//   • A keyboard shortcut, for when YOU see something wrong and want to hand it
//     over. Nothing is running until you press it.
//   • A request file, so an MCP client can ask for a fresh capture and get one
//     back in the same breath. That needs the app to be listening, which costs
//     a directory watcher — so it is behind a Settings toggle, default OFF, and
//     the watcher only exists while the toggle is on.
//
// The request/response protocol is plain files in a directory both processes
// already agree on (the same userData dir the MCP server resolves for run
// history). No new socket, no port, nothing to leave running.

import * as fs from "fs";
import * as path from "path";

import { app, BrowserWindow, logger } from "@shell/backend";

import { recorderSettingsStore } from "./recorder-settings-store.js";

/** Directory under userData/recorder where shots and protocol files live.
 *  MIRRORED in mcp/debug-shots.mjs — see the drift test in
 *  main/services/debug-capture.test.ts. */
export const DEBUG_DIRNAME = "debug-shots";
export const REQUEST_FILE = "request.json";
/** How many capture SESSIONS to keep. Each session is one press or request and
 *  may hold several PNGs (one per window), so this is deliberately small —
 *  these are debugging aids with a lifetime of minutes, not artifacts. */
export const MAX_SESSIONS = 10;
/** Longest edge of a written PNG. A retina window is ~3000px wide and base64s
 *  to several MB; nothing about reading a UI screenshot needs that, and an
 *  oversized payload is worse than a slightly soft one. */
export const MAX_IMAGE_WIDTH = 1400;

export interface DebugShot {
  /** PNG filename within the debug directory */
  file: string;
  /** the window's title at capture time, for telling them apart */
  window: string;
  width: number;
  height: number;
}

export interface CaptureSession {
  id: string;
  at: number;
  /** what asked for it — useful when reading a directory after the fact */
  reason: "shortcut" | "request" | "manual";
  shots: DebugShot[];
  /** set when the capture produced nothing, with the reason */
  error?: string;
}

/**
 * The in-app capture shortcut.
 *
 * Global (fires without app focus) so you can grab the app while looking at
 * something else — which is most of the point. Four modifiers because a global
 * shortcut wins system-wide: a friendlier combination like ⌘⇧G would take "Go
 * to folder" away from Finder for as long as this app is open.
 */
export const DEBUG_CAPTURE_ACCELERATOR = "CommandOrControl+Alt+Shift+S";

export function debugDir(): string {
  return path.join(app.getPath("userData"), "recorder", DEBUG_DIRNAME);
}

/** Ids are filenames, so they're generated in the shape `isValidRequestId`
 *  accepts rather than trusting a uuid to stay filename-safe forever. */
export function newCaptureId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Response filename for a request id. Pure, and mirrored MCP-side. */
export function responseFileFor(id: string): string {
  return `response-${id}.json`;
}

/** PNG filename for one window of one session. Pure, and mirrored MCP-side.
 *  The index keeps two windows with identical titles from colliding. */
export function shotFileFor(id: string, index: number): string {
  return `${id}-${index}.png`;
}

/** Reject anything that isn't a plain id, since these become filenames. A
 *  request file is written by another process, so its contents are input. */
export function isValidRequestId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function ensureDir(): string {
  const dir = debugDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Keep only the newest sessions.
 *
 * Grouped by session id rather than by file age: a session's PNGs and its
 * response JSON belong together, and deleting a PNG whose response still
 * references it would leave the MCP side reading a manifest pointing at
 * nothing.
 */
export function pruneSessions(dir: string, keep: number = MAX_SESSIONS): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const sessions = new Map<string, { files: string[]; mtime: number }>();
  for (const name of entries) {
    if (name === REQUEST_FILE) continue;
    const m = name.match(/^(?:response-)?([A-Za-z0-9_-]+?)(?:-\d+)?\.(png|json)$/);
    if (!m) continue;
    const id = m[1];
    const full = path.join(dir, name);
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const s = sessions.get(id) ?? { files: [], mtime: 0 };
    s.files.push(full);
    s.mtime = Math.max(s.mtime, mtime);
    sessions.set(id, s);
  }
  const ordered = [...sessions.entries()].sort((a, b) => b[1].mtime - a[1].mtime);
  let removed = 0;
  for (const [, s] of ordered.slice(keep)) {
    for (const f of s.files) {
      try {
        fs.rmSync(f, { force: true });
        removed++;
      } catch {
        /* best-effort */
      }
    }
  }
  return removed;
}

/**
 * Capture every open app window.
 *
 * All of them rather than the focused one: a UI bug is often the relationship
 * between two windows — the trainer and the main list, say — and `capturePage`
 * works on a window that's behind another, so there's no reason to make the
 * user arrange them first.
 *
 * Never throws. This is a debugging aid; failing to take a picture must not
 * take anything else down with it.
 */
export async function captureWindows(
  id: string,
  reason: CaptureSession["reason"],
): Promise<CaptureSession> {
  const session: CaptureSession = { id, at: Date.now(), reason, shots: [] };
  let dir: string;
  try {
    dir = ensureDir();
  } catch (err) {
    session.error = `Could not create the debug directory: ${String(err)}`;
    return session;
  }

  let windows: BrowserWindow[] = [];
  try {
    windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  } catch (err) {
    session.error = `Could not enumerate windows: ${String(err)}`;
    return session;
  }
  if (windows.length === 0) {
    session.error = "The app has no open windows.";
    return session;
  }

  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    let title = `window ${i + 1}`;
    try {
      title = win.getTitle() || title;
    } catch {
      /* a title is a nicety */
    }
    try {
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) continue;
      const size = image.getSize();
      // Downscale wide captures rather than writing a multi-megabyte PNG that
      // has to be base64'd across a protocol boundary.
      //
      // `resize` is ASYNC here — Electron's is synchronous, and assuming parity
      // gives you a Promise written to disk as a PNG with no error anywhere.
      const scaled =
        size.width > MAX_IMAGE_WIDTH
          ? await image.resize({ width: MAX_IMAGE_WIDTH, quality: "good" })
          : image;
      const finalSize = scaled.getSize();
      const file = shotFileFor(id, i);
      fs.writeFileSync(path.join(dir, file), scaled.toPNG());
      session.shots.push({ file, window: title, width: finalSize.width, height: finalSize.height });
    } catch (err) {
      logger.warn("debug-capture", "Could not capture a window", {
        window: title,
        err: String(err),
      });
    }
  }

  if (session.shots.length === 0 && !session.error) {
    session.error = "Every window failed to capture.";
  }
  pruneSessions(dir);
  logger.info("debug-capture", "Captured app windows", {
    id,
    reason,
    shots: session.shots.length,
  });
  return session;
}

/** Capture and write the response file a waiting MCP client is polling for. */
async function serveRequest(id: string): Promise<void> {
  const session = await captureWindows(id, "request");
  try {
    const dir = ensureDir();
    // Response LAST, after the PNGs are on disk: the reader treats the response
    // file's existence as "the images are ready", so writing it first would
    // race a client into reading half-written files.
    fs.writeFileSync(
      path.join(dir, responseFileFor(id)),
      JSON.stringify(session, null, 2),
      "utf-8",
    );
  } catch (err) {
    logger.warn("debug-capture", "Could not write a capture response", { id, err: String(err) });
  }
}

let watcher: fs.FSWatcher | null = null;
/** Request ids already served, so a watcher firing twice for one write (which
 *  fs.watch does routinely) doesn't capture twice. */
const served = new Set<string>();
let serving = false;

/** Read and consume a pending request, if there is a valid one. */
function takeRequest(dir: string): string | null {
  const file = path.join(dir, REQUEST_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let id: unknown;
  try {
    id = (JSON.parse(raw) as { id?: unknown }).id;
  } catch {
    // A partially-written file — the watcher will fire again when it's done.
    return null;
  }
  if (!isValidRequestId(id) || served.has(id)) return null;
  served.add(id);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the served set is the real guard */
  }
  return id;
}

/**
 * Start listening for capture requests.
 *
 * Only called when the Settings toggle is on. `fs.watch` on one small directory
 * is cheap, but "cheap" is not "free", and a debugging aid has no business
 * running for people who aren't debugging.
 */
export function startRequestWatcher(): void {
  if (watcher) return;
  let dir: string;
  try {
    dir = ensureDir();
  } catch (err) {
    logger.warn("debug-capture", "Could not start the request watcher", { err: String(err) });
    return;
  }
  // Serve anything left behind while the app was closed, so a request that
  // arrived first doesn't sit unanswered until the next one.
  const pending = takeRequest(dir);
  if (pending) void serveRequest(pending);

  try {
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename && filename !== REQUEST_FILE) return;
      if (serving) return;
      const id = takeRequest(dir);
      if (!id) return;
      serving = true;
      void serveRequest(id).finally(() => {
        serving = false;
      });
    });
    logger.info("debug-capture", "Listening for capture requests", { dir });
  } catch (err) {
    logger.warn("debug-capture", "Could not watch the debug directory", { err: String(err) });
  }
}

export function stopRequestWatcher(): void {
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    /* ignore */
  }
  watcher = null;
  logger.info("debug-capture", "Stopped listening for capture requests");
}

/** Bring the watcher into line with the current setting. Called at startup and
 *  whenever the setting changes, so the toggle takes effect immediately rather
 *  than at the next launch. */
export function syncRequestWatcher(): void {
  if (recorderSettingsStore.get().debugScreenshots) startRequestWatcher();
  else stopRequestWatcher();
}
