// Structured logger matching the Glaze SDK's logger surface:
//   logger.info(scope, message, meta?)
//
// Console in dev, plus an append-only file under userData/logs so the packaged
// app (no terminal attached) still leaves a trail. BOTH writes are best-effort
// and never throw: a full disk must not take the recorder down with it, and
// neither must a closed pipe — see stdio-guard.ts for why the console half
// needs two different guards to hold that promise.

import * as fs from "fs";
import * as path from "path";

import { app } from "electron";

import { guardStdio, writeSafely } from "./stdio-guard.js";

// Installed at module load, which is as early as anything in the main process
// runs: this file is imported by nearly everything. An `error` event on stdout
// that arrives before the guard is attached is an uncaught exception, so the
// call belongs here rather than behind an init function someone must remember.
guardStdio();

type Level = "debug" | "info" | "warn" | "error";

let stream: fs.WriteStream | null = null;
let streamFailed = false;

function line(level: Level, scope: string, message: string, meta?: unknown): string {
  const base = `${new Date().toISOString()} [${level}] [${scope}] ${message}`;
  if (meta === undefined) return base;
  try {
    return `${base} ${JSON.stringify(meta)}`;
  } catch {
    return `${base} [unserializable meta]`;
  }
}

function fileStream(): fs.WriteStream | null {
  if (stream || streamFailed) return stream;
  try {
    // Lazily resolved: getPath("userData") requires the app object to be
    // initialized, and the logger is imported by nearly everything.
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(path.join(dir, "main.log"), { flags: "a" });
    stream.on("error", () => {
      streamFailed = true;
      stream = null;
    });
  } catch {
    streamFailed = true;
  }
  return stream;
}

function log(level: Level, scope: string, message: string, meta?: unknown): void {
  const text = line(level, scope, message, meta);
  // BOTH writes are best-effort now. This one used to be bare, so a console
  // whose pipe had closed — the ordinary state once the terminal that launched
  // the app has gone — threw out of every logger call and put an "Uncaught
  // Exception: write EPIPE" dialog in front of the user. See stdio-guard.ts.
  writeSafely(
    level === "error" ? console.error : level === "warn" ? console.warn : console.log,
    text,
  );
  try {
    fileStream()?.write(text + "\n");
  } catch {
    /* best-effort */
  }
}

export const logger = {
  debug: (scope: string, message: string, meta?: unknown) => log("debug", scope, message, meta),
  info: (scope: string, message: string, meta?: unknown) => log("info", scope, message, meta),
  warn: (scope: string, message: string, meta?: unknown) => log("warn", scope, message, meta),
  error: (scope: string, message: string, meta?: unknown) => log("error", scope, message, meta),
};
