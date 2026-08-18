// Tests for the AI debug history — the store the Stats board counts.
//
// EVERY ASSERTION HERE IS ABOUT SOMETHING SILENT. A store that erases a deleted
// test's rows makes a lifetime total walk backwards; one that lets a record
// carry content quietly rebuilds the sensitivity the split store exists to
// avoid; one that reconciles an interrupted attempt with `Date.now()` charges a
// week of downtime to a session that took forty seconds. None of those throw,
// and all of them are only visible as a number that looks plausible.
//
// Driven against the real store writing into a throwaway userData dir.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-ai-debug-history-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { aiDebugHistoryStore } = await import("./ai-debug-history-store.js");
const { AI_DEBUG_HISTORY_VERSION } = await import("../recorder/types.js");

const indexFile = path.join(userData, "recorder", "ai-debug-history.json");

function reset(): void {
  fs.rmSync(indexFile, { force: true });
}

function record(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    key: "run:t1",
    kind: "run",
    testId: "t1",
    testName: "Alpha",
    trigger: "manual",
    provider: "ollama",
    model: "qwen",
    status: "done",
    errorKind: null,
    startedAt: 1_800_000_000_000,
    endedAt: 1_800_000_030_000,
    firstTokenMs: 1_500,
    promptChars: 4_000,
    answerChars: 800,
    runKey: null,
    ...over,
  };
}

function readRaw(): { version: number; records: Record<string, unknown>[] } {
  return JSON.parse(fs.readFileSync(indexFile, "utf-8"));
}

beforeEach(reset);

describe("recording", () => {
  it("keeps the newest attempt first", () => {
    aiDebugHistoryStore.record(record({ id: "old", startedAt: 1_000 }));
    aiDebugHistoryStore.record(record({ id: "new", startedAt: 2_000 }));
    expect(aiDebugHistoryStore.list().map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("replaces an attempt by id rather than appending a second row", () => {
    // The store is written to TWICE per attempt — once when it is sent, once
    // when it settles. Appending would double every count on the board.
    aiDebugHistoryStore.record(record({ id: "a1", status: "streaming", endedAt: null }));
    aiDebugHistoryStore.record(record({ id: "a1", status: "done", endedAt: 1_800_000_030_000 }));
    const all = aiDebugHistoryStore.list();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("done");
  });

  it("refuses a record with no id, key or test", () => {
    expect(aiDebugHistoryStore.record(record({ id: "" }))).toBeNull();
    expect(aiDebugHistoryStore.record(record({ testId: "" }))).toBeNull();
    expect(aiDebugHistoryStore.list()).toHaveLength(0);
  });

  it("stores no field it was not asked for", () => {
    // THE STORE'S WHOLE PREMISE. A renderer holding the full session could hand
    // this the answer text; rebuilding the record field by field is what makes
    // that impossible rather than merely discouraged.
    aiDebugHistoryStore.record(
      record({ content: "the model's answer", error: "ECONNREFUSED at 127.0.0.1" }),
    );
    const raw = readRaw();
    expect(raw.version).toBe(AI_DEBUG_HISTORY_VERSION);
    expect(Object.keys(raw.records[0])).not.toContain("content");
    expect(JSON.stringify(raw)).not.toContain("ECONNREFUSED");
  });

  it("files an unrecognised status as interrupted rather than trusting it", () => {
    aiDebugHistoryStore.record(record({ status: "excellent" }));
    expect(aiDebugHistoryStore.list()[0].status).toBe("interrupted");
  });

  it("clamps a negative size instead of multiplying it into a token estimate", () => {
    aiDebugHistoryStore.record(record({ answerChars: -500 }));
    expect(aiDebugHistoryStore.list()[0].answerChars).toBe(0);
  });
});

describe("reading a damaged file", () => {
  it("reads a corrupt file as empty instead of throwing", () => {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, "{not json", "utf-8");
    expect(aiDebugHistoryStore.list()).toEqual([]);
  });

  it("ignores a file written by a future version", () => {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(
      indexFile,
      JSON.stringify({ version: AI_DEBUG_HISTORY_VERSION + 1, records: [record()] }),
      "utf-8",
    );
    expect(aiDebugHistoryStore.list()).toEqual([]);
  });

  it("normalizes rows on the way OUT, not only on the way in", () => {
    // This file sits in userData beside everything else a user can hand-edit.
    // A string where a duration belongs would otherwise reach the arithmetic
    // that draws the board.
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(
      indexFile,
      JSON.stringify({
        version: AI_DEBUG_HISTORY_VERSION,
        records: [record({ startedAt: "yesterday", endedAt: "later" })],
      }),
      "utf-8",
    );
    const row = aiDebugHistoryStore.list()[0];
    expect(row.startedAt).toBe(0);
    expect(row.endedAt).toBeNull();
  });
});

describe("reconciling attempts the app died during", () => {
  it("rewrites a streaming row as interrupted", () => {
    aiDebugHistoryStore.record(record({ id: "a1", status: "streaming", endedAt: null }));
    expect(aiDebugHistoryStore.reconcileInterrupted()).toEqual({ reconciled: 1 });
    expect(aiDebugHistoryStore.list()[0].status).toBe("interrupted");
  });

  it("ends it at the last moment it was known alive, not at startup", () => {
    // The app may have been closed for a week. Stamping `Date.now()` would
    // charge that week to the attempt and make "time spent in AI debug" absurd.
    const startedAt = 1_800_000_000_000;
    aiDebugHistoryStore.record(
      record({ id: "a1", status: "streaming", endedAt: null, startedAt, firstTokenMs: 4_000 }),
    );
    aiDebugHistoryStore.reconcileInterrupted();
    expect(aiDebugHistoryStore.list()[0].endedAt).toBe(startedAt + 4_000);
  });

  it("gives an attempt that never produced a token no duration at all", () => {
    const startedAt = 1_800_000_000_000;
    aiDebugHistoryStore.record(
      record({ id: "a1", status: "streaming", endedAt: null, startedAt, firstTokenMs: null }),
    );
    aiDebugHistoryStore.reconcileInterrupted();
    expect(aiDebugHistoryStore.list()[0].endedAt).toBe(startedAt);
  });

  it("is idempotent", () => {
    aiDebugHistoryStore.record(record({ id: "a1", status: "streaming", endedAt: null }));
    aiDebugHistoryStore.reconcileInterrupted();
    expect(aiDebugHistoryStore.reconcileInterrupted()).toEqual({ reconciled: 0 });
  });
});

describe("seeding from retained sessions", () => {
  const session = (over: Record<string, unknown> = {}) =>
    ({
      key: "run:t1",
      kind: "run",
      testId: "t1",
      label: "Alpha",
      testName: "Alpha",
      status: "done",
      content: "an answer",
      reasoning: "",
      error: null,
      requestId: null,
      scriptHash: null,
      startedAt: 1_800_000_000_000,
      updatedAt: 1_800_000_040_000,
      ...over,
    }) as Parameters<typeof aiDebugHistoryStore.backfillFrom>[0][number];

  it("seeds an empty history so an existing user does not open at zero", () => {
    expect(aiDebugHistoryStore.backfillFrom([session()])).toEqual({ added: 1 });
    const row = aiDebugHistoryStore.list()[0];
    expect(row.answerChars).toBe("an answer".length);
    // What it cannot recover is admitted rather than guessed.
    expect(row.provider).toBeNull();
    expect(row.firstTokenMs).toBeNull();
  });

  it("does nothing once there is any history, so nothing is ever counted twice", () => {
    aiDebugHistoryStore.record(record({ id: "a1" }));
    expect(aiDebugHistoryStore.backfillFrom([session()])).toEqual({ added: 0 });
    expect(aiDebugHistoryStore.list()).toHaveLength(1);
  });

  it("seeds a session the app died during as interrupted, never as live", () => {
    aiDebugHistoryStore.backfillFrom([session({ status: "streaming" })]);
    expect(aiDebugHistoryStore.list()[0].status).toBe("interrupted");
  });
});

describe("a deleted test", () => {
  it("tombstones its rows instead of removing them", () => {
    // The opposite of `aiDebugStore.deleteTest`, deliberately: that store holds
    // the model quoting a test that no longer exists, this one holds the fact
    // that a diagnosis happened. Erasing these would make every lifetime total
    // on the board walk backwards when a test is deleted.
    aiDebugHistoryStore.record(record({ id: "a1", testId: "t1" }));
    aiDebugHistoryStore.record(record({ id: "a2", testId: "t2" }));
    expect(aiDebugHistoryStore.markTestDeleted("t1")).toEqual({ marked: 1 });
    const all = aiDebugHistoryStore.list();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === "a1")?.testDeleted).toBe(true);
    expect(all.find((r) => r.id === "a2")?.testDeleted).toBeUndefined();
  });

  it("keeps the test's name on the tombstoned row", () => {
    // A row that cannot name its test is a row no panel can list.
    aiDebugHistoryStore.record(record({ id: "a1", testName: "Alpha" }));
    aiDebugHistoryStore.markTestDeleted("t1");
    expect(aiDebugHistoryStore.list()[0].testName).toBe("Alpha");
  });

  it("marks nothing twice", () => {
    aiDebugHistoryStore.record(record({ id: "a1" }));
    aiDebugHistoryStore.markTestDeleted("t1");
    expect(aiDebugHistoryStore.markTestDeleted("t1")).toEqual({ marked: 0 });
  });
});

describe("clearing", () => {
  it("reports how many rows went", () => {
    aiDebugHistoryStore.record(record({ id: "a1" }));
    aiDebugHistoryStore.record(record({ id: "a2" }));
    expect(aiDebugHistoryStore.clear()).toEqual({ removed: 2 });
    expect(aiDebugHistoryStore.list()).toEqual([]);
  });
});
