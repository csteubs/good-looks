#!/usr/bin/env node
/**
 * Check out a branch into its own worktree and build it, so the app can be
 * relaunched onto it.
 *
 * This is the build/run half of the in-app branch switcher (the UI half is
 * `renderer/main/branches-view.tsx`, driven by `main/services/branch-switcher.ts`).
 * It is deliberately a script rather than inlined into the service: a build that
 * can only be run by clicking a button in the app is a build nobody can debug
 * when it breaks, and this one runs standalone —
 *
 *   node scripts/switch-branch.mjs --repo . --branch main --out /tmp/builds
 *   node scripts/switch-branch.mjs --repo . --in-place
 *
 * ── Why a worktree and not `git checkout` ─────────────────────────────────
 * The obvious implementation switches the user's own checkout to the branch.
 * That is wrong three times over: it discards or blocks on uncommitted work,
 * it changes the files of the very app that is running, and there is then no
 * way back if the branch fails to build. A worktree under the app's data
 * directory leaves the user's checkout untouched, so "go back to my checkout"
 * is always available and never has to undo anything.
 *
 * Every worktree is created DETACHED, at `refs/remotes/origin/<branch>`. A
 * branch can only be checked out in one worktree at a time, so attaching would
 * fail for the branch the user already has open — which is the single most
 * likely branch to want to switch to.
 *
 * ── Dependencies ──────────────────────────────────────────────────────────
 * Same trade as `scripts/bootstrap-worktree.mjs`: when the lockfiles match, the
 * whole tree is one symlink away instead of a multi-minute install. When they
 * differ, sharing would mean an install on one side silently rewriting the
 * other's tree — so this installs for real. bootstrap-worktree REFUSES at that
 * point and tells a human to install; this one cannot, because there is no
 * human at a prompt, so the divergent case just costs an `npm ci`.
 *
 * ── Output ────────────────────────────────────────────────────────────────
 * Structured events on stdout, one JSON object per line behind a sentinel, so
 * the caller can read progress without parsing build chatter. Everything the
 * child processes print goes to stderr, which the app shows as a build log.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { branchNameProblem, worktreeDirFor } from "../shared/branch-paths.mjs";

/** Prefix that marks a structured event on stdout. Anything without it is
 *  noise, so a stray `console.log` in a dependency cannot be read as progress. */
const EVENT = "##gl-switch##";

/** Build artefacts that have to exist for a directory to be launchable. If
 *  either is missing, Electron opens a window on nothing and logs nothing —
 *  the blank-window failure mode this repo has hit before. */
const BUILD_MARKERS = ["build/main/index.js", "build/main-window.html"];

const json = process.argv.includes("--json");

/** @param {Record<string, unknown>} event */
function emit(event) {
  if (json) process.stdout.write(EVENT + JSON.stringify(event) + "\n");
  else process.stderr.write(`[switch] ${event.message ?? JSON.stringify(event)}\n`);
}

/** @param {string} phase @param {string} message */
function step(phase, message) {
  emit({ phase, message });
}

/**
 * Read `--name value` out of argv. Returns undefined when absent.
 * @param {string} name
 * @returns {string | undefined}
 */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Run a command, streaming its output to stderr, and resolve when it exits 0.
 *
 * ELECTRON_RUN_AS_NODE is stripped from the child's environment. This script is
 * normally spawned BY the Electron main process with that flag set (it must be,
 * or `process.execPath` launches a second copy of the app), and it is inherited
 * — so `npm`, whose shim runs `env node`, would hand it to a real node that has
 * no idea what it means. Harmless today, and exactly the sort of inherited flag
 * that produces an inexplicable failure two layers down.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<void>}
 */
function run(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    // Both streams to OUR stderr: stdout is the structured channel and must
    // stay parseable.
    child.stdout.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (err) => {
      if (/** @type {{ code?: string }} */ (err).code === "ENOENT") {
        reject(
          new Error(
            `\`${file}\` is not installed or not on PATH. The app inherits the PATH it was launched with, so launching it from a terminal (\`npm run dev\`) is usually the fix.`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${file} ${args[0] ?? ""} exited with ${code}`)),
    );
  });
}

/** @param {string} file */
function hashOf(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
}

/**
 * Give `worktree` a node_modules — by symlink when the lockfiles agree, by
 * install when they don't.
 *
 * @param {string} primary
 * @param {string} worktree
 */
async function ensureDependencies(primary, worktree) {
  const target = path.join(worktree, "node_modules");
  const source = path.join(primary, "node_modules");
  const ours = path.join(worktree, "package-lock.json");
  const theirs = path.join(primary, "package-lock.json");

  const shareable =
    existsSync(source) &&
    existsSync(ours) &&
    existsSync(theirs) &&
    hashOf(ours) === hashOf(theirs);

  if (existsSync(target)) {
    const isLink = lstatSync(target).isSymbolicLink();
    // A LINK that is no longer shareable is actively wrong: this branch's
    // lockfile has moved on and the tree it points at belongs to another
    // branch. A real directory is left alone — it was installed for this
    // worktree, and re-installing on every switch would undo the whole point.
    if (!isLink || shareable) {
      step("deps", "Dependencies already in place");
      return;
    }
    step("deps", "This branch's lockfile has diverged — replacing the shared link");
    rmSync(target, { force: true });
  }

  if (shareable) {
    // Relative, so the link survives the whole tree being moved — not
    // hypothetical, since these live under the app's data directory.
    symlinkSync(path.relative(worktree, source), target, "dir");
    step("deps", "Linked the shared node_modules (lockfiles match)");
    return;
  }

  step("deps", "This branch's dependencies differ — installing (this takes a few minutes)");
  await run("npm", ["ci", "--include=dev"], worktree);
}

/**
 * @param {string} primary
 * @param {string} branch
 * @param {string} out
 * @returns {Promise<string>} the directory the branch is checked out in
 */
async function prepareWorktree(primary, branch, out) {
  const dir = worktreeDirFor(out, branch);
  const ref = `refs/remotes/origin/${branch}`;

  step("fetch", `Fetching origin/${branch}`);
  // An explicit refspec rather than `git fetch origin <branch>`: it guarantees
  // the remote-tracking ref below exists afterwards, and it leaves no room for
  // the name to be read as anything but a ref.
  await run("git", ["fetch", "origin", `+refs/heads/${branch}:${ref}`], primary);

  mkdirSync(out, { recursive: true });
  // Worktrees whose directories were deleted by hand are still registered, and
  // a stale registration makes `worktree add` refuse the path.
  await run("git", ["worktree", "prune"], primary);

  if (existsSync(path.join(dir, ".git"))) {
    step("worktree", "Updating the existing checkout for this branch");
    await run("git", ["checkout", "--detach", "--force", ref], dir);
    await run("git", ["reset", "--hard", ref], dir);
  } else {
    step("worktree", `Creating a checkout at ${dir}`);
    // --detach: a branch can only be attached in one worktree, and the branch
    // you most want to switch to is often the one already open elsewhere.
    await run("git", ["worktree", "add", "--detach", "--force", dir, ref], primary);
  }
  return dir;
}

/** @param {string} dir */
async function build(dir) {
  step("build", "Building the renderer and main process");
  // The BRANCH's own build script, not this one's. That is the point: a branch
  // that changed how it builds must be built its way, or what gets launched is
  // not what the branch says it is.
  await run("npm", ["run", "build"], dir);

  const missing = BUILD_MARKERS.filter((m) => !existsSync(path.join(dir, m)));
  if (missing.length > 0) {
    // `npm run build` exiting 0 without producing these has happened (a renderer
    // config change that emitted elsewhere). Launching anyway gives a blank
    // window and a clean log, which is the hardest failure in this app to read.
    throw new Error(
      `The build reported success but did not produce ${missing.join(", ")}. Refusing to launch a build that would open a blank window.`,
    );
  }
}

async function main() {
  const primary = path.resolve(arg("repo") ?? process.cwd());
  const inPlace = process.argv.includes("--in-place");
  const branch = arg("branch");
  const out = arg("out");

  if (inPlace) {
    step("build", `Building ${primary}`);
    await build(primary);
    emit({ ok: true, appPath: primary });
    return;
  }

  if (!branch) throw new Error("--branch is required (or pass --in-place).");
  if (!out) throw new Error("--out is required: the directory branch builds live in.");
  const problem = branchNameProblem(branch);
  if (problem) throw new Error(problem);

  const dir = await prepareWorktree(primary, branch, out);
  await ensureDependencies(primary, dir);
  await build(dir);
  emit({ ok: true, appPath: dir });
}

main().catch((err) => {
  emit({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
