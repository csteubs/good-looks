// Where the app's data lives, resolved from a process with no Electron in it.
//
// ── What this replaces, and why it had to be replaced ──────────────────────
// This was `glaze-data.mjs`, a file the Glaze SDK told each app to copy in
// verbatim. It resolved the data directory from `package.json`'s `id` — a Glaze
// identity — and from the bundle layout Glaze sources lived under. The SDK port
// (#18, 2026-08-08) removed that `id`, so `readProjectId()` threw at module
// load and THE WHOLE MCP SERVER STOPPED STARTING: not one tool, all of them.
// Nothing caught it for six months because nothing booted the server — the
// `check:mcp-*` scripts read the source and import the pure modules, and stayed
// green against a server that could not run. `check:mcp-boot` exists now for
// exactly that reason.
//
// So this is a rewrite rather than a repair. `readProjectId` and
// `readHostFlavor` are gone: both describe a layout that no longer exists.
//
// ── Agreeing with the app ──────────────────────────────────────────────────
// The app resolves this too (`main/shell/user-data.ts`), and BOTH PROCESSES
// WRITE — this one appends run history and batch history. A disagreement is
// therefore not cosmetic: it is the app reading a library this server is not
// writing to, which is the bug `user-data.ts` was itself written against.
//
// The two cannot share the probing (`shared/` is pure by rule, and that side is
// compiled TypeScript), so what they share is the part that would drift:
// `shared/user-data-rules.mjs` owns the override name, the markers, the legacy
// pattern and the order. `check:mcp-parity` drives both resolvers against one
// fixture tree and asserts they agree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  chooseDataDir,
  LEGACY_DIR_RE,
  STORE_MARKERS,
  STORE_SUBDIR,
  USERDATA_OVERRIDE_ENV,
} from "../shared/user-data-rules.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The app's name as Electron computes it.
 *
 *  Electron prefers `productName` over `name` and derives userData from it, so
 *  this app's directory is `Good Looks!`, not `good-looks`. Reading the wrong
 *  one of those two would land this server in an empty directory beside the
 *  real store — the exact shape of the bug being fixed, so it is worth being
 *  explicit that the preference is Electron's and not a guess.
 *
 *  `projectRoot` is a parameter because `PROJECT_ROOT` comes off
 *  `import.meta.url`, which MOVES when a caller bundles this file: esbuild
 *  rewrites it to the bundle's own location, so `../package.json` resolves
 *  inside `node_modules`. The server never bundles, but `check:mcp-parity` does
 *  — and a check that cannot import this is a check that cannot compare it to
 *  the app's resolver. */
export function appName(projectRoot = PROJECT_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  return pkg.productName || pkg.name;
}

/**
 * Where Electron would put userData on this platform, for this app.
 *
 * The app ships macOS-only, so darwin is the case that matters in anger. The
 * other two are here because they cost three lines and they are what makes this
 * server drivable in CI and in a Linux dev container — which is to say, what
 * makes `check:mcp-boot` able to exist at all. Without them the only way to
 * exercise this file would be on someone's laptop.
 */
export function electronDefaultDir(name = appName(), platform = process.platform) {
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", name);
  }
  if (platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), name);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), name);
}

/** Whether a directory holds the recorder's own state. Mirrors
 *  `hasRecorderStore` in `main/shell/user-data.ts` — same markers, from the
 *  shared module, so "what counts as a store" has one definition. */
export function hasRecorderStore(dir) {
  const recorder = path.join(dir, STORE_SUBDIR);
  return STORE_MARKERS.some((m) => fs.existsSync(path.join(recorder, m)));
}

/** Glaze-era directories that hold a store, most recently used first.
 *
 *  Mirrors `findLegacyStores`: same pattern, same "must already hold a store"
 *  filter, same mtime ordering. See `chooseDataDir` for why newest-first is
 *  stable between two processes rather than a race. */
export function findLegacyStores(appSupportRoot) {
  let entries;
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

/** The full decision, with the reason. Exported separately from
 *  `resolveDataDir` so a check can assert WHICH branch fired — "it happened to
 *  land on the right path" and "it adopted for the right reason" are different
 *  facts, and only the second one stays true when the tree changes. */
export function resolveDataDirChoice(env = process.env, platform = process.platform) {
  const defaultDir = electronDefaultDir(appName(), platform);
  return chooseDataDir({
    override: env[USERDATA_OVERRIDE_ENV],
    defaultDir,
    defaultHasStore: hasRecorderStore(defaultDir),
    legacyDirs: findLegacyStores(path.dirname(defaultDir)),
  });
}

/**
 * The data directory, or a thrown error that says what to do about it.
 *
 * Throws only when there is nothing to point at AND nothing has ever been
 * written — never silently returning an empty directory, because that is what
 * the port did and it read as a wiped install rather than a misdirected one.
 * The message names every input, since the reader is usually looking at an MCP
 * client's log with no other context.
 */
export function resolveDataDir(env = process.env, platform = process.platform) {
  const choice = resolveDataDirChoice(env, platform);
  // ABSOLUTE, always. The two derived branches already are; the OVERRIDE is
  // whatever the caller typed, and `--library ./tests` in a workflow or
  // `GOOD_LOOKS_USERDATA=fixture-library` in a shell is the ordinary spelling.
  //
  // Every path a run uses hangs off this one, and a relative root is not merely
  // fragile — it is silently wrong the moment a path leaves this process. The
  // reporter is where it surfaced: `--reporter <scriptsDir>/step-reporter.mjs`
  // is handed to the Playwright CLI, which resolves it with `require.resolve`,
  // and a specifier that does not begin with `./` is read as a PACKAGE NAME.
  // So the run died with `Cannot find module
  // 'fixture-library/recorder/scripts/step-reporter.mjs'` before any test body
  // ran, and reported every test as failed with `exit 1` and no step.
  //
  // Fixed at the root rather than at the reporter, because the reporter is one
  // of several — the output directory, the artifact directory and the heal map
  // are all joined onto this too, and each would be its own version of this bug.
  //
  // Found by the GitHub Action's self-test on its first real run (R14): a
  // workflow naturally passes a path relative to the workspace.
  const dir = choice.dir ? path.resolve(choice.dir) : choice.dir;
  if (choice.reason === "default" && !hasRecorderStore(dir)) {
    throw new Error(
      `No data directory found for "${appName()}".\n` +
        `  Looked for a recorder store in: ${dir}\n` +
        `  …and for a Glaze-era one beside it in: ${path.dirname(dir)}\n` +
        `  Launch the app once so it creates its store, or set ` +
        `${USERDATA_OVERRIDE_ENV} to point here explicitly.`,
    );
  }
  return dir;
}

export function readJsonFile(dataDir, fileName, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, fileName), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJsonFile(dataDir, fileName, value) {
  const filePath = path.join(dataDir, fileName);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}
