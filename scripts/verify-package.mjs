#!/usr/bin/env node
/**
 * Two guards around `npm run package`, because packaging can fail loudly in the
 * log and still exit 0 with a broken .app.
 *
 *   node scripts/verify-package.mjs --preflight   (before the build)
 *   node scripts/verify-package.mjs --verify      (after electron-builder)
 *
 * Both take an optional `--root <dir>`, which is what makes them testable
 * against a fixture rather than only against this repo — see
 * `main/services/__tests__/package-integrity.check.ts`.
 *
 * ── What went wrong ───────────────────────────────────────────────────────
 * `scripts/bootstrap-worktree.mjs` gives a worktree its `node_modules` as a
 * SYMLINK at the main checkout's tree. Every other command in this repo is fine
 * with that — lint, type-check, `test:all` and `build` all resolve modules
 * through the link exactly as Node does. **electron-builder does not.** It
 * collects the dependency tree by reading `node_modules` itself, and through the
 * link it finds the direct dependencies and nothing below them. It prints
 *
 *     cannot find path for dependency dependencies=["zod@undefined", …]
 *
 * — a list of ~80 TRANSITIVE packages — and then **exits 0**.
 *
 * The bundle that comes out has `@playwright/test` and no `playwright` or
 * `playwright-core`. `main/services/playwright-runner.ts` spawns the Playwright
 * CLI out of the bundled tree and `@playwright/test` requires `playwright`
 * internally, so every test run in that app fails. Nothing is wrong until the
 * user presses Run, which is the worst possible moment to find out.
 *
 * ── Why two guards and not one ────────────────────────────────────────────
 * The preflight names the cause at the moment it is cheap to fix, before a
 * multi-minute build. The verify half is the one that is actually load-bearing:
 * it asks the produced bundle the runtime question directly, so it also catches
 * a bundle broken some way nobody has thought of yet — a `files` pattern that
 * excludes too much, a dependency moved from `dependencies` to
 * `devDependencies`, a future electron-builder that drops something else. A
 * guard that only knows about symlinks would go green on all of those.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import * as path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";

/**
 * Packages the app resolves BY PATH at runtime rather than by `import`, so a
 * bundler cannot vouch for them and a missing one is invisible until the
 * feature is used. Each is named with what breaks, because "a package is
 * missing" is not a message anyone can act on.
 *
 * These are asserted on top of the computed closure below, deliberately. The
 * closure is derived from package.json files and would notice all three today;
 * this list is what keeps the *consequence* attached to the check, and it holds
 * even if the closure walk is ever wrong about something.
 */
const RUNTIME_CRITICAL = [
  ["@playwright/test", "the test runner the app spawns for every run"],
  ["playwright", "required internally by @playwright/test — missing it fails every run at startup"],
  ["playwright-core", "the browser driver underneath playwright"],
  ["axe-core", "injected into the page under test for accessibility assertions"],
];

/** @param {string} name @returns {string | undefined} */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** @param {string} file @returns {Record<string, any> | null} */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Node's own module resolution, in the one form this file needs: walk up from
 * `fromDir` looking for `node_modules/<name>`, stopping at `root`.
 *
 * Asking it this way rather than comparing directory listings is what makes the
 * check independent of layout. npm hoists most packages to the top level and
 * nests the ones it cannot; both answers are correct, and both are "yes" here.
 *
 * @param {string} fromDir @param {string} name @param {string} root
 * @returns {string | null}
 */
function resolvePackageDir(fromDir, name, root) {
  let dir = path.resolve(fromDir);
  const stop = path.resolve(root);
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Every package the app can reach at runtime, as `{name, fromRel}` pairs —
 * the name to resolve and the directory to resolve it FROM, relative to the
 * project root. The pair is the unit rather than a bare name because that is
 * what can be re-asked of the bundle without assuming anything about how the
 * tree is laid out there.
 *
 * Only `dependencies` is followed. `devDependencies` are not shipped, and
 * `optionalDependencies` are optional by definition — a build that legitimately
 * pruned one must not be reported as broken.
 *
 * @param {string} root
 * @returns {{ expected: Array<{name: string, fromRel: string}>, unresolved: string[] }}
 */
function runtimeClosure(root) {
  const rootPkg = readJson(path.join(root, "package.json"));
  if (!rootPkg) throw new Error(`No readable package.json in ${root}`);

  /** @type {Array<{name: string, fromRel: string}>} */
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => ({ name, fromRel: "" }));
  /** @type {Array<{name: string, fromRel: string}>} */
  const expected = [];
  const seenDirs = new Set();
  /** @type {string[]} */
  const unresolved = [];

  while (queue.length > 0) {
    const { name, fromRel } = /** @type {{name: string, fromRel: string}} */ (queue.shift());
    const dir = resolvePackageDir(path.join(root, fromRel), name, root);
    if (!dir) {
      // Not installed here at all. That is a fact about this tree, not about
      // the bundle, so it cannot be a packaging failure — an optional or
      // platform-specific dependency npm skipped looks exactly like this.
      unresolved.push(name);
      continue;
    }
    expected.push({ name, fromRel });
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);

    const pkg = readJson(path.join(dir, "package.json"));
    const childFrom = path.relative(root, dir);
    for (const child of Object.keys(pkg?.dependencies ?? {})) {
      queue.push({ name: child, fromRel: childFrom });
    }
  }
  return { expected, unresolved };
}

// ── Preflight ─────────────────────────────────────────────────────────

/** @param {string} root */
function preflight(root) {
  const modules = path.join(root, "node_modules");
  const entry = lstatSync(modules, { throwIfNoEntry: false });

  if (!entry) {
    fail(
      `There is no node_modules in ${root}.`,
      "",
      "Run `npm install --include=dev` before packaging.",
    );
  }

  // lstat, not stat: the question is what this entry IS, not what it points at.
  // `existsSync` and `statSync` both follow the link and would answer
  // "directory" for precisely the case that breaks.
  if (entry.isSymbolicLink()) {
    fail(
      "node_modules is a symlink, so electron-builder cannot produce a working bundle.",
      `  ${modules} -> ${readlinkSync(modules)}`,
      "",
      "This is what `npm run bootstrap` leaves behind, and it is fine for lint,",
      "type-check, test:all and build — they resolve modules the way Node does.",
      "electron-builder instead walks node_modules itself, and through the link it",
      "finds the direct dependencies and nothing below them. It reports that as",
      "`cannot find path for dependency` and then EXITS 0, so the .app looks built",
      "and is missing playwright, playwright-core and ~80 other packages. The app",
      "launches fine and every test run fails.",
      "",
      "Packaging needs a real install in this worktree:",
      "",
      "  rm node_modules && npm install --include=dev",
      "",
      "(That removes the link, not the tree it points at. `npm run bootstrap` can",
      "put the link back afterwards if you want the disk space returned.)",
    );
  }

  console.log("ok   node_modules is a real directory — safe to package.");
}

// ── Verify ────────────────────────────────────────────────────────────

/**
 * Every packaged app under `dist/`. Discovered rather than hardcoded: the
 * output directory carries the architecture (`mac-arm64`, `mac`, …), and a
 * check that silently finds nothing is worse than no check.
 *
 * @param {string} root
 * @returns {string[]} the `Contents/Resources/app` directory of each bundle
 */
function packagedApps(root) {
  const dist = path.join(root, "dist");
  if (!existsSync(dist)) return [];
  /** @type {string[]} */
  const apps = [];
  for (const outDir of readdirSync(dist, { withFileTypes: true })) {
    if (!outDir.isDirectory()) continue;
    for (const entry of readdirSync(path.join(dist, outDir.name), { withFileTypes: true })) {
      if (!entry.name.endsWith(".app")) continue;
      const appDir = path.join(dist, outDir.name, entry.name, "Contents", "Resources", "app");
      if (existsSync(appDir)) apps.push(appDir);
    }
  }
  return apps;
}

/** @param {string} root */
function verify(root) {
  const apps = packagedApps(root);
  if (apps.length === 0) {
    fail(
      `No packaged app found under ${path.join(root, "dist")}.`,
      "",
      "electron-builder reported success without producing a bundle, or it wrote",
      "somewhere this check does not look. Either way there is nothing to ship.",
    );
  }

  const { expected, unresolved } = runtimeClosure(root);
  if (expected.length === 0) {
    fail(
      "The dependency closure came out empty, so this check would pass on anything.",
      `Is ${path.join(root, "node_modules")} installed?`,
    );
  }

  for (const app of apps) {
    /** @type {string[]} */
    const missing = [];
    for (const { name, fromRel } of expected) {
      if (!resolvePackageDir(path.join(app, fromRel), name, app)) missing.push(name);
    }

    /** @type {string[]} */
    const criticalMissing = [];
    for (const [name, why] of RUNTIME_CRITICAL) {
      if (!resolvePackageDir(app, name, app)) criticalMissing.push(`  ${name} — ${why}`);
    }

    if (missing.length > 0 || criticalMissing.length > 0) {
      const unique = [...new Set(missing)].sort();
      const shown = unique.slice(0, 20);
      fail(
        `The packaged app is missing dependencies it needs at runtime.`,
        `  ${app}`,
        "",
        ...(criticalMissing.length > 0
          ? ["Packages with a known, named consequence:", ...criticalMissing, ""]
          : []),
        `${unique.length} package(s) in the dependency closure are not resolvable from the bundle:`,
        ...shown.map((n) => `  ${n}`),
        ...(unique.length > shown.length ? [`  … and ${unique.length - shown.length} more`] : []),
        "",
        "The usual cause is packaging from a worktree whose node_modules is a",
        "symlink (`npm run bootstrap`): electron-builder cannot walk the tree",
        "through it, says so, and still exits 0. Fix with a real install —",
        "`rm node_modules && npm install --include=dev` — and package again.",
      );
    }

    // Unique names, not `expected.length`: the closure is a list of EDGES, so a
    // package required by nine others appears nine times and a raw count reads
    // as several hundred more packages than the bundle contains.
    const packages = new Set(expected.map((e) => e.name)).size;
    console.log(
      `ok   ${packages} runtime package(s), ${expected.length} dependency edges, all resolvable in ${path.relative(root, app) || app}`,
    );
  }

  if (unresolved.length > 0) {
    // Reported, never fatal: these are absent from the SOURCE tree, so the
    // bundle not having them is correct. Printed because a name appearing here
    // that ought to be installed is worth seeing.
    console.log(
      `note not installed here, so not expected in the bundle: ${[...new Set(unresolved)].sort().join(", ")}`,
    );
  }
}

// ── Entry ─────────────────────────────────────────────────────────────

/** @param {...string} lines @returns {never} */
function fail(...lines) {
  console.error("\nFAIL " + lines.join("\n"));
  process.exit(1);
}

function main() {
  // Default to this script's own repository rather than cwd: `npm run` sets cwd
  // to the package root, but running the script by hand from anywhere else must
  // not silently check a different tree.
  const ownRepo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = path.resolve(arg("root") ?? ownRepo);

  const wantPreflight = process.argv.includes("--preflight");
  const wantVerify = process.argv.includes("--verify");
  if (!wantPreflight && !wantVerify) {
    console.error("Usage: verify-package.mjs (--preflight | --verify) [--root <dir>]");
    process.exit(2);
  }

  if (wantPreflight) preflight(root);
  if (wantVerify) verify(root);
}

main();
