// Where a run's paths hang off, and why that root must be ABSOLUTE.
//
// Here rather than beside `mcp/data-dir.mjs` for the reason CLAUDE.md records:
// vitest's node project takes `main/**`, `mcp/**` and `renderer/lib/**`, and a
// `.test.ts` under `mcp/` would match — but the CLI's other tests live here
// (`cli-exit.test.ts`, `cli-junit.test.ts`) and this is the same subject.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDataDir } from "../../mcp/data-dir.mjs";
import { USERDATA_OVERRIDE_ENV } from "../../shared/user-data-rules.mjs";

const tmp = mkdtempSync(join(tmpdir(), "gl-datadir-"));
const cwd = process.cwd();

beforeAll(() => {
  mkdirSync(join(tmp, "lib", "recorder"), { recursive: true });
  writeFileSync(join(tmp, "lib", "recorder", "tests.json"), "[]", "utf-8");
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("the data directory is absolute, whatever the caller typed", () => {
  // THE BUG THIS EXISTS FOR. Every path a run uses is joined onto this one, and
  // one of them is handed to the Playwright CLI as `--reporter <path>`.
  // Playwright resolves that with `require.resolve`, which reads a specifier
  // NOT beginning with `./` as a PACKAGE NAME — so a relative root produced
  //
  //   Cannot find module 'fixture-library/recorder/scripts/step-reporter.mjs'
  //
  // before any test body ran, and the run reported every test as failed with
  // `exit 1` and no step. `--library ./tests` in a workflow and
  // `GOOD_LOOKS_USERDATA=fixture-library` in a shell are both ordinary
  // spellings, so this is the common case rather than an exotic one.
  it("resolves a relative override against the cwd", () => {
    const dir = resolveDataDir({ [USERDATA_OVERRIDE_ENV]: "lib" });
    expect(isAbsolute(dir)).toBe(true);
    expect(dir).toBe(resolve(tmp, "lib"));
  });

  it("resolves a dot-relative override too", () => {
    expect(resolveDataDir({ [USERDATA_OVERRIDE_ENV]: "./lib" })).toBe(resolve(tmp, "lib"));
  });

  it("leaves an already-absolute override alone", () => {
    const abs = resolve(tmp, "lib");
    expect(resolveDataDir({ [USERDATA_OVERRIDE_ENV]: abs })).toBe(abs);
  });

  it("normalises a path that walks back up", () => {
    // Not a containment check — the override is the caller ASSERTING where
    // their library is, and this process has no better answer. It is here so
    // the returned path is one string rather than several spellings of one
    // directory, since it is compared against elsewhere.
    expect(resolveDataDir({ [USERDATA_OVERRIDE_ENV]: "lib/../lib" })).toBe(resolve(tmp, "lib"));
  });
});
