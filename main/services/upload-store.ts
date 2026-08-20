// Staged files for `upload` steps. Picking a file COPIES it into
// scripts/uploads/<testId>/ and the step stores that relative path — so the
// test still runs when the original file moves, and the spec's
// setInputFiles(...) resolves against the scripts dir the runner already
// uses as cwd.
//
// Two rules, both security-shaped even though the file is user-picked:
//
// - **The stored name is OURS, not the picker's.** The original basename is
//   flattened to a safe alphabet (and capped) before it becomes part of a
//   path that lands inside generated source. A file legitimately named
//   `report..v2.csv` must not be able to spell a traversal, and a name full
//   of quotes must not fight q()'s escaping unnecessarily.
//
// - **Every delete is bounded by the uploads root, on resolved paths.** The
//   remove hook derives the directory from the test id and re-checks it the
//   way test-store's imported-sandbox delete does — a recursive delete must
//   never trust a stored string.

import * as fs from "fs";
import * as path from "path";

import { dialog } from "@shell/backend";

import { getScriptsDir } from "./test-store.js";

/** Copy caps: a fixture the test types into a form, not an archive drop. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const SAFE_NAME_RE = /[^A-Za-z0-9._-]+/g;

export function uploadsRootDir(): string {
  return path.join(getScriptsDir(), "uploads");
}

function uploadDirFor(testId: string): string {
  // Test ids are UUID-shaped, but this path is about to be created and
  // recursively deleted — flatten anything else out rather than trusting it.
  // Stricter than the filename alphabet: no dots (an id never has one, and a
  // dotted segment is how "..-.." style residue would make the returned
  // relPath fail the emission guard the stage exists to satisfy), and a
  // leading alphanumeric so the guard's starts-alnum rule holds.
  const safe = (testId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "test");
  const dir = path.resolve(uploadsRootDir(), safe);
  const root = path.resolve(uploadsRootDir());
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error("Upload directory escapes the uploads root.");
  }
  return dir;
}

/** The safe stored basename for a picked file: original extension kept,
 *  hostile characters flattened, length capped, deduped by suffix. */
function storedNameFor(dir: string, original: string): string {
  const base = path.basename(original).replace(SAFE_NAME_RE, "_").slice(0, 80) || "file";
  // A leading dot would make the copy invisible in Finder and look deleted.
  let name = base.replace(/^\.+/, "") || "file";
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) {
    const ext = path.extname(name);
    name = name.slice(0, name.length - ext.length) + "-" + n + ext;
    n++;
  }
  return name;
}

export interface StageUploadResult {
  canceled?: boolean;
  /** the step's `value`: scripts-dir-relative, always uploads/<id>/<name> */
  relPath?: string;
  name?: string;
  problem?: string;
}

/** Native picker → copy into the test's upload dir → the step's relative path. */
export async function stageUploadFile(testId: string): Promise<StageUploadResult> {
  const picked = await dialog.showOpenDialog({
    title: "Choose a file for the upload step",
    properties: ["openFile"],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
  const source = picked.filePaths[0];
  const size = fs.statSync(source).size;
  if (size > MAX_UPLOAD_BYTES) {
    return { problem: "The file is over 25 MB — upload steps stage a copy, and that is past the cap." };
  }
  const dir = uploadDirFor(testId);
  fs.mkdirSync(dir, { recursive: true });
  const name = storedNameFor(dir, source);
  fs.copyFileSync(source, path.join(dir, name));
  return { relPath: "uploads/" + path.basename(dir) + "/" + name, name };
}
