// Where the app's data lives — resolved ONCE, before anything reads it.
//
// ── The bug this exists to fix ─────────────────────────────────────────────
// Under Glaze, the host supplied userData: an app-scoped directory named after
// the Glaze app instance (`app.glaze.macos.<id>-local/`). Stock Electron does
// not know about that. It derives userData from `productName`, so the port
// silently began reading and writing `~/Library/Application Support/Good Looks!/`
// — an empty directory.
//
// Nothing was lost, and that is exactly why it was dangerous: the app opened
// with an empty library, zero runs, no saved API keys and no downloaded
// browsers, while 1.4 GB of real data sat intact one directory away. It looked
// like a wiped install rather than a misdirected read. No test could catch it:
// every store test points userData at a temp dir, which is the correct thing
// for a test to do and the reason this was invisible until someone launched
// the app.
//
// ── What this does ─────────────────────────────────────────────────────────
// ADOPTS the legacy directory in place rather than copying out of it. No data
// moves, so a Glaze build of this app (if anyone still runs one) keeps working
// against the same store, and there is no half-copied state to reason about if
// this is interrupted. The cost is that the two builds share one store and can
// disagree about it; that is strictly better than the port pretending the data
// does not exist.
//
// Adoption is deliberately CONSERVATIVE. It happens only when the current
// userData has no recorder store of its own — so it can never redirect an
// install that has started accumulating its own data.
//
// It is also PERMANENT rather than one-shot, and that is worth naming because a
// second process depends on it: since userData is redirected, the app never
// writes to Electron's default, so `hasRecorderStore(default)` stays false and
// adoption fires again on every launch. Each launch touches the adopted
// directory, keeping its mtime newest — which is why "newest legacy store"
// converges between this and the MCP server rather than racing. Whoever wrote
// last is whoever gets picked next.
//
// ── The rules are SHARED, the probing is not ───────────────────────────────
// `mcp/data-dir.mjs` has to reach the same answer from a process with no
// Electron in it, and it WRITES — run history, batch history — so a
// disagreement is this same bug one process over. The two cannot share a module
// that touches the disk (`shared/` is pure by rule, and one side is compiled
// TypeScript while the other is plain `.mjs`), so what is shared is the part
// that would drift silently: `shared/user-data-rules.mjs` owns the override
// name, the markers, the legacy pattern and the ORDER. The `fs` calls below
// stay here, where they are mechanical.
//
// Guarded by `user-data.test.ts` and by `check:mcp-parity`, which drives this
// resolver and the MCP's against ONE fixture tree and asserts they agree.

import * as fs from "fs";
import * as path from "path";

import { app } from "@shell/backend";

import type { DataDirChoice } from "../../shared/user-data-rules.d.mts";
import {
  chooseDataDir,
  LEGACY_DIR_RE,
  STORE_MARKERS,
  STORE_SUBDIR,
  USERDATA_OVERRIDE_ENV,
} from "../../shared/user-data-rules.mjs";

export function hasRecorderStore(userDataDir: string): boolean {
  const recorder = path.join(userDataDir, STORE_SUBDIR);
  return STORE_MARKERS.some((m) => fs.existsSync(path.join(recorder, m)));
}

/** Legacy Glaze data directories, newest first.
 *
 *  Glaze named them `app.glaze.macos.<instance>-local`, siblings of the
 *  Electron default inside the same Application Support root — so this looks
 *  exactly one directory up and matches on that shape. It does not walk the
 *  filesystem, and it only ever returns directories that already contain a
 *  recorder store. */
export function findLegacyStores(appSupportRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appSupportRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && LEGACY_DIR_RE.test(e.name))
    .map((e) => path.join(appSupportRoot, e.name))
    .filter(hasRecorderStore)
    .map((dir) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(dir, STORE_SUBDIR)).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { dir, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.dir);
}

/** Decide the data directory.
 *
 *  Probes here, DECIDES in `shared/user-data-rules.mjs` — the MCP server runs
 *  the same chooser over its own probing, so the order can only be changed in
 *  one place. Takes `currentUserData` and `env` as arguments so it can be
 *  tested without an Electron app object or a real Application Support tree. */
export function resolveUserData(
  currentUserData: string,
  env: Record<string, string | undefined>,
): DataDirChoice {
  return chooseDataDir({
    override: env[USERDATA_OVERRIDE_ENV],
    defaultDir: currentUserData,
    defaultHasStore: hasRecorderStore(currentUserData),
    // The Application Support root is the parent of wherever Electron put
    // userData, which is the same root Glaze put its own directories in.
    legacyDirs: findLegacyStores(path.dirname(currentUserData)),
  });
}

/** Apply the decision to the running app.
 *
 *  MUST be called before any store resolves a path — every store calls
 *  `app.getPath("userData")` lazily on each access, so the only requirement is
 *  that this runs first. `main/index.ts` imports it above everything else for
 *  that reason; `applyRetention()` in particular runs at module scope there and
 *  would otherwise sweep the wrong directory. */
export function installUserDataPath(): void {
  const current = app.getPath("userData");
  const { dir, reason, legacy } = resolveUserData(current, process.env);

  if (dir !== current) {
    fs.mkdirSync(dir, { recursive: true });
    app.setPath("userData", dir);
  }

  if (reason === "adopted-legacy") {
    // Loud on purpose. Silently reading someone else's directory is worse than
    // the bug it fixes if nobody can tell it happened.
    logAdoption(legacy as string, current);
  }
}

function logAdoption(legacy: string, wouldHaveBeen: string): void {
  // console, not the file logger: the logger writes under userData/logs, and
  // this runs while that path is still being decided.
  console.warn(
    `[user-data] Adopted the existing data directory at ${legacy}\n` +
      `[user-data]   (Electron's default, ${wouldHaveBeen}, has no recorder store.)\n` +
      `[user-data]   Set ${USERDATA_OVERRIDE_ENV} to choose a different one.`,
  );
}
