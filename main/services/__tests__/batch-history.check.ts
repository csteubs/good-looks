// Standalone regression check for batch-history persistence.
//
// Drives the REAL store against a throwaway userData dir (`@shell/backend`
// aliased to shell-backend-stub.ts, whose app.getPath reads GLAZE_TEST_USERDATA).
// What matters here and is easy to break:
//   - save() UPSERTS by batchId — the runner calls it once per transition, so
//     appending instead would leave dozens of records per batch;
//   - the index survives a reload (that's the whole point of the feature);
//   - reconcileInterrupted() clears the stale `running` flag left by an app
//     that exited mid-batch, and only then;
//   - the record cap prunes oldest-first.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:batch-history

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Point the stub's app.getPath at a throwaway dir BEFORE importing the store.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-batch-history-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { batchHistoryStore } = await import("../batch-history-store.js");
type BatchRecord = Parameters<typeof batchHistoryStore.save>[0];

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function rec(over: Partial<BatchRecord> & { batchId: string }): BatchRecord {
  return {
    running: false,
    startedAt: 1000,
    finishedAt: 2000,
    currentIndex: -1,
    stopped: false,
    results: [{ testId: "t1", testName: "T1", status: "passed" }],
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, ok: true, durationMs: 1000 },
    ...over,
  } as BatchRecord;
}

const indexFile = path.join(userData, "recorder", "batch-history.json");

// ── Empty state ──────────────────────────────────────────────────────
assert(batchHistoryStore.list().length === 0, "starts empty when no file exists");
assert(batchHistoryStore.get("nope") === null, "get() on a missing batch → null");

// ── Save + reload ────────────────────────────────────────────────────
batchHistoryStore.save(rec({ batchId: "b1", startedAt: 1000 }));
assert(fs.existsSync(indexFile), "save() writes the index file");
assert(batchHistoryStore.list().length === 1, "a saved batch is listed");
assert(batchHistoryStore.get("b1")?.batchId === "b1", "a saved batch is retrievable by id");
// The store re-reads the file on every call, so this genuinely round-trips disk.
assert(
  JSON.parse(fs.readFileSync(indexFile, "utf-8"))[0].batchId === "b1",
  "the record survives as JSON on disk (survives a restart)",
);

// ── Upsert, not append ───────────────────────────────────────────────
// The runner calls save() on EVERY per-test transition with the same id.
for (let i = 0; i < 5; i++) {
  batchHistoryStore.save(
    rec({
      batchId: "b1",
      startedAt: 1000,
      running: i < 4,
      summary: { total: 5, passed: i, failed: 0, skipped: 0, ok: true, durationMs: 10 },
    }),
  );
}
assert(batchHistoryStore.list().length === 1, "repeated save() of one batch keeps ONE record");
assert(
  batchHistoryStore.get("b1")?.summary.passed === 4,
  "the latest save wins (write-through keeps the newest progress)",
);
assert(batchHistoryStore.get("b1")?.running === false, "the final save clears the running flag");

// ── Newest first ─────────────────────────────────────────────────────
batchHistoryStore.save(rec({ batchId: "b2", startedAt: 5000 }));
batchHistoryStore.save(rec({ batchId: "b0", startedAt: 10 }));
assert(
  batchHistoryStore.list().map((b) => b.batchId).join(",") === "b2,b1,b0",
  `list() is newest-first (got ${batchHistoryStore.list().map((b) => b.batchId).join(",")})`,
);

// ── reconcileInterrupted ─────────────────────────────────────────────
batchHistoryStore.save(
  rec({
    batchId: "crashed",
    startedAt: 6000,
    running: true,
    finishedAt: undefined,
    results: [
      { testId: "t1", testName: "T1", status: "passed" },
      { testId: "t2", testName: "T2", status: "running" },
      { testId: "t3", testName: "T3", status: "pending" },
    ],
  }),
);
const before = batchHistoryStore.list().length;
const { reconciled } = batchHistoryStore.reconcileInterrupted();
assert(reconciled === 1, `reconciles exactly the interrupted batch (got ${reconciled})`);
assert(batchHistoryStore.list().length === before, "reconciling doesn't drop records");

const fixed = batchHistoryStore.get("crashed");
assert(fixed?.running === false, "an interrupted batch is no longer marked running");
assert(fixed?.stopped === true, "an interrupted batch is marked stopped");
assert(fixed?.finishedAt !== undefined, "an interrupted batch gets a finishedAt");
assert(
  fixed?.results.find((r) => r.testId === "t1")?.status === "passed",
  "results completed before the interruption are preserved",
);
assert(
  fixed?.results.find((r) => r.testId === "t2")?.status === "skipped" &&
    fixed?.results.find((r) => r.testId === "t3")?.status === "skipped",
  "running/pending tests become skipped after an interruption",
);
assert(
  (fixed?.results.find((r) => r.testId === "t2")?.note ?? "").includes("Interrupted"),
  "an interrupted test records why",
);

// Idempotent — a second pass finds nothing to fix.
assert(
  batchHistoryStore.reconcileInterrupted().reconciled === 0,
  "reconcileInterrupted is idempotent",
);

// ── Cap prunes oldest-first ──────────────────────────────────────────
batchHistoryStore.clear();
for (let i = 0; i < 60; i++) {
  batchHistoryStore.save(rec({ batchId: `x${i}`, startedAt: 1000 + i }));
}
const capped = batchHistoryStore.list();
assert(capped.length === 50, `caps the index at 50 (got ${capped.length})`);
assert(capped[0].batchId === "x59", "the newest batch survives the cap");
assert(
  !capped.some((b) => b.batchId === "x0"),
  "the oldest batches are pruned, not the newest",
);

// ── remove / clear ───────────────────────────────────────────────────
assert(batchHistoryStore.remove("x59").removed === 1, "remove() deletes one batch");
assert(batchHistoryStore.get("x59") === null, "a removed batch is gone");
assert(batchHistoryStore.remove("x59").removed === 0, "removing a missing batch is a no-op");
const cleared = batchHistoryStore.clear();
assert(cleared.removed === 49, `clear() reports how many it removed (got ${cleared.removed})`);
assert(batchHistoryStore.list().length === 0, "clear() empties the index");

// ── Corrupt file degrades to empty rather than throwing ──────────────
fs.writeFileSync(indexFile, "{not json", "utf-8");
assert(batchHistoryStore.list().length === 0, "a corrupt index reads as empty instead of throwing");
batchHistoryStore.save(rec({ batchId: "recovered" }));
assert(batchHistoryStore.get("recovered") !== null, "the store recovers after a corrupt read");

fs.rmSync(userData, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll batch-history checks passed");
