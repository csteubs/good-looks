// append: the retry and trace fields actually persist.
//
// The runner has passed `hasTrace` and the `retryFields` spread (`attempt`,
// `passedOnRetry`) since R24 — and the store dropped all three silently. The
// parameter type never declared them and the record literal names every
// persisted field explicitly, so an object spread at the call site defeated
// excess-property checking and everything compiled clean. The symptoms were
// downstream and quiet: the Open Trace button gates on a field that was never
// true, and `flakeSignal` (shared/run-attempts.mjs) never saw a retried pass
// from an app run, so a test that only ever passes by retrying read "stable".
//
// Driven against the real store writing into a throwaway userData dir.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { retryFields } from "../../shared/run-attempts.mjs";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-run-append-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { runHistoryStore } = await import("./run-history-store.js");

const indexFile = path.join(userData, "recorder", "run-history.json");

function base(id: string, status: "passed" | "failed" = "passed") {
  return {
    id,
    testId: "t1",
    testName: "Alpha",
    url: "https://example.test",
    status,
    exitCode: status === "passed" ? 0 : 1,
    startedAt: 1_800_000_000_000,
    finishedAt: 1_800_000_001_000,
  };
}

beforeEach(() => {
  fs.rmSync(indexFile, { force: true });
});

describe("append: hasTrace / attempt / passedOnRetry", () => {
  it("persists all three when the runner passes them", () => {
    const rec = runHistoryStore.append(
      { ...base("r1"), hasTrace: true, ...retryFields({ status: "passed", maxAttempt: 2 }) },
      "log",
    );
    expect(rec.hasTrace).toBe(true);
    expect(rec.attempt).toBe(2);
    expect(rec.passedOnRetry).toBe(true);

    // Through the file, not just the return value: the record literal is the
    // half that was dropping them.
    const stored = runHistoryStore.list().find((r) => r.id === "r1");
    expect(stored?.hasTrace).toBe(true);
    expect(stored?.attempt).toBe(2);
    expect(stored?.passedOnRetry).toBe(true);
  });

  it("a run that failed on every attempt keeps attempt and NO passedOnRetry", () => {
    runHistoryStore.append(
      { ...base("r2", "failed"), ...retryFields({ status: "failed", maxAttempt: 3 }) },
      "log",
    );
    const stored = runHistoryStore.list().find((r) => r.id === "r2");
    expect(stored?.attempt).toBe(3);
    expect("passedOnRetry" in (stored ?? {})).toBe(false);
  });

  it("absent stays absent — no key is written for a single-attempt, traceless run", () => {
    // `attempt: 0` on every row would be indistinguishable from a row
    // predating the field; the whole point of the spread-conditional shape.
    runHistoryStore.append({ ...base("r3"), ...retryFields({ status: "passed", maxAttempt: 0 }) }, "log");
    const stored = runHistoryStore.list().find((r) => r.id === "r3");
    expect("hasTrace" in (stored ?? {})).toBe(false);
    expect("attempt" in (stored ?? {})).toBe(false);
    expect("passedOnRetry" in (stored ?? {})).toBe(false);
  });

  it("a non-integer or non-positive attempt is refused, not stored", () => {
    runHistoryStore.append(
      { ...base("r4"), attempt: 1.5 as unknown as number },
      "log",
    );
    runHistoryStore.append(
      { ...base("r5"), attempt: 0 },
      "log",
    );
    const all = runHistoryStore.list();
    expect("attempt" in (all.find((r) => r.id === "r4") ?? {})).toBe(false);
    expect("attempt" in (all.find((r) => r.id === "r5") ?? {})).toBe(false);
  });
});
