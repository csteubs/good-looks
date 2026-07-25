// Import existing Playwright test files into the library — either from a local
// folder (native directory picker) or by cloning a git repository. Each matched
// spec file becomes a TestRecord whose script is the file's own contents. These
// are imported scripts, not recordings, so they carry no steps and are flagged
// scriptEdited (never regenerated / clobbered by a rename).

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { randomUUID } from "crypto";

import { dialog, logger } from "@glaze/core/backend";

import type { TestRecord } from "../recorder/types.js";
import { testStore } from "./test-store.js";

const execFileAsync = promisify(execFile);

/** Playwright / common test file naming conventions. */
const TEST_FILE_RE = /\.(spec|test)\.(ts|mts|cts|js|mjs|cjs)$/i;
/** Directories that never contain source tests worth importing. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "playwright-report",
  "test-results",
]);
const MAX_FILES = 500;
const MAX_DEPTH = 12;
const CLONE_TIMEOUT_MS = 120_000;

export interface ImportResult {
  imported: number;
  names: string[];
  ids: string[];
}

interface FoundTest {
  filePath: string;
  content: string;
}

function scanDir(root: string): FoundTest[] {
  const found: FoundTest[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
        try {
          found.push({ filePath: full, content: fs.readFileSync(full, "utf-8") });
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  }

  walk(root, 0);
  return found;
}

/** Best-effort test URL from the first `page.goto("…")` in the file. */
function extractUrl(content: string): string {
  const m = content.match(/\.goto\(\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1] : "";
}

/** Prefer the first `test("title", …)` name, else the file's base name. */
function extractName(content: string, filePath: string): string {
  const m = content.match(/\btest(?:\.\w+)?\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (m && m[1].trim()) return m[1].trim();
  return path.basename(filePath).replace(TEST_FILE_RE, "");
}

function importFound(found: FoundTest[]): ImportResult {
  const created: TestRecord[] = [];
  for (const f of found) {
    const id = randomUUID();
    const scriptPath = testStore.writeScript(id, f.content);
    const now = Date.now();
    const record: TestRecord = {
      id,
      name: extractName(f.content, f.filePath),
      url: extractUrl(f.content),
      createdAt: now,
      updatedAt: now,
      steps: [],
      scriptPath,
      scriptEdited: true,
    };
    testStore.save(record);
    created.push(record);
  }
  logger.info("import", "Imported Playwright tests", { count: created.length });
  return { imported: created.length, names: created.map((c) => c.name), ids: created.map((c) => c.id) };
}

export const importService = {
  /** Open a native directory picker, scan it, and import any test files found. */
  async importFromFiles(): Promise<ImportResult> {
    const res = await dialog.showOpenDialog({
      title: "Select a folder of Playwright tests",
      properties: ["openDirectory"],
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { imported: 0, names: [], ids: [] };
    }
    const found = scanDir(res.filePaths[0]);
    if (found.length === 0) {
      throw new Error("No Playwright test files (*.spec.ts / *.test.ts) were found in that folder.");
    }
    return importFound(found);
  },

  /** Shallow-clone a git repository to a temp dir, import its tests, clean up. */
  async importFromGit(url: string): Promise<ImportResult> {
    const clean = (url ?? "").trim();
    if (!clean) throw new Error("A git repository URL is required.");
    if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(clean)) {
      throw new Error("Enter a valid git URL (https://, git@, ssh:// or git://).");
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pw-import-"));
    try {
      // execFile does not spawn a shell, so the URL cannot inject extra args.
      await execFileAsync("git", ["clone", "--depth", "1", clean, tmp], {
        timeout: CLONE_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      const e = err as { code?: string; stderr?: string; killed?: boolean };
      if (e.code === "ENOENT") {
        throw new Error("git is not installed or not on PATH. Install Xcode Command Line Tools or Git, then try again.");
      }
      if (e.killed) {
        throw new Error("Cloning the repository timed out. Check the URL and your connection.");
      }
      const detail = (e.stderr || "").trim().split("\n").pop() || String(err);
      throw new Error("Failed to clone repository: " + detail);
    }

    try {
      const found = scanDir(tmp);
      if (found.length === 0) {
        throw new Error("No Playwright test files (*.spec.ts / *.test.ts) were found in that repository.");
      }
      return importFound(found);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  },
};
