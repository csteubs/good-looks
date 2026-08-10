#!/usr/bin/env node
/**
 * Give `npm run dev` the app's own name and icon.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 * In development the app is not its own macOS bundle: `electron .` runs
 * `node_modules/electron/dist/Electron.app` and hands it our directory. macOS
 * takes the DOCK ICON and the FIRST MENU BAR TITLE from the bundle that is
 * running, not from anything the app does at runtime — so dev shows the
 * Electron atom and an "Electron" menu no matter what the code says.
 *
 * `app.setName()` does NOT fix it. It renames the About panel, notifications
 * and `app.getPath("userData")` (which is why this module deliberately does not
 * call it — the data directory is derived from the name and moving it would
 * point the app at an empty library; see main/shell/user-data.ts). The menu
 * bar title is CFBundleName from the running bundle's Info.plist, full stop.
 * A packaged build is already correct: electron-builder writes both from
 * `build.productName` / `build.mac.icon`.
 *
 * ── What this does ─────────────────────────────────────────────────────────
 * Clones Electron.app once into the npm cache, rewrites the three fields macOS
 * reads (CFBundleName, CFBundleDisplayName, CFBundleExecutable), drops the
 * app's real .icns over the bundle's, and re-signs. `npm run dev` then launches
 * THAT binary instead of `npx electron`.
 *
 * Three things make it cheap enough to do on every dev launch:
 *   • `cp -Rc` is an APFS clone — 276 MB copied in ~0.15s and ~0 bytes on disk.
 *   • A stamp file records the Electron version and the icon's identity, so the
 *     clone is rebuilt only when one of them changes.
 *   • Everything is best-effort. Any failure returns null and `npm run dev`
 *     falls back to plain `npx electron .` — a wrong-looking icon must never be
 *     the reason the app won't start.
 *
 * Re-signing is not optional: editing Info.plist invalidates the ad-hoc
 * signature Electron ships with, and on Apple Silicon the kernel kills a binary
 * whose signature does not match. `codesign --force --sign -` restores it.
 *
 * Renaming the executable is not optional either. macOS falls back to
 * CFBundleExecutable for the process name, so a bundle with the right
 * CFBundleName and the old executable name still says "Electron" — that was
 * measured, not assumed.
 *
 * Runs standalone, because a build only reachable from `npm run dev` is one
 * nobody can debug:
 *
 *   node scripts/dev-app-bundle.mjs          # build/refresh it, print the path
 *   node scripts/dev-app-bundle.mjs --force  # rebuild even if the stamp matches
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The name macOS shows in the menu bar and the Dock. Matches
 *  `build.productName` in package.json so dev and a packaged build agree. */
export const DEV_APP_NAME = "Good Looks!";

/** Bumped when the recipe below changes, so an existing clone built by an
 *  older version of this script is rebuilt rather than silently kept. */
const RECIPE_VERSION = 1;

const ICON_SOURCE = "build-icon.icns";

/** Identity of the inputs. A change to any of these invalidates the clone. */
export function computeStamp({ electronVersion, iconSize, iconMtimeMs, appName }) {
  return JSON.stringify({
    recipe: RECIPE_VERSION,
    electronVersion,
    iconSize,
    iconMtimeMs,
    appName,
  });
}

/** True when the clone has to be (re)built: no bundle, no stamp, or a stamp
 *  that does not describe the inputs we have now. */
export function needsRebuild({ executableExists, previousStamp, currentStamp }) {
  if (!executableExists) return true;
  return previousStamp !== currentStamp;
}

function readElectronVersion(repoRoot) {
  const pkg = path.join(repoRoot, "node_modules", "electron", "package.json");
  return JSON.parse(fs.readFileSync(pkg, "utf-8")).version;
}

/** Where the clone lives. Under `node_modules/.cache` (already this repo's
 *  scratch space — the bundled `check:*` scripts build there) so it is
 *  gitignored, disposable, and shared by every worktree that symlinked the same
 *  tree, which is also the only case where they run the same Electron. */
function cacheDir(repoRoot) {
  return path.join(repoRoot, "node_modules", ".cache", "dev-app");
}

function plistSet(plist, key, value) {
  execFileSync("plutil", ["-replace", key, "-string", value, plist], { stdio: "pipe" });
}

/**
 * Build (or reuse) the branded dev bundle and return the path to its
 * executable. Returns null when it cannot be built — the caller must fall back
 * to launching Electron directly.
 */
export function ensureDevAppExecutable({ repoRoot = REPO_ROOT, force = false, log = () => {} } = {}) {
  if (process.platform !== "darwin") return null;

  try {
    const iconPath = path.join(repoRoot, ICON_SOURCE);
    const iconStat = fs.statSync(iconPath);
    const electronVersion = readElectronVersion(repoRoot);
    const sourceApp = path.join(repoRoot, "node_modules", "electron", "dist", "Electron.app");
    if (!fs.existsSync(sourceApp)) return null;

    const outDir = cacheDir(repoRoot);
    const appPath = path.join(outDir, `${DEV_APP_NAME}.app`);
    const executable = path.join(appPath, "Contents", "MacOS", DEV_APP_NAME);
    const stampPath = path.join(outDir, "stamp.json");

    const currentStamp = computeStamp({
      electronVersion,
      iconSize: iconStat.size,
      iconMtimeMs: Math.trunc(iconStat.mtimeMs),
      appName: DEV_APP_NAME,
    });
    const previousStamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf-8") : null;

    if (
      !force &&
      !needsRebuild({ executableExists: fs.existsSync(executable), previousStamp, currentStamp })
    ) {
      return executable;
    }

    log(`[dev] building the branded dev bundle (Electron ${electronVersion})`);
    fs.rmSync(appPath, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.rmSync(stampPath, { force: true });

    // -c is an APFS clone: instant, and the copy shares blocks with the
    // original until something writes to it. Fall back to a real copy on a
    // filesystem that cannot clone.
    try {
      execFileSync("cp", ["-Rc", sourceApp, appPath], { stdio: "pipe" });
    } catch {
      execFileSync("cp", ["-R", sourceApp, appPath], { stdio: "pipe" });
    }

    const contents = path.join(appPath, "Contents");
    const plist = path.join(contents, "Info.plist");
    fs.renameSync(path.join(contents, "MacOS", "Electron"), executable);
    plistSet(plist, "CFBundleName", DEV_APP_NAME);
    plistSet(plist, "CFBundleDisplayName", DEV_APP_NAME);
    plistSet(plist, "CFBundleExecutable", DEV_APP_NAME);
    // A distinct identifier so macOS never confuses the dev bundle with a
    // packaged install (they can be open at the same time).
    plistSet(plist, "CFBundleIdentifier", "com.goodlooks.recorder.dev");
    fs.copyFileSync(iconPath, path.join(contents, "Resources", "electron.icns"));

    execFileSync("codesign", ["--force", "--sign", "-", appPath], { stdio: "pipe" });

    fs.writeFileSync(stampPath, currentStamp);
    return executable;
  } catch (err) {
    log(`[dev] could not build the branded dev bundle (${err.message}) — using plain Electron`);
    return null;
  }
}

// Standalone entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  const executable = ensureDevAppExecutable({
    force: process.argv.includes("--force"),
    log: (m) => console.log(m),
  });
  if (!executable) {
    console.error("no branded dev bundle — `npm run dev` will launch plain Electron");
    process.exit(1);
  }
  console.log(executable);
}
