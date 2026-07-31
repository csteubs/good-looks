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
import { getScriptsDir, testStore } from "./test-store.js";
import { parseSpec } from "./spec-parser.js";

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

/** Extensions we'll copy as relative-import siblings of an imported spec. */
const SIBLING_EXT = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".json"];
/** Cap the total sibling bytes we'll copy for one import to avoid runaway copies. */
const MAX_SIBLING_BYTES = 5 * 1024 * 1024;

/** Matches a relative import/export/re-export specifier: `./…` or `../…`. */
const RELATIVE_SPEC_RE =
  /(?:import|export|require)\b[^;]*?['"`](\.\.?\/[^'"`]+)['"`]/g;

/** Resolve a relative import specifier to a real file, trying common extensions
 *  and an `index` when the specifier is a bare directory. Returns null if not found. */
function resolveSibling(dir: string, spec: string): string | null {
  const base = path.resolve(dir, spec);
  // Exact path, or with a tried extension, or as a directory's index file.
  const tries = [base, ...SIBLING_EXT.map((e) => base + e)];
  for (const t of tries) {
    try {
      if (fs.statSync(t).isFile()) return t;
    } catch {
      /* not found — keep trying */
    }
  }
  for (const e of SIBLING_EXT) {
    const idx = path.join(base, "index" + e);
    try {
      if (fs.statSync(idx).isFile()) return idx;
    } catch {
      /* not found */
    }
  }
  return null;
}

/** Copy an imported spec's relative-import siblings into the scripts dir so the
 *  spec can run standalone (the original folder/git checkout won't be present
 *  at run time). Recurses into each copied sibling for its own relative imports.
 *  Returns the list of copied destination paths (excluding the spec itself). */
function copyRelativeImports(
  specSource: string,
  specDir: string,
  scriptsDir: string,
): string[] {
  const copied: string[] = [];
  const seen = new Set<string>(); // by resolved source path
  let totalBytes = 0;

  const queue: { src: string; rel: string }[] = [];
  const enqueue = (spec: string, fromDir: string) => {
    const resolved = resolveSibling(fromDir, spec);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    queue.push({ src: resolved, rel: path.relative(specDir, resolved) });
  };

  // Seed from the spec's own relative imports.
  for (const m of specSource.matchAll(RELATIVE_SPEC_RE)) {
    enqueue(m[1], specDir);
  }

  while (queue.length > 0) {
    const { src, rel } = queue.shift()!;
    let content: string;
    try {
      content = fs.readFileSync(src, "utf-8");
    } catch {
      continue;
    }
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_SIBLING_BYTES) {
      logger.warn("import", "Sibling copy byte cap reached; stopping", { rel });
      break;
    }
    const dest = path.join(scriptsDir, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied.push(dest);
    } catch (err) {
      logger.warn("import", "Could not copy sibling module", { rel, err: String(err) });
      continue;
    }
    // Recurse: this sibling may itself import other local modules.
    for (const m of content.matchAll(RELATIVE_SPEC_RE)) {
      enqueue(m[1], path.dirname(src));
    }
  }
  return copied;
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
  const scriptsDir = getScriptsDir();
  for (const f of found) {
    const id = randomUUID();
    const scriptPath = testStore.writeScript(id, f.content);
    const now = Date.now();
    // An imported spec may reference sibling modules (`./fixtures.js`,
    // `./helpers.js`, …) that live next to it in the source tree. The spec
    // runs from the scripts dir, where those siblings don't exist — so copy
    // them in (preserving relative paths) at import time, while the source
    // folder / git checkout is still on disk.
    const specDir = path.dirname(f.filePath);
    const siblings = copyRelativeImports(f.content, specDir, scriptsDir);
    // Analyze the file and translate its test() bodies into the app's Step[]
    // model so the imported test shows up in the Steps view. When nothing
    // could be parsed, leave steps empty and fall back to a script-only
    // import (scriptEdited stays true so the Script view is the source of
    // truth). When steps were parsed we still keep scriptEdited true: the
    // verbatim imported file is the runnable artifact and must not be
    // regenerated from the (lossy) parsed steps on a rename.
    const steps = parseSpec(f.content);
    const record: TestRecord = {
      id,
      name: extractName(f.content, f.filePath),
      url: extractUrl(f.content),
      createdAt: now,
      updatedAt: now,
      steps,
      scriptPath,
      scriptEdited: true,
      sourceDir: specDir,
    };
    testStore.save(record);
    created.push(record);
    if (siblings.length > 0) {
      logger.info("import", "Copied sibling modules for spec", {
        id,
        count: siblings.length,
      });
    }
  }
  logger.info("import", "Imported Playwright tests", {
    count: created.length,
    withSteps: created.filter((c) => c.steps.length > 0).length,
  });
  return { imported: created.length, names: created.map((c) => c.name), ids: created.map((c) => c.id) };
}

/** Re-copy an imported spec's relative-import siblings from its stored
 *  `sourceDir` into the scripts dir. Used to repair runs that fail because a
 *  sibling module (e.g. `./helpers.js`) is missing — for records imported
 *  before sibling-copy existed, or if the scripts dir was reset. Returns the
 *  list of copied paths. */
export function repairImports(id: string): string[] {
  const rec = testStore.get(id);
  if (!rec) throw new Error("Test not found: " + id);
  if (!rec.sourceDir) {
    throw new Error("This test has no recorded source folder, so its sibling modules can't be re-copied.");
  }
  const source = testStore.readScript(id);
  return copyRelativeImports(source, rec.sourceDir, getScriptsDir());
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

  /** Re-copy an imported spec's sibling modules from its recorded source folder. */
  repairImports(id: string): string[] {
    return repairImports(id);
  },
};
