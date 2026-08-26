/**
 * Where a run came from (R6).
 *
 * Here rather than beside the module because `shared/` matches neither Vitest
 * project — the node project takes `main/**`, `mcp/**` and `renderer/lib/**`,
 * and a `.test.ts` under `shared/` would be silently never run. Same placement
 * as `run-trigger.test.ts` next door, and for the same reason.
 *
 * The subject is a GUARD, so most of these are refusals. The one that matters
 * most is not "does it reject a hostile value" but "does rejecting one field
 * cost the others" — a run whose branch name is a payload still has a real
 * commit sha, and dropping it would be this guard destroying the evidence it
 * exists to protect.
 */
import { describe, expect, it } from "vitest";

import {
  PROVENANCE_MAX_TEXT,
  PROVENANCE_MAX_URL,
  normalizeRunProvenance,
  readRunProvenance,
} from "../../shared/run-provenance.mjs";

describe("normalizeRunProvenance", () => {
  it("keeps a well-formed record whole", () => {
    expect(
      normalizeRunProvenance({
        revision: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
        branch: "feat/run-provenance",
        repositoryUrl: "https://github.com/csteubs/good-looks",
        jobUrl: "https://github.com/csteubs/good-looks/actions/runs/123",
      }),
    ).toEqual({
      revision: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
      branch: "feat/run-provenance",
      repositoryUrl: "https://github.com/csteubs/good-looks",
      jobUrl: "https://github.com/csteubs/good-looks/actions/runs/123",
    });
  });

  it("returns undefined rather than an empty object when nothing survives", () => {
    // `{}` would be a provenance the run does not have: every consumer testing
    // `if (run.provenance)` would render an empty panel for a run that was
    // never attributed. "No provenance" gets ONE spelling.
    expect(normalizeRunProvenance({})).toBeUndefined();
    expect(normalizeRunProvenance({ revision: "   " })).toBeUndefined();
    expect(normalizeRunProvenance({ revision: 7, branch: null })).toBeUndefined();
  });

  it("refuses anything that is not a plain object", () => {
    // The value arrives from a JSON store the app reads through a cast and from
    // a second process's writes, so "an object" is an assumption, not a type.
    for (const bad of [null, undefined, 7, "abc", true, [], [{ revision: "a" }]]) {
      expect(normalizeRunProvenance(bad)).toBeUndefined();
    }
  });

  it("drops a hostile field WITHOUT dropping its neighbours", () => {
    // The property this guard is really for. A fork's pull request names its
    // own branch, so the branch is the field most likely to be a payload — and
    // the run's commit is the field a person most needs when it is.
    const out = normalizeRunProvenance({
      revision: "9f2c1ab",
      branch: "x".repeat(PROVENANCE_MAX_TEXT + 1),
      repositoryUrl: "javascript:alert(1)",
      jobUrl: "https://github.com/csteubs/good-looks/actions/runs/123",
    });
    expect(out).toEqual({
      revision: "9f2c1ab",
      jobUrl: "https://github.com/csteubs/good-looks/actions/runs/123",
    });
  });

  it("REJECTS an over-long value instead of truncating it", () => {
    // The whole argument for the rule. A truncated sha is a shorter value of
    // the right shape — it names a different commit, or none, and reads as a
    // real answer to everything downstream. Absent says "unknown", which is
    // true. So the boundary is asserted on both sides, and the over-long case
    // must be ABSENT rather than a prefix of the input.
    const atCap = "a".repeat(PROVENANCE_MAX_TEXT);
    expect(normalizeRunProvenance({ revision: atCap })).toEqual({ revision: atCap });

    const overCap = "a".repeat(PROVENANCE_MAX_TEXT + 1);
    const out = normalizeRunProvenance({ revision: overCap });
    expect(out).toBeUndefined();
    // Belt and braces: no truncated survivor under any key.
    expect(JSON.stringify(out ?? {})).not.toContain("aaa");
  });

  it("rejects a control character rather than stripping it", () => {
    // These land in a JSON store, in log lines and in an emitted report. A
    // newline inside a "revision" is a fabricated second line; stripping it
    // would invent a value the environment never reported.
    const nl = String.fromCharCode(10);
    const nul = String.fromCharCode(0);
    const del = String.fromCharCode(127);
    expect(normalizeRunProvenance({ revision: `abc${nl}def` })).toBeUndefined();
    expect(normalizeRunProvenance({ branch: `main${nul}` })).toBeUndefined();
    expect(normalizeRunProvenance({ branch: `main${del}` })).toBeUndefined();
  });

  it("trims, and measures the cap against the trimmed value", () => {
    expect(normalizeRunProvenance({ branch: "  main  " })).toEqual({ branch: "main" });
    // Whitespace an environment added must not cost a legitimate value its
    // place at the boundary.
    const padded = `  ${"a".repeat(PROVENANCE_MAX_TEXT)}  `;
    expect(normalizeRunProvenance({ revision: padded })?.revision).toHaveLength(
      PROVENANCE_MAX_TEXT,
    );
  });

  it("admits only http and https URLs", () => {
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "app://index.html",
      "data:text/html,<script>",
      "not a url",
      // An un-interpolated variable reference would otherwise resolve as a
      // literal hostname — the same refusal the base-URL gate makes.
      "https://${HOST}/repo",
    ]) {
      expect(normalizeRunProvenance({ repositoryUrl: bad })).toBeUndefined();
      expect(normalizeRunProvenance({ jobUrl: bad })).toBeUndefined();
    }
  });

  it("refuses a URL past the length cap", () => {
    const long = `https://example.com/${"a".repeat(PROVENANCE_MAX_URL)}`;
    expect(normalizeRunProvenance({ jobUrl: long })).toBeUndefined();
  });

  it("stores the PARSED href, so one job URL cannot read as two", () => {
    expect(
      normalizeRunProvenance({ repositoryUrl: "HTTPS://GitHub.com/csteubs/good-looks" })
        ?.repositoryUrl,
    ).toBe("https://github.com/csteubs/good-looks");
  });

  it("carries no key the caller invented", () => {
    // REBUILDS rather than filters, like every other boundary in this repo: a
    // spread would carry the next unknown key straight into the store.
    const out = normalizeRunProvenance({
      revision: "9f2c1ab",
      ...{ actor: "someone", token: "hunter2" },
    });
    expect(out).toEqual({ revision: "9f2c1ab" });
  });
});

describe("readRunProvenance", () => {
  it("says nothing when the environment says nothing", () => {
    // The laptop case, and the common one. Absent is honest; a fabricated
    // "local" would be evidence nobody can distinguish from a real answer.
    expect(readRunProvenance({})).toBeUndefined();
    expect(readRunProvenance({ PATH: "/usr/bin", HOME: "/home/someone" })).toBeUndefined();
  });

  it("reads a GitHub Actions push build", () => {
    expect(
      readRunProvenance({
        GITHUB_SHA: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
        GITHUB_REF_NAME: "main",
        // Set and EMPTY on a push run — see the next test.
        GITHUB_HEAD_REF: "",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "csteubs/good-looks",
        GITHUB_RUN_ID: "32937507630",
      }),
    ).toEqual({
      revision: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
      branch: "main",
      repositoryUrl: "https://github.com/csteubs/good-looks",
      jobUrl: "https://github.com/csteubs/good-looks/actions/runs/32937507630",
    });
  });

  it("takes REF_NAME when HEAD_REF is set-but-empty", () => {
    // The trap this is written against, and it is a real GitHub behaviour
    // rather than a hypothetical: `GITHUB_HEAD_REF` is defined and empty on a
    // push run. `??` only skips null and undefined, so the obvious spelling
    // picks the empty string and every push build records no branch — while
    // pull-request builds, the ones this gets tested on, work perfectly.
    expect(readRunProvenance({ GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "main" })?.branch).toBe(
      "main",
    );
  });

  it("prefers HEAD_REF on a pull request, because REF_NAME names no branch", () => {
    // `GITHUB_REF_NAME` is `42/merge` there — the synthetic merge ref, which
    // nobody can check out.
    expect(
      readRunProvenance({ GITHUB_HEAD_REF: "feat/thing", GITHUB_REF_NAME: "42/merge" })?.branch,
    ).toBe("feat/thing");
  });

  it("lets GOOD_LOOKS_* win, per field", () => {
    // Explicit beats derived — the same precedence `--var` has over a dataset
    // row. Per field, so a pipeline can correct the one value its provider
    // reports uselessly without restating the other three.
    const out = readRunProvenance({
      GITHUB_SHA: "aaaaaaa",
      GITHUB_REF_NAME: "main",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "csteubs/good-looks",
      GITHUB_RUN_ID: "1",
      GOOD_LOOKS_BRANCH: "release/2026-08",
    });
    expect(out?.branch).toBe("release/2026-08");
    expect(out?.revision).toBe("aaaaaaa");
    expect(out?.jobUrl).toBe("https://github.com/csteubs/good-looks/actions/runs/1");
  });

  it("serves a non-GitHub CI entirely through GOOD_LOOKS_*", () => {
    // The documented contract for every other provider, and the reason this
    // reads one generic set of names rather than a table of each provider's
    // spelling — a table whose wrong rows are silent everywhere but the one
    // provider its author used.
    expect(
      readRunProvenance({
        GOOD_LOOKS_REVISION: "c0ffee1",
        GOOD_LOOKS_BRANCH: "trunk",
        GOOD_LOOKS_REPOSITORY_URL: "https://gitlab.example.com/team/app",
        GOOD_LOOKS_JOB_URL: "https://gitlab.example.com/team/app/-/jobs/99",
      }),
    ).toEqual({
      revision: "c0ffee1",
      branch: "trunk",
      repositoryUrl: "https://gitlab.example.com/team/app",
      jobUrl: "https://gitlab.example.com/team/app/-/jobs/99",
    });
  });

  it("builds no job URL without a run id, and no repository URL without both halves", () => {
    // A half-built URL would be a link that goes somewhere wrong, which is
    // worse than no link.
    const noRun = readRunProvenance({
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "csteubs/good-looks",
    });
    expect(noRun).toEqual({ repositoryUrl: "https://github.com/csteubs/good-looks" });

    const noServer = readRunProvenance({
      GITHUB_REPOSITORY: "csteubs/good-looks",
      GITHUB_RUN_ID: "1",
    });
    expect(noServer).toBeUndefined();
  });

  it("passes its own derived values through the same gate", () => {
    // The structural property: `readRunProvenance` does not trust what it just
    // built. A hostile GITHUB_SERVER_URL is a URL like any other.
    expect(
      readRunProvenance({
        GITHUB_SERVER_URL: "javascript:alert(1)//",
        GITHUB_REPOSITORY: "csteubs/good-looks",
        GITHUB_RUN_ID: "1",
        GITHUB_SHA: "9f2c1ab",
      }),
    ).toEqual({ revision: "9f2c1ab" });
  });

  it("survives a missing environment object", () => {
    // `process.env` is always there, but a caller passing an isolated env can
    // pass nothing, and a throw here would take down a run.
    expect(
      readRunProvenance(undefined as unknown as Record<string, string | undefined>),
    ).toBeUndefined();
  });
});
