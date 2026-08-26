// The salvaged-trace opener. Two properties matter: the finder stays inside
// its bounded walk, and the opener refuses ids that are not plain path
// segments BEFORE touching the filesystem — `runDir` is a bare join, so this
// gate is what stands between a forged id and "open whatever trace.zip sits
// at an attacker-chosen path".

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-trace-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

import { findTraceZip, findTraceZips, openTrace } from "./playwright-runner.js";
import { artifactStore } from "./artifact-store.js";

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("findTraceZip", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-scratch-"));
  beforeAll(() => {
    fs.mkdirSync(path.join(root, "t-slug", "retry1"), { recursive: true });
    fs.writeFileSync(path.join(root, "t-slug", "retry1", "trace.zip"), "z");
    fs.writeFileSync(path.join(root, "t-slug", "video.webm"), "v");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("finds the zip in Playwright's nested layout", () => {
    expect(findTraceZip(root)).toBe(path.join(root, "t-slug", "retry1", "trace.zip"));
  });

  it("gives up beyond its depth bound instead of spelunking", () => {
    const deep = path.join(root, "a", "b", "c", "d", "e");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "trace.zip"), "z");
    expect(findTraceZip(path.join(root, "a"))).toBeNull();
  });
});

// ── Every attempt's trace, not the first one found (R24a) ─────────────────
//
// `trace: "retain-on-failure"` keeps one trace per FAILED attempt, so a run
// that failed twice leaves two in the scratch dir — which the runner deletes
// at run end. Taking whichever the walk reached first dropped the other
// permanently, and there is nothing to read it back from afterwards.
describe("findTraceZips", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-attempts-"));
  beforeAll(() => {
    // The layout Playwright writes: `testOutputDir += "-retry" + this.retry`.
    for (const dir of ["spec-test-chromium", "spec-test-chromium-retry1"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, "trace.zip"), "z");
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("finds both attempts' traces and says which is which", () => {
    const found = findTraceZips(root).sort((a, b) => a.attempt - b.attempt);
    expect(found.map((f) => f.attempt)).toEqual([0, 1]);
    expect(found[1].file).toBe(path.join(root, "spec-test-chromium-retry1", "trace.zip"));
  });

  it("files a trace under attempt 0 when the directory does not name one", () => {
    // The safe default: attempt 0 is where every existing reader looks, so an
    // unrecognised layout lands the trace where the app has always found it
    // rather than somewhere nothing reads.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-plain-"));
    fs.mkdirSync(path.join(plain, "t-slug", "retry1"), { recursive: true });
    fs.writeFileSync(path.join(plain, "t-slug", "retry1", "trace.zip"), "z");
    expect(findTraceZips(plain).map((f) => f.attempt)).toEqual([0]);
    fs.rmSync(plain, { recursive: true, force: true });
  });

  it("still answers the singular question the same way", () => {
    // findTraceZip is the plural's first element — the order the walk had
    // before, files at each level ahead of subdirectories.
    expect(findTraceZip(root)).toBe(findTraceZips(root)[0].file);
  });
});

describe("openTrace", () => {
  it("spawns the viewer the way runs are spawned, detached", () => {
    const dir = artifactStore.runDir("t-ok", "r-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "trace.zip"), "z");
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref }));
    const res = openTrace("t-ok", "r-1", spawnImpl as never);
    expect(res.ok).toBe(true);
    const [cmd, args, opts] = spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; detached: boolean },
    ];
    expect(cmd).toBe(process.execPath);
    expect(args[1]).toBe("show-trace");
    expect(args[2]).toBe(path.join(dir, "trace.zip"));
    // The two spawn rules this repo runs on: as node, and let it outlive us.
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(opts.detached).toBe(true);
    expect(unref).toHaveBeenCalled();
  });

  it("answers plainly when there is no trace", () => {
    const spawnImpl = vi.fn();
    const res = openTrace("t-ok", "r-none", spawnImpl as never);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/pruned|No trace/i);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("refuses ids that are not plain path segments, before any filesystem look", () => {
    const spawnImpl = vi.fn();
    for (const [t, r] of [
      ["../../../tmp", "r"],
      ["t", "..%2F.."],
      ["t/x", "r"],
      ["t", "r\\x"],
      ["..", "r"],
    ]) {
      const res = openTrace(t, r, spawnImpl as never);
      expect(res.ok, `${t} / ${r}`).toBe(false);
    }
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
