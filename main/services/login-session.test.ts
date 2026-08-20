// Login sessions: the store's rules (fresh vs stale vs never, bounded
// paths), and SOURCE PINS for the two writers a unit test cannot reach — the
// capture fixture only exists inside a Playwright worker, and the config
// template is loaded by the Playwright CLI. The pins hold the wiring in
// place (the same idiom check:auto-heal-wiring uses); the store tests hold
// the meaning.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSessionState,
  freshSessionState,
  MAX_SESSION_AGE_MS,
  sessionStateInfo,
  sessionStatePath,
  sessionsDir,
} from "./session-state-store.js";
import { captureFixtureSource } from "./capture-fixture-source.js";
import { playwrightConfigSource } from "../../shared/playwright-config-source.mjs";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gl-session-"));
  process.env.GLAZE_TEST_USERDATA = tmp;
});

afterEach(() => {
  delete process.env.GLAZE_TEST_USERDATA;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function save(testId: string, ageMs = 0): string {
  const file = sessionStatePath(testId);
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
  }
  return file;
}

describe("the session state store", () => {
  it("answers fresh state with its path, and null when nothing was saved", () => {
    expect(freshSessionState("t-login")).toBeNull();
    const file = save("t-login");
    expect(freshSessionState("t-login")?.path).toBe(file);
  });

  it("refuses stale state — auth cookies rot, and half-valid state reads as flake", () => {
    save("t-login", MAX_SESSION_AGE_MS + 60_000);
    expect(freshSessionState("t-login")).toBeNull();
    // The status line still distinguishes "stale" from "never saved".
    expect(sessionStateInfo("t-login")).toMatchObject({ fresh: false });
    expect(sessionStateInfo("t-never")).toBeNull();
  });

  it("bounds the path against a hostile id, same drill as the uploads dir", () => {
    const p = sessionStatePath("../../evil");
    expect(p.startsWith(path.resolve(sessionsDir()) + path.sep)).toBe(true);
    expect(p).not.toContain("..");
  });

  it("clears without error, saved or not", () => {
    save("t-login");
    clearSessionState("t-login");
    expect(sessionStateInfo("t-login")).toBeNull();
    clearSessionState("t-login");
  });
});

describe("the wiring the unit tests cannot reach", () => {
  it("the fixture saves in BOTH teardown paths, gated on a PASSING status", () => {
    // Two `use(page)` finallys exist (the toggles-off early return and the
    // artifact path); a save in only one silently loses the login test whose
    // toggles are all off — which is the common case for a login test.
    const calls = captureFixtureSource.match(/await saveSessionState\(page, testInfo\);/g) ?? [];
    expect(calls.length).toBe(2);
    expect(captureFixtureSource).toContain('testInfo.status !== "passed"');
    // The extension gate must include the save flag, or a toggles-off login
    // test never gets the extended fixture at all.
    expect(captureFixtureSource).toMatch(/SIG_ON \|\| SAVE_STATE\) \? base\.extend/);
  });

  it("the generated config starts from GLAZE_STORAGE_STATE when set, untouched otherwise", () => {
    expect(playwrightConfigSource).toContain(
      "storageState: process.env.GLAZE_STORAGE_STATE || undefined,",
    );
  });

  it("the runner passes both envs and says out loud when state is missing", () => {
    const runner = fs.readFileSync(
      path.resolve(__dirname, "./playwright-runner.ts"),
      "utf8",
    );
    expect(runner).toContain("sessionEnv.GLAZE_SAVE_STATE = sessionStatePath(rec.id)");
    expect(runner).toContain("sessionEnv.GLAZE_STORAGE_STATE = fresh.path");
    expect(runner).toMatch(/No fresh saved session/);
  });
});
