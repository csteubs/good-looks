// Where the app's data lives — the RULES, shared by the two processes that
// have to agree about the answer.
//
// ── Why this file exists ───────────────────────────────────────────────────
// Two processes resolve this independently: the Electron app
// (`main/shell/user-data.ts`) and the standalone MCP server
// (`mcp/data-dir.mjs`). BOTH WRITE — the MCP appends run history and batch
// history — so a disagreement is not a cosmetic split. It is the app reading a
// library the MCP is not writing to, which is exactly the bug
// `main/shell/user-data.ts` was written against, one process over.
//
// The two cannot share a module that touches the filesystem: `shared/` is pure
// by rule (CLAUDE.md), the app half is compiled TypeScript and the MCP half is
// plain `.mjs` with no build step. So the split is deliberate — the FS PROBING
// stays on each side, where it is mechanical and obvious, and what lives here
// is the part that would drift silently: which environment variable overrides,
// what counts as a store, what a legacy directory looks like, and the order the
// three are considered in. A transcribed copy of those is right the day it is
// written and wrong the day either side is edited.
//
// Nothing here reads the disk. Callers hand in what they found.

/** Points either process at a specific data directory.
 *
 *  The escape hatch for anyone whose layout this guesses wrong, the seam the
 *  tests drive (they must never touch a real store), and the ONLY way to run
 *  the MCP server off macOS — which is what makes it drivable in CI. */
export const USERDATA_OVERRIDE_ENV = "GOOD_LOOKS_USERDATA";

/** Everything the recorder owns lives under this one subdirectory of userData.
 *  Scoping the markers below to it is load-bearing: Electron itself writes
 *  Cache/, Local Storage/ and friends into userData before the app's own code
 *  runs, so a marker at the top level would report every fresh profile as an
 *  established store. */
export const STORE_SUBDIR = "recorder";

/** What makes a directory "a real store".
 *
 *  `metrics.db` is deliberately NOT here: it is a DERIVED shadow of the JSON
 *  stores (CLAUDE.md), and the app builds an empty one on first launch — before
 *  any of this could matter. Counting it would mean the second launch never
 *  adopts, which is precisely the bug adoption exists to fix. */
export const STORE_MARKERS = ["tests.json", "run-history.json", "scripts"];

/** What a Glaze-era data directory is called.
 *
 *  Glaze named them `app.glaze.macos.<instance>-local`, siblings of the
 *  Electron default inside the same Application Support root.
 *
 *  ANCHORED AT `-local`, so a FLAVOURED directory (`…-local.dev`) does not
 *  match. That is narrower than the Glaze-era resolver was — it had a whole
 *  `readHostFlavor` branch — and it is kept narrow on purpose: this is the rule
 *  the app has actually shipped since the port, and widening it here would
 *  quietly change which directory an existing install adopts. */
export const LEGACY_DIR_RE = /^app\.glaze\.macos\..*-local$/;

/**
 * Decide the data directory from what the caller found on disk.
 *
 * @param {object} found
 * @param {string} [found.override]        `USERDATA_OVERRIDE_ENV`, if set.
 * @param {string} found.defaultDir        Where the platform would put it.
 * @param {boolean} found.defaultHasStore  Whether `defaultDir` holds a store.
 * @param {string[]} [found.legacyDirs]    Legacy dirs that hold a store, the
 *   most recently used FIRST. Ordering is the caller's to establish because it
 *   comes off the filesystem; see the note below on why mtime is safe.
 * @returns {{ dir: string, reason: "override"|"own-store"|"adopted-legacy"|"default", legacy?: string }}
 *
 * ── The order, and why ─────────────────────────────────────────────────────
 * 1. An explicit override wins over everything. It is the answer to "you
 *    guessed wrong", so anything that could override IT would defeat it.
 * 2. A default directory that already has a store is never redirected. This is
 *    what stops adoption from being a permanent indirection — an install that
 *    has started accumulating its own data keeps it.
 * 3. Otherwise adopt the newest legacy store, IN PLACE. No data moves, so a
 *    Glaze build still works against the same store and there is no half-copied
 *    state if this is interrupted.
 * 4. Otherwise the default, empty and ready to be filled.
 *
 * ── Why "newest" is stable rather than a race ──────────────────────────────
 * Adoption is PERMANENT, not one-shot: the app redirects userData at the
 * adopted directory and therefore never writes to the default, so
 * `defaultHasStore` stays false and step 3 fires on every launch. Each launch
 * writes to the adopted directory, which keeps its mtime the newest. Whoever
 * wrote last is whoever gets picked next — so the app and the MCP converge on
 * one directory rather than drifting apart, even though each ran `stat` at a
 * different moment.
 */
export function chooseDataDir(found) {
  const { override, defaultDir, defaultHasStore, legacyDirs = [] } = found ?? {};

  if (typeof override === "string" && override !== "") {
    return { dir: override, reason: "override" };
  }
  if (defaultHasStore) return { dir: defaultDir, reason: "own-store" };
  if (legacyDirs.length > 0) {
    return { dir: legacyDirs[0], reason: "adopted-legacy", legacy: legacyDirs[0] };
  }
  return { dir: defaultDir, reason: "default" };
}
