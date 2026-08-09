// Structured logger matching the Glaze SDK's logger surface:
//   logger.info(scope, message, meta?)
//
// Console in dev, plus an append-only file under userData/logs so the packaged
// app (no terminal attached) still leaves a trail. File writes are best-effort
// and never throw: a full disk must not take the recorder down with it.

import * as fs from "fs";
import * as path from "path";

import { app } from "electron";

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
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(text);
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
