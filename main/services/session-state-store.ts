// Saved login sessions: one storageState JSON per test, written by the
// capture fixture AFTER A PASSING RUN of a test with `saveSession` on, and
// handed to Playwright (`storageState` in the generated config) when another
// test declares `useSessionFrom` — so a suite logs in once, not once per
// test.
//
// Three rules carry it:
//
// - **Only a PASSING run saves.** A failed login writes a half-signed-in
//   state that poisons every test starting from it; the fixture checks
//   testInfo.status before writing.
//
// - **Stale state is ignored out loud, never used quietly.** Auth cookies
//   expire; a day-old state that half-works produces failures that read as
//   flake in the CONSUMING test, pointing nowhere near the cause. Past the
//   age cap the runner says "no saved session" and runs without.
//
// - **The path is derived from the test id and bounded, both directions.**
//   Same drill as the uploads dir: this file is created, read into a run,
//   and deleted with the test — none of which may trust a stored string.
//
// The state is PLAINTEXT JSON in userData, deliberately: it holds the same
// cookies the run's own network.json already records, and the fixture that
// writes it is a child process with no reach into safeStorage. Parity with
// run artifacts, not with the secrets store — a setup key or password never
// lands here, only the session it bought.

import * as fs from "fs";
import * as path from "path";

import { app } from "@shell/backend";

/** Reuse window. Sessions older than this are ignored — auth cookies rot,
 *  and a half-valid state fails in the consuming test with errors that point
 *  nowhere near the cause. */
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export function sessionsDir(): string {
  return path.join(app.getPath("userData"), "recorder", "sessions");
}

/** The state file for a test, bounded to the sessions dir on resolved paths.
 *  The id flatten mirrors the uploads store's: no dots, starts alphanumeric. */
export function sessionStatePath(testId: string): string {
  const safe =
    String(testId).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "test";
  const file = path.resolve(sessionsDir(), safe + ".json");
  const root = path.resolve(sessionsDir());
  if (!file.startsWith(root + path.sep)) {
    throw new Error("Session state path escapes the sessions dir.");
  }
  return file;
}

/** The saved state for a test, if it exists and is fresh enough to trust.
 *  Stale or missing → null; the caller says so and runs without. */
export function freshSessionState(testId: string): { path: string; savedAt: number } | null {
  try {
    const file = sessionStatePath(testId);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > MAX_SESSION_AGE_MS) return null;
    return { path: file, savedAt: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** When this test's state was saved, fresh or not — the Variables tab's
 *  status line distinguishes "never saved" from "saved but stale". */
export function sessionStateInfo(testId: string): { savedAt: number; fresh: boolean } | null {
  try {
    const stat = fs.statSync(sessionStatePath(testId));
    return { savedAt: stat.mtimeMs, fresh: Date.now() - stat.mtimeMs <= MAX_SESSION_AGE_MS };
  } catch {
    return null;
  }
}

/** Make sure the sessions dir exists before a run that will save into it —
 *  the fixture's write must not fail on a first-ever save. */
export function ensureSessionsDir(): void {
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
  } catch {
    /* the fixture reports its own write failure */
  }
}

export function clearSessionState(testId: string): void {
  try {
    fs.rmSync(sessionStatePath(testId), { force: true });
  } catch {
    /* nothing to clear is fine */
  }
}
