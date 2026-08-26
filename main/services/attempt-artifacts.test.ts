// Where one attempt's evidence goes (R24a).
//
// Under `main/services/` rather than beside the module: vitest's node project
// takes `main/**`, `mcp/**` and `renderer/lib/**`, so a test file in `shared/`
// matches NEITHER project and is silently never run.
//
// The property under test is a JOIN across three processes that cannot import
// each other. The capture fixture WRITES these directories from inside a
// Playwright worker; the runner READS them from the compiled app. A
// disagreement is not a wrong screenshot, it is no screenshot — the app looks
// where nothing was written and reports the run as having captured nothing.

import { describe, expect, it } from "vitest";

import {
  ATTEMPT_DIR_PREFIX,
  attemptArtifactDir,
  attemptDirName,
  ATTEMPT_HELPERS,
  attemptFromPlaywrightOutputDir,
  normalizeAttempt,
  parseAttemptDirName,
} from "../../shared/attempt-artifacts.mjs";

describe("attemptDirName", () => {
  it("gives attempt 0 no directory of its own", () => {
    // The load-bearing case. A retry only follows a failure, so attempt 0 is
    // the attempt that failed — and it is where `readManifest`, `readShot`,
    // the replay, the visual diff and Open Trace all already look. Numbering
    // it would move the interesting evidence and leave the passing attempt
    // sitting where the app reads.
    expect(attemptDirName(0)).toBe("");
    expect(attemptArtifactDir("/runs/r1", 0)).toBe("/runs/r1");
  });

  it("puts every later attempt beneath the run directory", () => {
    expect(attemptDirName(1)).toBe("attempt-1");
    expect(attemptArtifactDir("/runs/r1", 2)).toBe("/runs/r1/attempt-2");
  });

  it("never resolves two attempts to the same directory", () => {
    const dirs = [0, 1, 2, 3, 10].map((n) => attemptArtifactDir("/runs/r1", n));
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe("normalizeAttempt", () => {
  it("answers 0 for anything that is not a non-negative integer", () => {
    // The value arrives on stdout beside Playwright's own output, which quotes
    // page-controlled text. A negative or fractional attempt would build a
    // directory name nothing reads back.
    for (const bad of [-1, 1.5, NaN, Infinity, "1", null, undefined, {}, []]) {
      expect(normalizeAttempt(bad)).toBe(0);
    }
  });

  it("passes a real attempt through", () => {
    expect(normalizeAttempt(0)).toBe(0);
    expect(normalizeAttempt(3)).toBe(3);
  });

  it("keeps a hostile attempt out of the path", () => {
    // Not a traversal test for its own sake: this number reaches `path.join`.
    expect(attemptArtifactDir("/runs/r1", -1 as number)).toBe("/runs/r1");
    expect(attemptArtifactDir("/runs/r1", 1.5 as number)).toBe("/runs/r1");
  });
});

describe("parseAttemptDirName", () => {
  it("recognises exactly what attemptDirName writes", () => {
    expect(parseAttemptDirName("attempt-1")).toBe(1);
    expect(parseAttemptDirName("attempt-12")).toBe(12);
  });

  it("refuses everything else a run directory holds", () => {
    // Asked of every entry in a run directory, which also holds `0.png`,
    // `manifest.json`, `console.json`, `network.json` and `trace.zip`.
    for (const name of [
      "0.png",
      "manifest.json",
      "trace.zip",
      "attempt-",
      "attempt-0",
      "attempt-01",
      "attempt-+1",
      "attempt-1.0",
      "attempt-x",
      "baseline",
    ]) {
      expect(parseAttemptDirName(name)).toBeNull();
    }
  });

  it("round-trips every attempt it names", () => {
    for (const n of [1, 2, 9, 10, 47]) {
      expect(parseAttemptDirName(attemptDirName(n))).toBe(n);
    }
  });
});

describe("attemptFromPlaywrightOutputDir", () => {
  it("reads the suffix Playwright actually writes", () => {
    // `testOutputDir += "-retry" + this.retry` — playwright/lib/worker/
    // workerProcessEntry.js. Checked against the installed copy rather than
    // assumed: this repo's own note claimed a nested `retryN/` directory,
    // which Playwright does not produce.
    expect(attemptFromPlaywrightOutputDir("spec-ts-my-test-chromium-retry1")).toBe(1);
    expect(attemptFromPlaywrightOutputDir("spec-ts-my-test-chromium-retry12")).toBe(12);
  });

  it("reads a first attempt's directory as attempt 0", () => {
    expect(attemptFromPlaywrightOutputDir("spec-ts-my-test-chromium")).toBe(0);
    expect(attemptFromPlaywrightOutputDir("retry-later")).toBe(0);
    expect(attemptFromPlaywrightOutputDir("-retry0")).toBe(0);
    expect(attemptFromPlaywrightOutputDir(undefined as unknown as string)).toBe(0);
  });
});

describe("ATTEMPT_HELPERS", () => {
  // The fixture cannot import this module — it is a string written next to the
  // specs and loaded by Playwright's own transform — so the function is
  // interpolated. A copy that drifted would be silent in the worst way: the
  // fixture writes to one directory and the app reads another.
  it("compiles to the same functions the app uses", () => {
    const [dirName, normalize] = new Function(
      `${ATTEMPT_HELPERS}\nreturn [attemptDirName, normalizeAttempt];`,
    )() as [(n: number) => string, (v: unknown) => number];
    for (const n of [0, 1, 2, 7]) {
      expect(dirName(n)).toBe(attemptDirName(n));
    }
    for (const v of [0, 3, -1, 1.5, "1", undefined]) {
      expect(normalize(v)).toBe(normalizeAttempt(v));
    }
  });

  it("carries the prefix with it rather than closing over one", () => {
    // `attemptDirName` names ATTEMPT_DIR_PREFIX, and `toString()` keeps no
    // scope. Interpolating the function alone throws ReferenceError inside the
    // worker — and the fixture swallows its own errors, so the symptom is a
    // run that captures nothing rather than a stack trace.
    expect(ATTEMPT_HELPERS).toContain(`const ATTEMPT_DIR_PREFIX = "${ATTEMPT_DIR_PREFIX}"`);
  });
});
