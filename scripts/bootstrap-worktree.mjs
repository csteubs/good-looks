#!/usr/bin/env node
/**
 * Give a git worktree a node_modules, fast.
 *
 * A fresh worktree has no dependency tree, so `npm run lint`, `type-check`,
 * `test:all` and `build` all fail in it — which means the branches most likely
 * to want the gate (a parallel agent's, a quick experiment) are the ones least
 * likely to have run it. The alternative was a multi-minute `npm install` per
 * worktree, paid every time.
 *
 * When the lockfile matches the main checkout's, the whole tree is one symlink
 * away. `.gitignore` already spells `node_modules` without a trailing slash for
 * exactly this reason: the trailing-slash form matches only real directories,
 * so a symlinked tree showed up as untracked.
 *
 *   node scripts/bootstrap-worktree.mjs
 *
 * ── When it refuses ────────────────────────────────────────────────────────
 * If the lockfiles differ, this does NOT symlink. Sharing a tree across
 * branches with different dependencies means installing on one branch silently
 * rewrites the other's node_modules — the kind of failure that surfaces days
 * later as an inexplicable version error on a branch nobody touched. It says so
 * and tells you to install instead.
 *
 * ── What the link is NOT good enough for: `npm run package` ────────────────
 * Everything that resolves modules the way Node does is fine with a symlinked
 * tree — lint, type-check, `test:all`, `npm run build`, `npm run dev`. There is
 * exactly one exception, and it fails silently, so it is worth stating here
 * rather than leaving to be rediscovered.
 *
 * **electron-builder collects dependencies by reading `node_modules` itself**,
 * and through the link it finds the direct dependencies and nothing beneath
 * them. It prints `cannot find path for dependency` with ~80 transitive names
 * and then EXITS 0. The .app that comes out has `@playwright/test` and no
 * `playwright` or `playwright-core`, so it launches perfectly and every test run
 * fails — the app spawns the Playwright CLI out of its own bundled tree.
 *
 * So packaging needs a real install in the worktree, whether or not this
 * branch's dependencies differ from the main checkout's:
 *
 *   rm node_modules && npm install --include=dev
 *
 * `npm run package` refuses up front rather than trusting anyone to remember
 * (`scripts/verify-package.mjs`, guarded by `check:package-integrity`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import console from "node:console";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function hashOf(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
}

/** The main checkout — `git worktree list` always reports it first. */
function mainWorktree() {
  const first = git("worktree", "list", "--porcelain").split("\n")[0];
  if (!first.startsWith("worktree ")) throw new Error(`Unexpected worktree list output: ${first}`);
  return first.slice("worktree ".length);
}

function main() {
  const here = git("rev-parse", "--show-toplevel");
  const primary = mainWorktree();

  if (path.resolve(here) === path.resolve(primary)) {
    console.log("This is the main checkout, not a worktree — run `npm install --include=dev` here.");
    return;
  }

  const target = path.join(here, "node_modules");
  if (existsSync(target)) {
    const kind = lstatSync(target).isSymbolicLink() ? "symlink" : "directory";
    console.log(`ok   node_modules already present (${kind}) — nothing to do.`);
    return;
  }

  const source = path.join(primary, "node_modules");
  if (!existsSync(source)) {
    console.error(`The main checkout has no node_modules either.\n  ${source}\nRun \`npm install --include=dev\` there first, then re-run this.`);
    process.exit(1);
  }

  const ours = path.join(here, "package-lock.json");
  const theirs = path.join(primary, "package-lock.json");
  if (!existsSync(ours) || !existsSync(theirs) || hashOf(ours) !== hashOf(theirs)) {
    console.error(
      "This branch's package-lock.json differs from the main checkout's, so a\n" +
        "shared node_modules would be wrong for one of them. Symlinking here would\n" +
        "mean an install on either side quietly rewrites the other's tree.\n\n" +
        "Run `npm install --include=dev` in this worktree instead.",
    );
    process.exit(1);
  }

  // Relative, so the link survives the whole checkout being moved — which is
  // not hypothetical here: these worktrees live under a path that changes with
  // the Glaze app's data directory.
  const relative = path.relative(here, source);
  try {
    symlinkSync(relative, target, "dir");
  } catch (err) {
    if (existsSync(target)) unlinkSync(target);
    throw err;
  }

  console.log(`ok   linked node_modules -> ${relative}`);
  console.log("     The lockfiles match, so this is the same tree the main checkout resolves.");
  console.log("     If you change dependencies on this branch, replace the link with a real install.");
  console.log("     So does `npm run package`, even with identical dependencies: electron-builder");
  console.log("     cannot walk a symlinked tree and would ship an app that fails every test run.");
  console.log("     `rm node_modules && npm install --include=dev` when you need to package.");
}

main();
