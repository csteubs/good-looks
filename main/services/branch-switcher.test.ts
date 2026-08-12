// The branch switcher's gate, and what it refuses to do.
//
// Nothing here builds or relaunches anything: the stub records a relaunch
// instead of performing one (see shell-backend-stub.ts), so "did it get as far
// as scheduling a relaunch" is observable without a second Electron process.
// What is worth pinning is the set of decisions made BEFORE any of that —
// whether the feature is offered at all, and what it does with a name it should
// never build.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  relaunchCalls,
  resetLaunchState,
  setAppPath,
  setPackaged,
} from "./__tests__/shell-backend-stub.js";
import { status, switchToBranch } from "./branch-switcher.js";

/** A throwaway git repository, so the repo-shaped assertions don't depend on
 *  where the suite happens to be run from. */
function makeRepo(remote: string | null): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gl-branch-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  git("add", "-A");
  git("commit", "-m", "first");
  if (remote) git("remote", "add", "origin", remote);
  return dir;
}

let userData: string;
const created: string[] = [];

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "gl-branch-data-"));
  process.env.GLAZE_TEST_USERDATA = userData;
  resetLaunchState();
});

afterEach(() => {
  resetLaunchState();
  delete process.env.GLAZE_TEST_USERDATA;
  for (const dir of [...created, userData]) fs.rmSync(dir, { recursive: true, force: true });
  created.length = 0;
});

function repo(remote: string | null): string {
  const dir = makeRepo(remote);
  created.push(dir);
  setAppPath(dir);
  return dir;
}

describe("availability", () => {
  it("is unavailable in a packaged build, and says why", () => {
    // The important half is that it does not THROW. The view renders the reason
    // it gets back; a rejected status call renders as a broken view instead of
    // an explanation, which is the failure this feature can least afford —
    // "branch switching is broken" and "branch switching cannot work here" look
    // identical from a blank pane.
    //
    // The setup names what "packaged" means rather than relying on the flag
    // alone: a shipped `.app` has no repository above it, and that — not the
    // flag — is now what makes the feature unavailable. `isPackaged` picks the
    // WORDING, which is the one thing it is reliable for.
    setPackaged(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-packaged-"));
    created.push(dir);
    setAppPath(dir);

    return status().then((result) => {
      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/packaged/i);
    });
  });

  it("is available in a checkout even when Electron calls the build packaged", async () => {
    // THE REGRESSION. `app.isPackaged` is not "was this shipped" — Electron
    // derives it from the executable's NAME, and `npm run dev` runs a branded,
    // re-signed clone of Electron.app called "Good Looks!" so that macOS shows
    // the right name and icon (scripts/dev-app-bundle.mjs). Every dev run
    // therefore reported itself as packaged, and the whole feature answered
    // with a message telling the user to run it from a checkout — which is
    // what they had just done.
    //
    // Worse than a hidden sidebar row: `relaunchOnto` relaunches the same
    // binary, so switching onto a branch left the user with a Branches view
    // saying it was unavailable, and the way back to their own checkout was
    // inside it.
    setPackaged(true);
    const dir = repo("https://github.com/csteubs/good-looks.git");

    const result = await status();
    expect(result.available).toBe(true);
    expect(result.checkout).toBe(dir);
  });

  it("gives git's own reason, not the packaged one, when not packaged", async () => {
    // "not a git repository" is the sentence a developer can act on. Answering
    // "this is a packaged build" to a checkout with a broken .git sends them
    // looking for a problem they do not have.
    setPackaged(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-not-a-repo-2-"));
    created.push(dir);
    setAppPath(dir);

    const result = await status();
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason).not.toMatch(/packaged/i);
  });

  it("is unavailable outside a git repository, and says why", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-not-a-repo-"));
    created.push(dir);
    setAppPath(dir);

    const result = await status();
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("is available in a checkout, and reports where home is", async () => {
    const dir = repo("https://github.com/csteubs/good-looks.git");

    const result = await status();
    expect(result.available).toBe(true);
    expect(result.checkout).toBe(dir);
    expect(result.current).toBe("main");
    expect(result.repo).toEqual({ owner: "csteubs", name: "good-looks" });
    // Nothing was relaunched by asking.
    expect(relaunchCalls()).toEqual([]);
  });

  it("stays available when origin isn't GitHub — there are just no PRs", async () => {
    // Branch switching is a git operation; pull requests are a GitHub one.
    // Conflating them would disable the whole feature for a self-hosted remote.
    repo("https://gitlab.com/o/r.git");

    const result = await status();
    expect(result.available).toBe(true);
    expect(result.repo).toBeNull();
  });

  it("never reports the saved token, only whether one exists", async () => {
    repo("https://github.com/csteubs/good-looks.git");

    const result = await status();
    expect(result.hasToken).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/ghp_/);
  });
});

describe("refusing a branch", () => {
  it("rejects a name git would read as an option, before spawning anything", async () => {
    repo("https://github.com/csteubs/good-looks.git");

    await expect(switchToBranch("--upload-pack=touch /tmp/pwned")).rejects.toThrow(/option/);
    // The point of "before": a rejection that happened after the build would
    // still have run the build.
    expect(relaunchCalls()).toEqual([]);
    expect(fs.existsSync(path.join(userData, "branch-builds"))).toBe(false);
  });

  it("rejects a name that would escape the builds directory", async () => {
    repo("https://github.com/csteubs/good-looks.git");

    await expect(switchToBranch("../../../../tmp/evil")).rejects.toThrow();
    expect(fs.existsSync(path.join(userData, "branch-builds"))).toBe(false);
  });

  it("refuses to switch at all when the feature is unavailable", async () => {
    // The app path has to be somewhere with no repository. It used to be enough
    // to set `packaged`, but that only worked because the stub's default app
    // path is this project — a real checkout — and the old `isPackaged`
    // short-circuit returned before anything looked at it. With availability
    // decided by whether a repository is actually there, a "packaged" build
    // sitting in a checkout is available, so the setup now has to say what it
    // means.
    setPackaged(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-no-repo-switch-"));
    created.push(dir);
    setAppPath(dir);

    await expect(switchToBranch("main")).rejects.toThrow(/packaged/i);
    expect(relaunchCalls()).toEqual([]);
  });
});
