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

import { dialog, logger } from "@shell/backend";

import type { TestRecord } from "../recorder/types.js";
import { getScriptsDir, testStore } from "./test-store.js";
import { parseSpec } from "./spec-parser.js";
import {
  firstNavigationUrl,
  readProjectConfig,
  treeNeedsBaseUrl,
  type ImportedProjectConfig,
} from "./imported-config.js";

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
  /** Tests that navigate relatively and have no base URL to resolve against —
   *  every one of them fails on its first `goto` until somebody supplies one.
   *  Named at import time because the alternative is finding out from a
   *  Playwright protocol error that mentions neither the config nor the URL. */
  needsBaseUrl: string[];
  /** Features found in the source project's config that this app does not
   *  reproduce (a `webServer`, a `globalSetup`, a saved `storageState`). Said
   *  once, at the moment the user is looking, rather than discovered later as
   *  an inexplicable failure. */
  unsupported: string[];
}

/** Empty result, so callers that return early agree on the shape. */
function emptyResult(): ImportResult {
  return { imported: 0, names: [], ids: [], needsBaseUrl: [], unsupported: [] };
}

interface FoundTest {
  filePath: string;
  content: string;
  /** Root of the project this file was scanned from. Every file an imported
   *  spec is allowed to pull in must live under it — see `copyRelativeImports`,
   *  where it is the containment boundary rather than a convenience. */
  root: string;
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
export function resolveSibling(dir: string, spec: string): string | null {
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

/** Directory an imported test owns outright: its spec, its siblings, nothing
 *  else. Named by test id, so two imports of the same project can't collide
 *  and deleting one can't take the other's files with it. */
export function importedSandboxDir(id: string): string {
  return path.join(getScriptsDir(), "imported", id);
}

/** True when `child` is `parent` itself or sits underneath it.
 *
 *  Compares resolved paths and requires a separator at the boundary, so
 *  `/a/scripts-evil` is not treated as living inside `/a/scripts`. */
export function isInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

/** Resolve a path through any symlinks, or null if it doesn't resolve.
 *
 *  `resolveSibling` proves a path is a FILE via `statSync`, which follows
 *  symlinks — and `copyFileSync` then copies what the link points AT. So a
 *  repo shipping `helpers.js -> ~/.ssh/id_rsa` would have that file's contents
 *  copied into the app's scripts dir at import time, before anything is run.
 *  Containment has to be judged on the real path, not the link's. */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Copy an imported spec's relative-import siblings so the spec can run
 * standalone — the original folder or git checkout won't be there at run time.
 * Recurses into each copied sibling for its own relative imports. Returns the
 * destination paths copied.
 *
 * TWO boundaries, and both are load-bearing:
 *
 *   • `projectRoot` bounds what may be READ. A specifier is just text in a file
 *     the importer controls, and `path.resolve` walks `..` as far as it is
 *     told, so `import "../../../../../../../evil.js"` resolved to any file on
 *     the machine. A spec importing outside its own project cannot be made
 *     standalone anyway, so refusing is the honest behaviour, not a compromise.
 *
 *   • `destRoot` bounds what may be WRITTEN. Destinations used to be built as
 *     `join(scriptsDir, relative(specDir, resolved))`, and a `rel` starting
 *     with `..` walked straight back out — the deeper the spec sat in the
 *     importer's own tree, the further out it reached, up to and past the
 *     filesystem root. Importing a repository, without running a single test,
 *     could drop attacker-controlled content at an attacker-chosen absolute
 *     path (`~/Library/LaunchAgents/…` being the obvious one) and create the
 *     directories to get there.
 *
 * The containment assert is kept even though paths are now derived from
 * `projectRoot` and so should never escape. Layout logic drifts; an assert
 * doesn't.
 */
function copyRelativeImports(
  specSource: string,
  specDir: string,
  destRoot: string,
  projectRoot: string,
): string[] {
  const copied: string[] = [];
  const seen = new Set<string>(); // by real source path
  let totalBytes = 0;

  // Compare real path against REAL root. Sources are resolved through symlinks
  // to judge them honestly, and on macOS the project root routinely contains a
  // symlinked segment of its own — /var is a link to /private/var, so anything
  // under a temp dir resolves to a path that shares no prefix with the root as
  // it was handed in. Judged against the unresolved root, every legitimate
  // sibling looks like an escape and nothing gets copied at all.
  const realRoot = realOrNull(projectRoot) ?? path.resolve(projectRoot);

  const queue: { src: string; rel: string }[] = [];
  const enqueue = (spec: string, fromDir: string) => {
    const resolved = resolveSibling(fromDir, spec);
    if (!resolved) return;
    const real = realOrNull(resolved);
    if (!real || seen.has(real)) return;
    if (!isInside(realRoot, real)) {
      logger.warn("import", "Refused a sibling outside the imported project", { spec });
      return;
    }
    seen.add(real);
    queue.push({ src: real, rel: path.relative(realRoot, real) });
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
    const dest = path.join(destRoot, rel);
    if (!isInside(destRoot, dest)) {
      logger.warn("import", "Refused a sibling destination outside the sandbox", { rel });
      continue;
    }
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

export function scanDir(root: string): FoundTest[] {
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
          found.push({ filePath: full, content: fs.readFileSync(full, "utf-8"), root });
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  }

  walk(root, 0);
  return found;
}

/** Best-effort test URL: where the spec first navigates, made absolute against
 *  the project's base URL when the spec's own navigations are relative.
 *
 *  Delegated to `imported-config.ts` so that "what counts as a navigation" has
 *  one definition — the same one that decides whether a base URL is required at
 *  all. Two answers here would mean a test flagged as needing a base URL while
 *  its own URL column claimed otherwise. */
export function extractUrl(content: string, baseUrl?: string): string {
  return firstNavigationUrl(content, baseUrl);
}

/** Prefer the first `test("title", …)` name, else the file's base name. */
export function extractName(content: string, filePath: string): string {
  const m = content.match(/\btest(?:\.\w+)?\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (m && m[1].trim()) return m[1].trim();
  return path.basename(filePath).replace(TEST_FILE_RE, "");
}

function importFound(found: FoundTest[]): ImportResult {
  const created: TestRecord[] = [];
  const needsBaseUrl: string[] = [];
  const unsupported = new Set<string>();
  // A project has one config and an import usually brings in every spec under
  // it, so read it once per directory rather than once per file. `null` is a
  // cached answer too — "there is no config here" is the common case and is
  // just as expensive to determine twice.
  const configCache = new Map<string, ImportedProjectConfig | null>();
  const configFor = (specDir: string, root: string): ImportedProjectConfig | null => {
    const key = specDir + " " + root;
    if (!configCache.has(key)) configCache.set(key, readProjectConfig(specDir, root));
    return configCache.get(key) ?? null;
  };

  for (const f of found) {
    const id = randomUUID();
    const now = Date.now();
    // An imported spec may reference sibling modules (`./fixtures.js`,
    // `../helpers/db.ts`, …) that live around it in the source tree. The
    // original folder or git checkout won't be there at run time, so they're
    // copied in at import time — and the spec and its siblings keep the
    // positions they had RELATIVE TO THE PROJECT ROOT, inside a directory of
    // this test's own.
    //
    // That layout is what makes containment possible. Flattening the spec to
    // the scripts dir meant a sibling one level up had to be written one level
    // ABOVE the scripts dir for the spec's own `../` to still find it — so
    // escaping was load-bearing, and there was no line to draw. Preserving the
    // structure means every relative import resolves exactly as it did in the
    // original project while nothing has to leave the sandbox.
    const sandbox = importedSandboxDir(id);
    const specDir = path.dirname(f.filePath);
    const scriptPath = path.join(sandbox, path.relative(f.root, f.filePath));
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, f.content, "utf-8");
    const siblings = copyRelativeImports(f.content, specDir, sandbox, f.root);
    // Analyze the file and translate its test() bodies into the app's Step[]
    // model so the imported test shows up in the Steps view. When nothing
    // could be parsed, leave steps empty and fall back to a script-only
    // import (scriptEdited stays true so the Script view is the source of
    // truth). When steps were parsed we still keep scriptEdited true: the
    // verbatim imported file is the runnable artifact and must not be
    // regenerated from the (lossy) parsed steps on a rename.
    const steps = parseSpec(f.content);
    // What the spec inherited from its own project and cannot run without. A
    // hand-written suite navigates relatively — `page.goto("/")` — against a
    // `baseURL` that lives in a config file, and copying the spec alone leaves
    // every one of those navigations pointing at nothing.
    const config = configFor(specDir, f.root);
    const name = extractName(f.content, f.filePath);
    if (config) for (const u of config.unsupported) unsupported.add(u);
    // Asked of the sandbox, which by now holds the spec AND the siblings just
    // copied beside it — the same question the runner asks before it spawns, of
    // the same files. A spec-only answer would differ from the runner's for
    // every suite that keeps its navigation in a helper, and the two disagreeing
    // is how a test gets imported without a warning and then refuses to run.
    if (!config?.baseUrl && treeNeedsBaseUrl(scriptPath, sandbox)) needsBaseUrl.push(name);
    const record: TestRecord = {
      id,
      name,
      url: extractUrl(f.content, config?.baseUrl),
      createdAt: now,
      updatedAt: now,
      steps,
      scriptPath,
      scriptEdited: true,
      sourceDir: specDir,
      sourceRoot: f.root,
      ...(config?.baseUrl ? { baseUrl: config.baseUrl } : {}),
      // The source project's per-test timeout, adopted rather than noted: a
      // suite written against a 120s limit fails at this app's 30s default for
      // reasons that have nothing to do with the test. It lands in the Timeout
      // box on the toolbar, so it is visible and can be changed like any other.
      ...(config?.timeoutMs ? { testTimeoutMs: config.timeoutMs } : {}),
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
    withBaseUrl: created.filter((c) => c.baseUrl).length,
    needsBaseUrl: needsBaseUrl.length,
  });
  return {
    imported: created.length,
    names: created.map((c) => c.name),
    ids: created.map((c) => c.id),
    needsBaseUrl,
    unsupported: [...unsupported],
  };
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
  // The two roots have to be picked together, because `rel` is measured from
  // one and applied to the other. Splitting them — say, a project-relative
  // `rel` written under the SPEC's directory — silently nests every sibling one
  // level too deep, and the spec's imports stop resolving.
  //
  // Sandboxed: paths are project-relative, so they rebase onto the sandbox root.
  // Pre-sandbox: `sourceRoot` is absent, and the flat layout measured from the
  // spec's own directory. That's also the tightest boundary certainly right for
  // those records, so a repair can only write beside the script it repairs. A
  // test whose project reached ABOVE its spec dir needs re-importing to regain
  // that — the honest trade for no longer writing outside the scripts dir.
  const [destRoot, projectRoot] = rec.sourceRoot
    ? [importedSandboxDir(id), rec.sourceRoot]
    : [path.dirname(rec.scriptPath), rec.sourceDir];
  return copyRelativeImports(source, rec.sourceDir, destRoot, projectRoot);
}

/**
 * Fill in an imported test's base URL from the project it came from, if that
 * project is still on disk. Returns the URL adopted, or null.
 *
 * For the tests imported BEFORE any of this existed. Their records carry
 * `sourceDir`/`sourceRoot` and nothing else, so the alternative is the user
 * typing the same URL into every test in a library they imported in one action
 * — and `tests:repairImports`, the obvious place to hang a fix, has no UI to
 * reach it from.
 *
 * Called only when a run is about to be REFUSED, which is what makes reading
 * the source folder again defensible: the choice is between this and telling
 * the user we can't run their test. The caller announces what it adopted and
 * from where — a base URL that appears in a test's settings without explanation
 * is worse than one the user typed.
 */
export function backfillBaseUrl(id: string): string | null {
  const rec = testStore.get(id);
  if (!rec || rec.baseUrl || !rec.sourceDir) return null;
  const config = readProjectConfig(rec.sourceDir, rec.sourceRoot ?? rec.sourceDir);
  if (!config?.baseUrl) return null;
  rec.baseUrl = config.baseUrl;
  rec.updatedAt = Date.now();
  testStore.save(rec);
  logger.info("import", "Adopted a base URL from the imported project", { id });
  return config.baseUrl;
}

export const importService = {
  /** Open a native directory picker, scan it, and import any test files found. */
  async importFromFiles(): Promise<ImportResult> {
    const res = await dialog.showOpenDialog({
      title: "Select a folder of Playwright tests",
      properties: ["openDirectory"],
    });
    if (res.canceled || res.filePaths.length === 0) {
      return emptyResult();
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
