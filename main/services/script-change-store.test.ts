// Tests for the script-change journal.
//
// Every assertion here is about something that produces no error when it's
// wrong. A journal that loses the previous script still renders a Revert
// button; one that records every Save fills the review queue with entries
// where nothing happened; one that prunes the wrong end throws away the undo
// for a change the user never saw. None of those throw, and all of them are
// only noticed by the person who has already lost the script.
//
// Driven against the real store writing into a throwaway userData dir.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-script-change-"));
process.env.GLAZE_TEST_USERDATA = userData;

// Imported after the env var is set — `app.getPath` is resolved lazily on every
// call, but the index path is derived from it at call time.
const { scriptChangeStore, countLineChanges, MAX_SOURCE_BYTES, normalizeScriptChangeOrigin } = await import(
  "./script-change-store.js"
);

const indexFile = path.join(userData, "recorder", "script-changes.json");

function reset(): void {
  fs.rmSync(indexFile, { force: true });
}

function record(over: Partial<Parameters<typeof scriptChangeStore.record>[0]> = {}) {
  return scriptChangeStore.record({
    testId: "t1",
    origin: "manual",
    reviewed: true,
    before: "a\nb\n",
    after: "a\nc\n",
    ...over,
  });
}

beforeEach(reset);

describe("recording", () => {
  it("stores both sides of the change, so there is something to revert to", () => {
    const entry = record({ before: "old\n", after: "new\n" });
    expect(entry?.before).toBe("old\n");
    expect(entry?.after).toBe("new\n");
    expect(scriptChangeStore.get(entry!.id)?.before).toBe("old\n");
  });

  it("records nothing when the script did not actually change", () => {
    // The Script tab's Save fires whether or not the text moved.
    expect(record({ before: "same\n", after: "same\n" })).toBeNull();
    expect(scriptChangeStore.list("t1")).toHaveLength(0);
  });

  it("starts an unreviewed change as pending and a reviewed one as settled", () => {
    // The split the whole feature turns on: a change applied while the user
    // wasn't looking is a review item; one they watched land is history.
    expect(record({ reviewed: false })?.status).toBe("pending");
    expect(record({ reviewed: true })?.status).toBe("accepted");
  });

  it("keeps the model on an AI change and omits the key entirely without one", () => {
    expect(record({ origin: "ai-debug", model: "claude-sonnet-4" })?.model).toBe(
      "claude-sonnet-4",
    );
    const noModel = record({ origin: "ai-debug" });
    expect(noModel && "model" in noModel).toBe(false);
  });

  it("counts added and removed lines for the row summary", () => {
    const entry = record({ before: "a\nb\nc\n", after: "a\nc\nd\ne\n" });
    expect(entry?.removedLines).toBe(1); // b
    expect(entry?.addedLines).toBe(2); // d, e
  });

  it("drops the sources of an oversized change and flags it, rather than storing them", () => {
    // The flag is the whole point: without it the UI offers a Revert that would
    // write an empty file over the user's spec.
    const huge = "x".repeat(MAX_SOURCE_BYTES + 1);
    const entry = record({ before: "small\n", after: huge });
    expect(entry?.truncated).toBe(true);
    expect(entry?.before).toBe("");
    expect(entry?.after).toBe("");
    // The summary still describes it — the counts come from the real sources.
    expect(entry?.addedLines).toBeGreaterThan(0);
  });
});

describe("listing", () => {
  it("returns newest first, per test and across tests", () => {
    record({ testId: "t1", at: 100 });
    record({ testId: "t2", at: 300 });
    record({ testId: "t1", at: 200 });
    expect(scriptChangeStore.list("t1").map((e) => e.at)).toEqual([200, 100]);
    expect(scriptChangeStore.listAll().map((e) => e.at)).toEqual([300, 200, 100]);
  });

  it("pending() is scoped to the test and to unsettled entries", () => {
    record({ testId: "t1", reviewed: false });
    record({ testId: "t1", reviewed: true });
    record({ testId: "t2", reviewed: false });
    expect(scriptChangeStore.pending("t1")).toHaveLength(1);
  });
});

describe("settling and deleting", () => {
  it("setStatus updates the stored entry", () => {
    const entry = record({ reviewed: false })!;
    expect(scriptChangeStore.setStatus(entry.id, "reverted")?.status).toBe("reverted");
    expect(scriptChangeStore.get(entry.id)?.status).toBe("reverted");
  });

  it("setStatus reports a missing entry rather than throwing", () => {
    expect(scriptChangeStore.setStatus("nope", "accepted")).toBeNull();
  });

  it("clearSettled keeps pending entries — they are the undo for a live change", () => {
    const pending = record({ reviewed: false })!;
    record({ reviewed: true });
    expect(scriptChangeStore.clearSettled("t1").removed).toBe(1);
    expect(scriptChangeStore.list("t1").map((e) => e.id)).toEqual([pending.id]);
  });

  it("clearSettled leaves other tests alone", () => {
    record({ testId: "t1", reviewed: true });
    record({ testId: "t2", reviewed: true });
    scriptChangeStore.clearSettled("t1");
    expect(scriptChangeStore.list("t2")).toHaveLength(1);
  });

  it("clearAllSettled sweeps every test but still keeps pending entries", () => {
    record({ testId: "t1", reviewed: true });
    record({ testId: "t2", reviewed: true });
    const pending = record({ testId: "t2", reviewed: false })!;
    expect(scriptChangeStore.clearAllSettled().removed).toBe(2);
    expect(scriptChangeStore.listAll().map((e) => e.id)).toEqual([pending.id]);
  });

  it("remove deletes a pending entry too — an explicit delete is the user's call", () => {
    const entry = record({ reviewed: false })!;
    expect(scriptChangeStore.remove(entry.id).removed).toBe(1);
    expect(scriptChangeStore.get(entry.id)).toBeNull();
  });

  it("remove reports zero for an unknown id rather than throwing", () => {
    expect(scriptChangeStore.remove("nope").removed).toBe(0);
  });

  it("deleteTest drops that test's entries and only those", () => {
    record({ testId: "t1" });
    record({ testId: "t2" });
    scriptChangeStore.deleteTest("t1");
    expect(scriptChangeStore.list("t1")).toHaveLength(0);
    expect(scriptChangeStore.list("t2")).toHaveLength(1);
  });
});

describe("the per-test cap", () => {
  it("prunes the oldest settled entries and never a pending one", () => {
    // A pending entry is the only stored copy of the script its test used to
    // have. Dropping it to make room would destroy the undo for a change
    // already made — silently, and only for the user who most needs it.
    const pending = record({ at: 1, reviewed: false })!;
    for (let i = 2; i < 60; i++) record({ at: i, reviewed: true });
    const list = scriptChangeStore.list("t1");
    expect(list).toHaveLength(50);
    expect(list.some((e) => e.id === pending.id)).toBe(true);
    // The survivors are the newest settled ones plus the pending one.
    expect(Math.min(...list.filter((e) => e.status !== "pending").map((e) => e.at))).toBe(11);
  });

  it("counts the cap per test rather than across the file", () => {
    for (let i = 0; i < 55; i++) record({ testId: "t1", at: i, reviewed: true });
    record({ testId: "t2", at: 1, reviewed: true });
    expect(scriptChangeStore.list("t2")).toHaveLength(1);
  });
});

describe("a corrupt index", () => {
  it("reads as empty rather than throwing", () => {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, "{not json", "utf-8");
    expect(scriptChangeStore.listAll()).toEqual([]);
    // And a write repairs it rather than compounding the damage.
    expect(record()).not.toBeNull();
    expect(scriptChangeStore.listAll()).toHaveLength(1);
  });
});

describe("countLineChanges", () => {
  it("treats a moved line as unchanged", () => {
    // "+12 −7" is a summary. Counting a reordered line as both added and
    // removed would report churn the expanded diff doesn't show.
    expect(countLineChanges("a\nb\n", "b\na\n")).toEqual({ addedLines: 0, removedLines: 0 });
  });

  it("counts duplicates once each", () => {
    expect(countLineChanges("a\n", "a\na\n")).toEqual({ addedLines: 1, removedLines: 0 });
  });
});

describe("the AI-inline origin and the fields an AI origin carries", () => {
  beforeEach(reset);

  it("normalizes an inline rewrite's origin with its provider, affordance and prompt version, capped and stripped", () => {
    expect(
      normalizeScriptChangeOrigin({
        by: "ai-inline",
        model: "qwen2.5-coder:7b",
        provider: "ollama\u0007",
        affordance: "inline-rewrite",
        promptVersion: "inline-rewrite/1",
        reviewed: true,
      }),
    ).toEqual({
      origin: "ai-inline",
      model: "qwen2.5-coder:7b",
      provider: "ollama",
      affordance: "inline-rewrite",
      promptVersion: "inline-rewrite/1",
      reviewed: true,
    });
    // An affordance outside the vocabulary is dropped, never stored as text.
    expect(normalizeScriptChangeOrigin({ by: "ai-inline", affordance: "<script>" }).affordance).toBeUndefined();
    // A hand edit carries none of them, whatever the payload claims.
    expect(normalizeScriptChangeOrigin({ by: "manual", model: "x", provider: "y", affordance: "debug" })).toEqual({
      origin: "manual",
      reviewed: true,
    });
  });

  it("stores the fields with the entry and lists them back", () => {
    const entry = record({
      origin: "ai-inline",
      model: "m",
      provider: "lmstudio",
      affordance: "roundtrip-rewrite",
      promptVersion: "roundtrip/1",
    })!;
    const listed = scriptChangeStore.list(entry.testId)[0];
    expect(listed).toMatchObject({
      origin: "ai-inline",
      model: "m",
      provider: "lmstudio",
      affordance: "roundtrip-rewrite",
      promptVersion: "roundtrip/1",
    });
  });
});
