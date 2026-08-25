// The CLI's exit-code mapping and its argument rules (R2, R3).
//
// Lives under `main/` rather than beside `cli/` for the reason
// `run-pacing.test.ts` and `branch-paths.test.ts` both give: vitest's node
// project takes `main/**`, `mcp/**` and `renderer/lib/**`, so a test file under
// `cli/` would match NEITHER project and pass by never running. That trap has
// already cost this repo a silently-unrun suite once.
//
// The end-to-end half is `check:cli-exit`, which spawns the real binary. This
// half is what makes exit 0 and exit 1 testable at all: those need a browser
// and a real run, so the only place they can be asserted is against the pure
// mapping.

import { describe, it, expect } from "vitest";

import { EXIT, EXIT_MEANINGS, exitCodeFor } from "../../cli/exit.mjs";
import { parseRunArgs } from "../../cli/args.mjs";
import { refusalMessage } from "../../cli/run.mjs";

/** A `{ok:true}` outcome with the summary counts under test. Only `summary`
 *  decides the code, so the rest is whatever `runSelection` would have put
 *  there. */
function ran(summary: { passed: number; failed: number; skipped?: number }) {
  return {
    ok: true as const,
    batchId: "b1",
    browser: "chromium",
    parallel: 1,
    missing: [],
    fixturesSkipped: [],
    results: [],
    summary: { skipped: 0, durationMs: 0, ...summary },
  };
}

describe("exitCodeFor", () => {
  it("is 0 only when tests ran and none failed", () => {
    expect(exitCodeFor(ran({ passed: 3, failed: 0 }))).toBe(EXIT.PASSED);
  });

  it("is 1 when any test failed", () => {
    expect(exitCodeFor(ran({ passed: 2, failed: 1 }))).toBe(EXIT.FAILED);
  });

  it("is 2 when the selector matched nothing", () => {
    // The code the whole contract exists for. A suite of zero is not a pass:
    // its summary is shaped exactly like one, so without this number a renamed
    // selector leaves a pipeline green while testing nothing, indefinitely.
    expect(exitCodeFor({ ok: false, reason: "no-match", how: 'tag "smoke"' })).toBe(EXIT.NO_MATCH);
  });

  it("is 3 for every reason the run could not start", () => {
    for (const reason of ["unknown-browser", "no-playwright", "no-browser"]) {
      expect(exitCodeFor({ ok: false, reason })).toBe(EXIT.CANNOT_START);
    }
  });

  it("does not fail the run for a skipped test", () => {
    // A test skipped for declaring secret variables is a run this process could
    // not do, not a test that is red. Counting it as a failure would make one
    // secret-bearing test enough to redden every suite it sits in — so the
    // command says so in words instead.
    expect(exitCodeFor(ran({ passed: 1, failed: 0, skipped: 2 }))).toBe(EXIT.PASSED);
  });

  it("never reports an unrecognised outcome as a pass", () => {
    // The one mistake this file exists to make impossible. A reason added to
    // `runSelection` and not mapped here must not inherit 0 — nothing ran.
    expect(exitCodeFor({ ok: false, reason: "something-new" })).toBe(EXIT.CANNOT_START);
    expect(exitCodeFor(undefined)).toBe(EXIT.CANNOT_START);
    expect(exitCodeFor({})).toBe(EXIT.CANNOT_START);
  });

  it("documents every code it can return", () => {
    // The published table and the implemented one are the same object, so a
    // fifth code cannot ship undocumented.
    const documented = new Set(EXIT_MEANINGS.map(([code]) => code));
    for (const code of Object.values(EXIT)) expect(documented.has(code)).toBe(true);
  });
});

describe("refusalMessage", () => {
  it("names the selector that actually applied", () => {
    // The commonest cause of an empty selection is a selector that has gone
    // stale, and "no tests matched" without saying what was asked for sends
    // people to read the tests.
    expect(refusalMessage({ ok: false, reason: "no-match", how: 'tag "smoke"' })).toContain(
      'tag "smoke"',
    );
  });

  it("says an empty selection is deliberately not a pass", () => {
    const msg = refusalMessage({ ok: false, reason: "no-match", how: "the library" });
    expect(msg).toContain(String(EXIT.NO_MATCH));
  });

  it("tells someone with no browser what to do about it", () => {
    expect(refusalMessage({ ok: false, reason: "no-browser", browser: "webkit" })).toContain(
      "webkit",
    );
  });

  it("still says something for a reason it does not know", () => {
    // A CLI's last act should be a sentence, not a thrown error that a pipeline
    // reads as "a test failed".
    expect(refusalMessage({ ok: false, reason: "future-reason" })).toContain("could not start");
  });
});

describe("parseRunArgs", () => {
  it("takes one selector and the run options", () => {
    const parsed = parseRunArgs(["--tag", "smoke", "--browser", "firefox", "--parallel", "4"]);
    expect(parsed).toMatchObject({
      ok: true,
      options: { tag: "smoke", browser: "firefox", parallel: 4 },
    });
  });

  it("keeps repeated --id in the order given", () => {
    // `selectTests` runs explicit ids in the order given, so the typing order is
    // meaningful and must not be sorted or deduped on the way through.
    const parsed = parseRunArgs(["--id", "b", "--id", "a", "--id", "b"]);
    expect((parsed as { options: { testIds: string[] } }).options.testIds).toEqual(["b", "a", "b"]);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    // THE rule this parser exists for. A pipeline passing `--fail-fast` to a
    // build that does not have it must not run the suite anyway and report
    // green: the operator asked for behaviour they did not get.
    expect(parseRunArgs(["--all", "--fail-fast"])).toMatchObject({ ok: false });
  });

  it("refuses a value flag whose value is the next flag", () => {
    // `--tag --json` would otherwise select the tag "--json", match nothing,
    // and read as an empty library rather than as a typo.
    expect(parseRunArgs(["--tag", "--json"])).toMatchObject({ ok: false });
  });

  it("refuses a bare positional argument", () => {
    // `good-looks run smoke` looks like it selects a tag and does not.
    expect(parseRunArgs(["smoke"])).toMatchObject({ ok: false });
  });

  it("has no default selector", () => {
    // Deliberately unlike the MCP's run_batch, which runs everything visible
    // when given nothing. A misspelt flag reaching that default would run the
    // whole library on a CI runner instead of the four tests that were meant.
    expect(parseRunArgs([])).toMatchObject({ ok: false });
    expect(parseRunArgs(["--json"])).toMatchObject({ ok: false });
  });

  it("refuses two selectors instead of silently preferring one", () => {
    // `selectTests` HAS a precedence, so this would run something — just not
    // necessarily what someone who wrote both flags expected, and they would
    // never find out.
    const parsed = parseRunArgs(["--tag", "smoke", "--all"]);
    expect(parsed).toMatchObject({ ok: false });
    expect((parsed as { error: string }).error).toContain("--tag");
    expect((parsed as { error: string }).error).toContain("--all");
  });

  it("refuses an unrecognised speed rather than silently ignoring it", () => {
    // `resolveRunSpeed` skips an unknown value, which is right there — a stale
    // or hostile one must not reach the delay table. But here it would mean the
    // run went at a pace nobody chose after someone explicitly asked for one.
    expect(parseRunArgs(["--all", "--speed", "turbo"])).toMatchObject({ ok: false });
    expect(parseRunArgs(["--all", "--speed", "crawl"])).toMatchObject({ ok: true });
  });

  it("refuses a --parallel that is not a whole number in range", () => {
    for (const bad of ["0", "2.5", "eight", "-1", "999"]) {
      expect(parseRunArgs(["--all", "--parallel", bad])).toMatchObject({ ok: false });
    }
    expect(parseRunArgs(["--all", "--parallel", "1"])).toMatchObject({ ok: true });
  });

  it("refuses an unknown browser at parse time", () => {
    // Before anything is selected or spawned, so the message names the choices
    // rather than arriving from inside Playwright.
    expect(parseRunArgs(["--all", "--browser", "safari"])).toMatchObject({ ok: false });
  });

  it("treats --help as a request rather than an error", () => {
    expect(parseRunArgs(["--help"])).toEqual({ ok: "help" });
    // Even alongside an otherwise-invalid line: someone reaching for --help is
    // asking what the flags are, which is exactly what they should get.
    expect(parseRunArgs(["--fail-fast", "--help"])).toEqual({ ok: "help" });
  });
});
