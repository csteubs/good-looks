// The port off Glaze changed where the app's data lives, and the symptom was an
// app that looked wiped: empty library, zero runs, no saved keys, while 1.4 GB
// of real data sat one directory away. These tests pin the decision that fixes
// it — and, more importantly, the two ways the fix could quietly stop working.
//
// Everything here runs against real temp directories rather than a mocked `fs`.
// The bug was about what is actually on disk, and a mock would have agreed with
// whatever the code believed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { app } from "@shell/backend";

import { findLegacyStores, hasRecorderStore, installUserDataPath, resolveUserData } from "./user-data.js";

let root: string;

/** An Application Support-shaped root we can populate per test. */
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-userdata-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  (app as unknown as { __resetPaths(): void }).__resetPaths();
  delete process.env.GOOD_LOOKS_USERDATA;
});

/** A data dir with a recorder store in it. */
function withStore(name: string, files: string[] = ["tests.json"]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "recorder"), { recursive: true });
  for (const f of files) {
    const target = path.join(dir, "recorder", f);
    if (f.endsWith("/")) fs.mkdirSync(target, { recursive: true });
    else fs.writeFileSync(target, "{}");
  }
  return dir;
}

/** A data dir with nothing in it. */
function empty(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("hasRecorderStore", () => {
  it("is true for a directory holding real recorder state", () => {
    expect(hasRecorderStore(withStore("Real"))).toBe(true);
  });

  it("is true when only the scripts directory exists", () => {
    const dir = path.join(root, "Scripts");
    fs.mkdirSync(path.join(dir, "recorder", "scripts"), { recursive: true });
    expect(hasRecorderStore(dir)).toBe(true);
  });

  it("is false for an empty directory", () => {
    expect(hasRecorderStore(empty("Fresh"))).toBe(false);
  });

  it("is false for one that does not exist at all", () => {
    expect(hasRecorderStore(path.join(root, "nope"))).toBe(false);
  });

  // THE REGRESSION GUARD. metrics.db is a DERIVED shadow of the JSON stores
  // (CLAUDE.md), and the port writes an empty one on first launch — before the
  // user has done anything. If it counted as "this install has its own data",
  // adoption would never fire on the second launch and the bug would return
  // looking exactly like the first time.
  it("does NOT count a derived metrics.db as a real store", () => {
    const dir = path.join(root, "OnlyMetrics");
    fs.mkdirSync(path.join(dir, "recorder"), { recursive: true });
    for (const f of ["metrics.db", "metrics.db-shm", "metrics.db-wal"]) {
      fs.writeFileSync(path.join(dir, "recorder", f), "");
    }
    expect(hasRecorderStore(dir)).toBe(false);
  });
});

describe("findLegacyStores", () => {
  it("finds a Glaze-era directory that has a store", () => {
    const legacy = withStore("app.glaze.macos.abc123-local");
    expect(findLegacyStores(root)).toEqual([legacy]);
  });

  it("ignores Glaze-era directories with no store in them", () => {
    empty("app.glaze.macos.empty-local");
    expect(findLegacyStores(root)).toEqual([]);
  });

  it("ignores directories that are not Glaze-shaped", () => {
    withStore("Some Other App");
    withStore("app.glaze.macos.main"); // no -local suffix: the SDK install, not data
    expect(findLegacyStores(root)).toEqual([]);
  });

  it("returns the most recently used one first", () => {
    const older = withStore("app.glaze.macos.older-local");
    const newer = withStore("app.glaze.macos.newer-local");
    const past = new Date(Date.now() - 86_400_000);
    fs.utimesSync(path.join(older, "recorder"), past, past);
    expect(findLegacyStores(root)[0]).toBe(newer);
  });

  it("returns nothing for a root that cannot be read", () => {
    expect(findLegacyStores(path.join(root, "missing"))).toEqual([]);
  });
});

describe("resolveUserData", () => {
  it("honours the explicit override above everything else", () => {
    withStore("app.glaze.macos.abc-local");
    const current = withStore("Good Looks!");
    const chosen = path.join(root, "Elsewhere");
    expect(resolveUserData(current, { GOOD_LOOKS_USERDATA: chosen })).toEqual({
      dir: chosen,
      reason: "override",
    });
  });

  // The safety property: an install that has started accumulating its own data
  // must never be silently redirected at someone else's.
  it("keeps its own store even when a legacy one exists", () => {
    withStore("app.glaze.macos.abc-local");
    const current = withStore("Good Looks!");
    expect(resolveUserData(current, {})).toEqual({ dir: current, reason: "own-store" });
  });

  it("adopts the legacy store when the default is empty", () => {
    const legacy = withStore("app.glaze.macos.abc-local");
    const current = empty("Good Looks!");
    expect(resolveUserData(current, {})).toEqual({
      dir: legacy,
      reason: "adopted-legacy",
      legacy,
    });
  });

  it("adopts when the default holds only a freshly built metrics.db", () => {
    const legacy = withStore("app.glaze.macos.abc-local");
    const current = path.join(root, "Good Looks!");
    fs.mkdirSync(path.join(current, "recorder"), { recursive: true });
    fs.writeFileSync(path.join(current, "recorder", "metrics.db"), "");
    expect(resolveUserData(current, {}).dir).toBe(legacy);
  });

  it("falls back to the default when there is nothing to adopt", () => {
    const current = empty("Good Looks!");
    expect(resolveUserData(current, {})).toEqual({ dir: current, reason: "default" });
  });
});

describe("installUserDataPath", () => {
  it("redirects the app at the adopted directory", () => {
    const legacy = withStore("app.glaze.macos.abc-local");
    const current = empty("Good Looks!");
    app.setPath("userData", current);

    installUserDataPath();

    expect(app.getPath("userData")).toBe(legacy);
  });

  it("leaves the app alone when it already has its own store", () => {
    withStore("app.glaze.macos.abc-local");
    const current = withStore("Good Looks!");
    app.setPath("userData", current);

    installUserDataPath();

    expect(app.getPath("userData")).toBe(current);
  });

  it("creates the override directory if it does not exist yet", () => {
    const current = empty("Good Looks!");
    const chosen = path.join(root, "Chosen");
    app.setPath("userData", current);
    process.env.GOOD_LOOKS_USERDATA = chosen;

    installUserDataPath();

    expect(fs.existsSync(chosen)).toBe(true);
    expect(app.getPath("userData")).toBe(chosen);
  });
});
