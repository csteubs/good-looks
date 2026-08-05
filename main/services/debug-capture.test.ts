// Tests for the debug-screenshot protocol.
//
// The protocol spans two processes that never talk directly: the app writes
// files, the MCP server reads them. Nothing enforces that they agree, and a
// disagreement produces NO error on either side — the app answers a request the
// client isn't looking for, and the client waits out its timeout and reports
// "the app isn't running". So the first thing tested here is that the two
// implementations derive the same names.
//
// The rest is the part that can quietly lose data: pruning. It groups by
// session rather than by file, because deleting a PNG while keeping the
// response that references it produces a manifest pointing at nothing.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { readFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import {
  DEBUG_DIRNAME,
  isValidRequestId,
  MAX_SESSIONS,
  newCaptureId,
  pruneSessions,
  REQUEST_FILE,
  responseFileFor,
  shotFileFor,
} from "./debug-capture.js";
import * as mcp from "../../mcp/debug-shots.mjs";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-debug-shots-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("protocol agreement between the app and the MCP server", () => {
  // Compared directly rather than each side against a hardcoded string: two
  // tests asserting the same literal would both keep passing while the two
  // implementations drifted apart from each other.
  it("agrees on the directory name", () => {
    expect(mcp.DEBUG_DIRNAME).toBe(DEBUG_DIRNAME);
  });

  it("agrees on the request filename", () => {
    expect(mcp.REQUEST_FILE).toBe(REQUEST_FILE);
  });

  it("agrees on response filenames", () => {
    for (const id of ["abc", "1a2b-3c4d", "z"]) {
      expect(mcp.responseFileFor(id)).toBe(responseFileFor(id));
    }
  });

  it("agrees on screenshot filenames", () => {
    for (const id of ["abc", "1a2b-3c4d"]) {
      for (const i of [0, 1, 7]) {
        expect(mcp.shotFileFor(id, i)).toBe(shotFileFor(id, i));
      }
    }
  });

  it("agrees on which ids are valid", () => {
    for (const id of ["abc", "a-b_c", "1", "x".repeat(64)]) {
      expect(mcp.isValidRequestId(id), `${id} should be valid`).toBe(isValidRequestId(id));
    }
    // Ids become filenames, so traversal and separators must be rejected by
    // BOTH sides — a client that accepts "../../x" writes a request the app is
    // right to refuse, and the mismatch would look like a timeout.
    for (const id of ["../escape", "a/b", "a.b", "", "x".repeat(65), "a b"]) {
      expect(mcp.isValidRequestId(id), `${JSON.stringify(id)} should be invalid`).toBe(false);
      expect(isValidRequestId(id), `${JSON.stringify(id)} should be invalid`).toBe(false);
    }
  });

  it("generates ids that both sides consider valid", () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidRequestId(newCaptureId())).toBe(true);
      expect(mcp.isValidRequestId(mcp.newCaptureId())).toBe(true);
    }
  });
});

describe("pruneSessions", () => {
  /** Write a session's files with a controlled mtime, so ordering is decided by
   *  the test rather than by how fast it runs. */
  function seed(id: string, shots: number, ageMs: number): void {
    const when = new Date(Date.now() - ageMs);
    for (let i = 0; i < shots; i++) {
      const file = path.join(dir, shotFileFor(id, i));
      fs.writeFileSync(file, "png");
      fs.utimesSync(file, when, when);
    }
    const response = path.join(dir, responseFileFor(id));
    fs.writeFileSync(response, JSON.stringify({ id, shots: [] }));
    fs.utimesSync(response, when, when);
  }

  it("keeps the newest sessions and drops the rest", () => {
    for (let i = 0; i < 15; i++) seed(`s${i}`, 1, i * 60_000);
    pruneSessions(dir, 10);
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
    expect(remaining).toHaveLength(10);
    expect(remaining).toContain(shotFileFor("s0", 0)); // newest survives
    expect(remaining).not.toContain(shotFileFor("s14", 0)); // oldest goes
  });

  it("removes a session's images and its response together", () => {
    // The failure this guards: pruning by file age alone can delete a PNG and
    // keep the response that lists it, leaving a manifest pointing at nothing.
    seed("keep", 2, 0);
    seed("drop", 2, 60_000);
    pruneSessions(dir, 1);
    const remaining = fs.readdirSync(dir);
    expect(remaining.filter((f) => f.startsWith("drop"))).toHaveLength(0);
    expect(remaining.filter((f) => f.startsWith("response-drop"))).toHaveLength(0);
    expect(remaining).toContain(responseFileFor("keep"));
    expect(remaining.filter((f) => f.startsWith("keep-"))).toHaveLength(2);
  });

  it("counts a multi-window session as ONE session", () => {
    // Four windows is one press. Counting files would prune after two or three
    // presses instead of ten.
    for (let i = 0; i < 3; i++) seed(`s${i}`, 4, i * 60_000);
    pruneSessions(dir, 3);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".png"))).toHaveLength(12);
  });

  it("never touches a pending request file", () => {
    // A request arriving while a prune runs must survive it, or the client
    // waits out its timeout for a capture that was silently discarded.
    fs.writeFileSync(path.join(dir, REQUEST_FILE), JSON.stringify({ id: "pending" }));
    for (let i = 0; i < 15; i++) seed(`s${i}`, 1, i * 60_000);
    pruneSessions(dir, 1);
    expect(fs.existsSync(path.join(dir, REQUEST_FILE))).toBe(true);
  });

  it("survives a directory that doesn't exist", () => {
    expect(() => pruneSessions(path.join(dir, "nope"))).not.toThrow();
  });

  it("defaults to keeping MAX_SESSIONS", () => {
    for (let i = 0; i < MAX_SESSIONS + 5; i++) seed(`s${i}`, 1, i * 60_000);
    pruneSessions(dir);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".png"))).toHaveLength(MAX_SESSIONS);
  });
});

describe("MCP-side session listing", () => {
  /** A data dir shaped the way the MCP server expects. */
  function seedDataDir(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-debug-data-"));
    fs.mkdirSync(path.join(root, "recorder", DEBUG_DIRNAME), { recursive: true });
    return root;
  }

  it("finds a session written by a request, using its response file", () => {
    const root = seedDataDir();
    const shots = path.join(root, "recorder", DEBUG_DIRNAME);
    fs.writeFileSync(path.join(shots, shotFileFor("abc", 0)), "png");
    fs.writeFileSync(
      path.join(shots, responseFileFor("abc")),
      JSON.stringify({
        id: "abc",
        at: 1000,
        reason: "request",
        shots: [{ file: shotFileFor("abc", 0), window: "Good Looks!", width: 100, height: 50 }],
      }),
    );
    const sessions = mcp.listSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].shots[0].window).toBe("Good Looks!");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds a session taken with the in-app shortcut, which has no response file", () => {
    // The commonest way a screenshot gets taken. Reconstructing it from
    // filenames is what stops a hand-taken shot being invisible here.
    const root = seedDataDir();
    const shots = path.join(root, "recorder", DEBUG_DIRNAME);
    fs.writeFileSync(path.join(shots, shotFileFor("xyz", 0)), "png");
    fs.writeFileSync(path.join(shots, shotFileFor("xyz", 1)), "png");
    const sessions = mcp.listSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].shots).toHaveLength(2);
    expect(sessions[0].reason).toBe("shortcut");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns sessions newest first", () => {
    const root = seedDataDir();
    const shots = path.join(root, "recorder", DEBUG_DIRNAME);
    for (const [id, ageMs] of [
      ["old", 600_000],
      ["new", 0],
    ] as const) {
      const file = path.join(shots, shotFileFor(id, 0));
      fs.writeFileSync(file, "png");
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(file, when, when);
    }
    expect(mcp.listSessions(root).map((s: { id: string }) => s.id)).toEqual(["new", "old"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns nothing rather than throwing when nothing has been captured", () => {
    const root = seedDataDir();
    expect(mcp.listSessions(root)).toEqual([]);
    expect(mcp.listSessions(path.join(root, "nope"))).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips images that have been pruned since the response was written", () => {
    // readShots must not fail the whole call because one file went missing —
    // the other windows are still worth showing.
    const root = seedDataDir();
    const shots = path.join(root, "recorder", DEBUG_DIRNAME);
    fs.writeFileSync(path.join(shots, shotFileFor("abc", 1)), "png");
    const session = {
      id: "abc",
      at: 1000,
      shots: [
        { file: shotFileFor("abc", 0), window: "gone" },
        { file: shotFileFor("abc", 1), window: "here" },
      ],
    };
    const read = mcp.readShots(root, session);
    expect(read).toHaveLength(1);
    expect(read[0].window).toBe("here");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("requestCapture", () => {
  it("reports a specific reason when nothing answers", async () => {
    // The two ordinary failures — app closed, or the toggle off — need naming,
    // because "timed out" alone sends someone looking in the wrong place.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-debug-timeout-"));
    const result = await mcp.requestCapture(root, 300);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/Debug screenshots is off/i);
    // The stale request is cleaned up, so a later launch doesn't serve a
    // capture nobody is waiting for any more.
    expect(fs.existsSync(path.join(mcp.debugDir(root), REQUEST_FILE))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the session once a response appears", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-debug-answer-"));
    const dirPath = mcp.debugDir(root);
    // Stand in for the app: watch for the request, answer it.
    const pending = mcp.requestCapture(root, 5000);
    const timer = setInterval(() => {
      try {
        const raw = fs.readFileSync(path.join(dirPath, REQUEST_FILE), "utf8");
        const { id } = JSON.parse(raw);
        fs.writeFileSync(
          path.join(dirPath, responseFileFor(id)),
          JSON.stringify({ id, at: Date.now(), reason: "request", shots: [] }),
        );
        clearInterval(timer);
      } catch {
        /* not there yet */
      }
    }, 20);
    const result = await pending;
    clearInterval(timer);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.session.reason).toBe("request");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("the shortcut is registered at a point where it can work", () => {
  // This shipped broken. `globalShortcut.register` was called at module scope,
  // which throws "globalShortcut cannot be used before the app is ready" — and
  // because that rejection is caught and logged rather than left to crash, the
  // only symptom was a key combination that did nothing. Nothing in the type
  // system, the linter or any other test could see it; it took reading the app
  // log to find.
  //
  // A source-level assertion, like the a11y non-gating test. Crude, and still
  // the only thing between this and a silent repeat.
  function indexSource(): string {
    const url = new URL("../index.ts", import.meta.url);
    return readFileSync(url, "utf-8");
  }

  /** Body of a top-level `async function <name>` declaration. */
  function functionBody(src: string, name: string): string {
    const start = src.indexOf(`async function ${name}(`);
    if (start < 0) return "";
    const end = src.indexOf("\n}", start);
    return end < 0 ? src.slice(start) : src.slice(start, end);
  }

  it("registers the shortcut only inside a function, never at module scope", () => {
    const src = indexSource();
    const body = functionBody(src, "setupDebugScreenshots");
    expect(body, "setupDebugScreenshots not found").not.toBe("");
    // Every mention of register lives in that function.
    const mentions = src.split("globalShortcut.register").length - 1;
    const inside = body.split("globalShortcut.register").length - 1;
    expect(mentions).toBeGreaterThan(0);
    expect(inside, "globalShortcut.register is called outside setupDebugScreenshots").toBe(
      mentions,
    );
  });

  it("calls that function from the app-ready handler", () => {
    // Being inside a function isn't enough — it has to be a function that runs
    // after ready. Anchoring on whenReady is what makes this test about the
    // actual requirement rather than about code tidiness.
    const src = indexSource();
    const readyAt = src.indexOf("app.whenReady()");
    expect(readyAt, "app.whenReady() not found").toBeGreaterThan(-1);
    const afterReady = src.slice(readyAt);
    expect(afterReady).toContain("setupDebugScreenshots()");
  });

  it("starts the request watcher from the same place", () => {
    // syncRequestWatcher reads app.getPath("userData"), which has the same
    // before-ready hazard.
    const src = indexSource();
    const body = functionBody(src, "setupDebugScreenshots");
    const mentions = src.split("syncRequestWatcher(").length - 1;
    const inside = body.split("syncRequestWatcher(").length - 1;
    expect(inside, "syncRequestWatcher is called outside setupDebugScreenshots").toBe(mentions);
  });
});
