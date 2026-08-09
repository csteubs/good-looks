// Reading the git repository the running app was built from.
//
// Everything here shells out to `git` with execFile (no shell, so nothing a ref
// name contains can become a command) and answers questions about the checkout.
// It never writes: creating worktrees and building them is
// `scripts/switch-branch.mjs`'s job, spawned from `branch-switcher.ts`.
//
// ── "The checkout" is always the PRIMARY worktree ──────────────────────────
// Once you have switched onto a branch, the running app's own directory IS a
// git worktree under the app's data directory. Every operation still has to
// happen in the user's real checkout: it is the one with a `node_modules` to
// share, and it is where the other branch builds are registered. `git worktree
// list` reports the primary checkout first from anywhere in the repository,
// which makes "how do I get home" answerable from state on disk rather than
// from something we have to remember to persist.

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

import { logger } from "@shell/backend";

import { parseGitHubRemote, type RepoRef } from "../../shared/branch-paths.mjs";
import type { BranchSummary } from "../../renderer/lib/branch-types.js";

export type { BranchSummary };

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 20_000;

export interface RepoInfo {
  /** The primary checkout — where builds are driven from. */
  checkout: string;
  /** The directory the running app was loaded from. Equals `checkout` unless
   *  this process is running a branch build. */
  appPath: string;
  /** `origin` as GitHub owner/repo, or null when it isn't a GitHub remote. */
  repo: RepoRef | null;
  /** The checkout's current branch, or a short sha when it's detached. */
  head: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

/** Turn a git failure into the sentence a user can act on. `git` missing
 *  entirely and "this isn't a repository" are the two that actually happen, and
 *  they need completely different fixes. */
function describeGitFailure(err: unknown): string {
  const e = err as { code?: string; stderr?: string };
  if (e?.code === "ENOENT") {
    return "git is not installed or not on PATH. Install Xcode Command Line Tools or Git, then try again.";
  }
  const detail = (e?.stderr || "").trim().split("\n").pop();
  return detail || String(err);
}

/**
 * Locate the repository behind `appPath`, or throw with a reason worth showing.
 *
 * `git worktree list --porcelain` reports the primary checkout first — the same
 * fact `scripts/bootstrap-worktree.mjs` leans on — so this resolves the home
 * checkout whether it is called from there or from a branch build.
 */
export async function readRepoInfo(appPath: string): Promise<RepoInfo> {
  let checkout: string;
  try {
    const first = (await git(appPath, ["worktree", "list", "--porcelain"])).split("\n")[0] ?? "";
    if (!first.startsWith("worktree ")) {
      throw new Error(`Unexpected output from git worktree list: ${first.slice(0, 80)}`);
    }
    checkout = path.resolve(first.slice("worktree ".length).trim());
  } catch (err) {
    throw new Error(describeGitFailure(err));
  }

  // A missing `origin` is not fatal: local branches still switch, there are
  // just no pull requests to list.
  let repo: RepoRef | null = null;
  try {
    repo = parseGitHubRemote(await git(checkout, ["remote", "get-url", "origin"]));
  } catch {
    repo = null;
  }

  let head = "";
  try {
    head = await git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head === "HEAD") head = (await git(checkout, ["rev-parse", "--short", "HEAD"])) || "detached";
  } catch {
    head = "unknown";
  }

  return { checkout, appPath: path.resolve(appPath), repo, head };
}

/**
 * Every branch on `origin`, newest commit first.
 *
 * Read from the local remote-tracking refs rather than `git ls-remote`: no
 * network, and it is the same set `git fetch` last saw — which is exactly what
 * a switch will be able to build. `refresh` fetches first, for when a branch
 * was pushed after this checkout last synced.
 */
export async function listOriginBranches(checkout: string, refresh = false): Promise<BranchSummary[]> {
  if (refresh) {
    try {
      await git(checkout, ["fetch", "--prune", "origin"]);
    } catch (err) {
      // A failed fetch means a stale list, not no list. Say so in the log and
      // answer with what is already on disk.
      logger.warn("branches", "Could not fetch origin before listing branches", {
        err: describeGitFailure(err),
      });
    }
  }

  let raw: string;
  try {
    raw = await git(checkout, [
      "for-each-ref",
      "--format=%(refname:strip=3)%09%(committerdate:unix)%09%(contents:subject)",
      "refs/remotes/origin",
    ]);
  } catch (err) {
    throw new Error(describeGitFailure(err));
  }

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, unix, ...rest] = line.split("\t");
      return { name, updatedAt: Number(unix) * 1000 || 0, subject: rest.join("\t") };
    })
    // `origin/HEAD` is a symbolic ref, not a branch; offering it would switch
    // to whatever it points at under a name that means nothing.
    .filter((b) => b.name && b.name !== "HEAD")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
