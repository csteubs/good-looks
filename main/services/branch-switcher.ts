// Running the app from another branch, from inside the app.
//
// The problem this solves: reviewing a pull request against this app means
// stopping, stashing, checking out, installing, building, launching, and then
// undoing all of it. That is enough friction that branches get merged on the
// strength of a diff. This turns it into picking a PR from a list.
//
// ── Shape ─────────────────────────────────────────────────────────────────
// `scripts/switch-branch.mjs` does the git and build work (see its header for
// why a worktree rather than a checkout). This module decides whether the
// feature is available at all, spawns that script, streams its progress to the
// renderer, and relaunches Electron onto the result.
//
// ── Why this can only exist in the Electron app ───────────────────────────
// Three separate reasons, and each is a hard stop rather than a degradation:
//
//   • A PACKAGED build has no source and no `.git`. There is nothing to check
//     out and nothing to build with — `devDependencies` are not shipped. The
//     status call says so rather than offering a button that cannot work.
//   • The BROWSER PREVIEW (`npm run dev:web`) has no backend at all: no git, no
//     child processes, no way to relaunch anything. Its fake bridge answers
//     this feature's status call with `available: false` explicitly, so the
//     entry point never renders there.
//   • Relaunching a running application onto a different app directory is an
//     Electron capability. There is no web equivalent to degrade to.
//
// ── What a switch shares with the checkout it came from ───────────────────
// The DATA DIRECTORY, deliberately. A branch build resolves `userData` exactly
// as the checkout does, so it opens the same test library, the same run
// history, the same saved keys. That is what makes it useful for reviewing a
// change — you see the branch's behaviour against your real data — and it is
// also the risk: a branch that migrates a store migrates YOUR store. The view
// says so where the switch happens, which is the only place it can be read in
// time to matter.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { app, logger } from "@shell/backend";

import {
  BRANCH_ARG_PREFIX,
  NO_DEV_URL_ARG,
  branchFromArgv,
  branchNameProblem,
} from "../../shared/branch-paths.mjs";
import type { BranchStatus, BranchSummary, PullRequestSummary, SwitchProgress } from "../../renderer/lib/branch-types.js";
import { listOriginBranches, readRepoInfo } from "./branch-repo.js";
import { listOpenPullRequests } from "./github-prs.js";
import { githubTokenStore } from "./github-token-store.js";
import { sendToMain } from "./app-window.js";

/** Where branch checkouts and their builds live. Under `userData` rather than
 *  beside the repository: the repository is the user's working tree and this
 *  feature must never put anything in it. */
const BUILDS_DIRNAME = "branch-builds";

/** Pushed to the renderer while a switch runs. */
export const PROGRESS_CHANNEL = "branches:progress";

/** Prefix `scripts/switch-branch.mjs` marks its structured events with. */
const EVENT_PREFIX = "##gl-switch##";

/** Build artefacts a directory needs before it can be launched. Mirrors the
 *  script's own list — checked here too, because "return to my checkout" skips
 *  the script entirely when they are already present. */
const BUILD_MARKERS = ["build/main/index.js", "build/main-window.html"];

/** Log lines kept from a build. Enough to diagnose a failure, bounded so a
 *  runaway build cannot grow the renderer's state without limit. */
const MAX_LOG_LINES = 400;

/** One switch at a time. Two concurrent builds would race for the same
 *  worktree and for `npm ci`'s cache, and the second relaunch would fight the
 *  first — with the app quitting underneath both. */
let inFlight: Promise<void> | null = null;

function buildsRoot(): string {
  return path.join(app.getPath("userData"), BUILDS_DIRNAME);
}

function isBuilt(dir: string): boolean {
  return BUILD_MARKERS.every((marker) => fs.existsSync(path.join(dir, marker)));
}

function progress(event: SwitchProgress): void {
  sendToMain(PROGRESS_CHANNEL, event);
}

/**
 * Whether the switcher can run here, and everything the view needs to describe
 * the current state.
 *
 * Never throws: an unavailable feature has to be able to say WHY, and a
 * rejected status call would render as a broken view instead of an explanation.
 *
 * ── `app.isPackaged` DOES NOT MEAN WHAT IT LOOKS LIKE HERE ────────────
 * It used to gate this function, and it made the whole feature unreachable in
 * the one way anybody runs this app from source. Electron decides `isPackaged`
 * from the name of the executable — anything not called `Electron` is
 * "packaged" — and `npm run dev` deliberately runs a BRANDED, RE-SIGNED CLONE
 * of Electron.app called "Good Looks!", because macOS reads the app's name and
 * icon from the bundle (`scripts/dev-app-bundle.mjs`). So a dev run reported
 * itself as packaged and answered with a message telling the user to "Run the
 * app from a checkout (`npm run dev`)" — which is exactly what they had done.
 *
 * It was worse than a hidden sidebar row. `relaunchOnto` relaunches the same
 * binary, so a user who switched onto a branch found the Branches view telling
 * them it was unavailable, with the way back to their own checkout inside it.
 *
 * So availability is now decided by THE THING IT ACTUALLY REQUIRES: whether
 * there is a git repository here to check a branch out of. `readRepoInfo`
 * already answers that, and it answers it correctly for a dev run, for a branch
 * build, and for a shipped `.app` in /Applications, which has no repository
 * above it and so fails exactly as before. `isPackaged` is kept only to pick
 * the WORDING of that failure, where it is right: a packaged build is the one
 * case where "no repository" has a specific, actionable explanation.
 */
export async function status(): Promise<BranchStatus> {
  const hasToken = await githubTokenStore.hasToken().catch(() => false);
  const switchedTo = branchFromArgv(process.argv);

  const appPath = app.getAppPath();
  try {
    const info = await readRepoInfo(appPath);
    return {
      available: true,
      switched: switchedTo !== null,
      hasToken,
      checkout: info.checkout,
      appPath: info.appPath,
      repo: info.repo,
      current: switchedTo ?? info.head,
      // `info.head` is read in the CHECKOUT, so it is the user's own branch
      // whether or not this process is a branch build. `current` loses that
      // when switched, and the branch menu's pinned "return to my checkout"
      // row needs a name it can honestly print.
      checkoutBranch: info.head,
    };
  } catch (err) {
    return {
      available: false,
      switched: switchedTo !== null,
      hasToken,
      // The packaged wording only where it is true. Everywhere else, git's own
      // reason — "git is not installed", "not a repository" — which is the
      // sentence the user can act on.
      reason: app.isPackaged
        ? "This is a packaged build. It ships compiled output with no source, no git repository and no build tooling, so there is nothing here to check a branch out of. Run the app from a checkout (`npm run dev`) to switch branches."
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

/** Open pull requests for `origin`. Throws when the remote isn't GitHub — the
 *  view checks `repo` first, so reaching here without one is a bug worth
 *  hearing about rather than an empty list worth showing. */
export async function pullRequests(): Promise<PullRequestSummary[]> {
  const info = await readRepoInfo(app.getAppPath());
  if (!info.repo) {
    throw new Error("`origin` is not a GitHub remote, so there are no pull requests to list.");
  }
  return listOpenPullRequests(info.repo);
}

export async function branches(refresh: boolean): Promise<BranchSummary[]> {
  const info = await readRepoInfo(app.getAppPath());
  return listOriginBranches(info.checkout, refresh);
}

/**
 * Run `scripts/switch-branch.mjs` and resolve with the directory it prepared.
 *
 * The script comes from the RUNNING app's own directory, not from the primary
 * checkout. They are usually the same file, but not when a branch build is
 * running — and then the right script is the one belonging to the code doing
 * the spawning, since that is the code whose event protocol is being parsed.
 */
function runScript(args: string[]): Promise<string> {
  const script = path.join(app.getAppPath(), "scripts", "switch-branch.mjs");
  if (!fs.existsSync(script)) {
    return Promise.reject(
      new Error(`The branch-switch script is missing from this build (${script}).`),
    );
  }

  return new Promise<string>((resolve, reject) => {
    // process.execPath is the ELECTRON binary, so without this the spawn
    // launches a second copy of the app instead of running the script. This is
    // a hard constraint of the project — see CLAUDE.md.
    const child = spawn(process.execPath, [script, ...args, "--json"], {
      cwd: app.getAppPath(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let appPath: string | null = null;
    let failure: string | null = null;
    const log: string[] = [];

    let outBuffer = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      outBuffer += chunk;
      const lines = outBuffer.split("\n");
      outBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith(EVENT_PREFIX)) continue;
        let event: { phase?: string; message?: string; ok?: boolean; appPath?: string; error?: string };
        try {
          event = JSON.parse(line.slice(EVENT_PREFIX.length));
        } catch {
          continue;
        }
        if (event.ok === true && event.appPath) appPath = event.appPath;
        else if (event.ok === false) failure = event.error ?? "The branch build failed.";
        else if (event.message) progress({ kind: "step", phase: event.phase, message: event.message });
      }
    });

    let errBuffer = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      errBuffer += chunk;
      const lines = errBuffer.split("\n");
      errBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        // Bounded, and it drops the OLDEST lines: a build failure explains
        // itself at the end, so the tail is the part worth keeping.
        log.push(line);
        if (log.length > MAX_LOG_LINES) log.shift();
        progress({ kind: "log", line });
      }
    });

    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (appPath && code === 0) {
        resolve(appPath);
        return;
      }
      // The script's own message when it has one; otherwise the build's last
      // words, which is the only thing that explains an npm failure.
      const tail = log.slice(-12).join("\n");
      const message = failure ?? `The branch build exited with ${code}.`;
      reject(new Error(tail ? `${message}\n\n${tail}` : message));
    });
  });
}

/**
 * Relaunch onto `appPath`.
 *
 * `app.relaunch` rather than spawning a replacement ourselves, because Electron
 * starts the new instance only after this one has exited — two live copies
 * would briefly share one data directory, and the stores here are read-modify-
 * write JSON files with no locking.
 *
 * The consequence is that the new instance inherits this one's ENVIRONMENT,
 * which is why the branch travels in argv instead: under `npm run dev` the
 * inherited `GOOD_LOOKS_DEV_URL` points at a Vite server that dies with this
 * process, and honouring it would open the new build's windows on a dead origin
 * — a blank window with a clean log. `NO_DEV_URL_ARG` is what stops that, and
 * it is passed on EVERY relaunch here, including the one back to the checkout.
 */
function relaunchOnto(appPath: string, branch: string | null): void {
  const args = [appPath, NO_DEV_URL_ARG];
  if (branch) args.push(`${BRANCH_ARG_PREFIX}${branch}`);
  logger.info("branches", "Relaunching onto a different build", { appPath, branch });
  progress({ kind: "done", phase: "launch", message: "Relaunching…" });
  app.relaunch({ args });
  // A beat, so the IPC reply and the final progress event reach the renderer
  // before the window goes away. Quitting synchronously drops both, and the
  // user sees the app vanish mid-build with no indication it succeeded.
  setTimeout(() => app.quit(), 250);
}

/** Build `branch` and relaunch onto it. Resolves at the point the relaunch is
 *  scheduled — the process is gone shortly after. */
export async function switchToBranch(branch: string): Promise<{ appPath: string }> {
  const problem = branchNameProblem(branch);
  if (problem) throw new Error(problem);
  if (inFlight) throw new Error("A branch switch is already running.");

  const state = await status();
  if (!state.available || !state.checkout) {
    throw new Error(state.reason ?? "Branch switching isn't available here.");
  }

  let resolveGate!: () => void;
  inFlight = new Promise<void>((resolve) => (resolveGate = resolve));
  try {
    logger.info("branches", "Switching branch", { branch, checkout: state.checkout });
    const appPath = await runScript([
      "--repo",
      state.checkout,
      "--branch",
      branch,
      "--out",
      buildsRoot(),
    ]);
    relaunchOnto(appPath, branch);
    return { appPath };
  } finally {
    resolveGate();
    inFlight = null;
  }
}

/**
 * Go back to the user's own checkout.
 *
 * Built only when it isn't already: the checkout's `build/` is normally the one
 * the user has been working with, and rebuilding it would overwrite whatever
 * state their editor and dev server are in for no reason. A missing build is
 * different — that happens after a `npm run dev` session, which never writes
 * one — and then it has to be built or the relaunch opens a blank window.
 */
export async function returnToCheckout(): Promise<{ appPath: string }> {
  if (inFlight) throw new Error("A branch switch is already running.");

  const state = await status();
  if (!state.available || !state.checkout) {
    throw new Error(state.reason ?? "Branch switching isn't available here.");
  }

  let resolveGate!: () => void;
  inFlight = new Promise<void>((resolve) => (resolveGate = resolve));
  try {
    if (!isBuilt(state.checkout)) {
      progress({
        kind: "step",
        phase: "build",
        message: "Your checkout has no build yet — building it",
      });
      await runScript(["--repo", state.checkout, "--in-place"]);
    }
    relaunchOnto(state.checkout, null);
    return { appPath: state.checkout };
  } finally {
    resolveGate();
    inFlight = null;
  }
}

export const branchSwitcher = {
  status,
  pullRequests,
  branches,
  switchToBranch,
  returnToCheckout,
  setToken: (token: string): Promise<void> => githubTokenStore.setToken(token),
  clearToken: (): Promise<void> => githubTokenStore.clear(),
};
