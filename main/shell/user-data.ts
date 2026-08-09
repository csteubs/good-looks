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
// install that has started accumulating its own data, and it is idempotent:
// once the port has written anything real, the branch stops firing.
//
// Guarded by `check:userdata-migration` and `user-data.test.ts`.

import * as fs from "fs";
import * as path from "path";

import { app } from "@shell/backend";

/** Set this to point the app at a specific data directory.
 *
 *  The escape hatch for anyone whose layout this module guesses wrong, and the
 *  seam the tests drive — they must never touch a real store. */
const OVERRIDE_ENV = "GOOD_LOOKS_USERDATA";

/** A directory counts as "a real store" if it has the recorder's own state in
 *  it. `metrics.db` deliberately does NOT count: it is a DERIVED shadow of the
 *  JSON stores (see CLAUDE.md) and the port builds an empty one on first launch
 *  before any of this could matter. Treating it as evidence would mean the
 *  second launch never adopts, which is precisely the bug. */
const STORE_MARKERS = ["tests.json", "run-history.json", "scripts"];

export function hasRecorderStore(userDataDir: string): boolean {
  const recorder = path.join(userDataDir, "recorder");
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
    .filter((e) => e.isDirectory() && /^app\.glaze\.macos\..*-local$/.test(e.name))
    .map((e) => path.join(appSupportRoot, e.name))
    .filter(hasRecorderStore)
    .map((dir) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(dir, "recorder")).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { dir, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.dir);
}

/** Decide the data directory. Pure: takes the world as arguments so it can be
 *  tested without an Electron app object or a real Application Support tree. */
export function resolveUserData(
  currentUserData: string,
  env: Record<string, string | undefined>,
): { dir: string; reason: "override" | "own-store" | "adopted-legacy" | "default"; legacy?: string } {
  const override = env[OVERRIDE_ENV];
  if (override) return { dir: override, reason: "override" };

  // Already has its own data — never redirect. This is what makes adoption
  // one-shot rather than a permanent indirection.
  if (hasRecorderStore(currentUserData)) return { dir: currentUserData, reason: "own-store" };

  const legacy = findLegacyStores(path.dirname(currentUserData));
  if (legacy.length > 0) {
    return { dir: legacy[0], reason: "adopted-legacy", legacy: legacy[0] };
  }

  return { dir: currentUserData, reason: "default" };
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
      `[user-data]   Set ${OVERRIDE_ENV} to choose a different one.`,
  );
}
