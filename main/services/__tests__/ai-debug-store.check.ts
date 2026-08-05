// Standalone regression check for AI debug session persistence.
//
// Drives the REAL store against a throwaway userData dir (`@glaze/core/backend`
// aliased to glaze-backend-stub.ts, whose app.getPath reads GLAZE_TEST_USERDATA).
// What matters here and is easy to break:
//   - save() UPSERTS by key — it's called repeatedly as one job streams, so
//     appending would leave dozens of records per session;
//   - the index survives a reload (that's the whole point of persisting);
//   - reconcileInterrupted() rewrites a session left as "streaming" by an app
//     that quit mid-answer — without it the icon stays orange forever for a
//     request that no longer exists anywhere;
//   - a corrupt or future-versioned file reads as EMPTY rather than throwing or
//     half-parsing into a wrong-shaped session;
//   - the cap prunes least-recently-active first.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code stand in for one. Run with:
//   npm run check:ai-debug-store

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Point the stub's app.getPath at a throwaway dir BEFORE importing the store.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-ai-debug-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { aiDebugStore } = await import("../ai-debug-store.js");
const { AI_DEBUG_SESSIONS_VERSION } = await import("../../recorder/types.js");
type AiDebugSession = Parameters<typeof aiDebugStore.save>[0];

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function sess(over: Partial<AiDebugSession> & { key: string }): AiDebugSession {
  return {
    kind: "run",
    testId: "t1",
    label: "Checkout",
    testName: "Checkout",
    status: "done",
    content: "diagnosis",
    reasoning: "",
    error: null,
    requestId: null,
    scriptHash: "abc12345",
    startedAt: 1000,
    updatedAt: 2000,
    ...over,
  } as AiDebugSession;
}

const indexFile = path.join(userData, "recorder", "ai-debug-sessions.json");

// ── Empty state ──────────────────────────────────────────────────────
assert(aiDebugStore.list().length === 0, "starts empty when no file exists");
assert(aiDebugStore.get("nope") === null, "get() on a missing session → null");
assert(aiDebugStore.reconcileInterrupted().reconciled === 0, "reconcile on empty is a no-op");

// ── Save + reload ────────────────────────────────────────────────────
aiDebugStore.save(sess({ key: "run:t1", content: "first answer" }));
assert(fs.existsSync(indexFile), "save() writes the index file");
assert(aiDebugStore.list().length === 1, "one saved session lists once");
assert(aiDebugStore.get("run:t1")?.content === "first answer", "content round-trips");

{
  const raw = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as { version: number };
  assert(raw.version === AI_DEBUG_SESSIONS_VERSION, "file carries the schema version");
}

// ── Upsert, not append ───────────────────────────────────────────────
aiDebugStore.save(sess({ key: "run:t1", content: "second answer", updatedAt: 3000 }));
assert(aiDebugStore.list().length === 1, "save() upserts by key rather than appending");
assert(aiDebugStore.get("run:t1")?.content === "second answer", "the newer answer wins");

// A streaming job saves repeatedly; simulate that and confirm it stays one row.
for (let i = 0; i < 25; i++) {
  aiDebugStore.save(sess({ key: "run:t1", content: `chunk ${i}`, updatedAt: 3000 + i }));
}
assert(aiDebugStore.list().length === 1, "25 progress saves still leave one record");

// ── Interrupted reconciliation ───────────────────────────────────────
aiDebugStore.save(
  sess({ key: "run:t2", status: "streaming", requestId: "req-live", updatedAt: 4000 }),
);
aiDebugStore.save(sess({ key: "run:t3", status: "done", updatedAt: 4100 }));

{
  const { reconciled } = aiDebugStore.reconcileInterrupted();
  assert(reconciled === 1, "reconcile rewrites exactly the streaming session");
  const t2 = aiDebugStore.get("run:t2");
  assert(t2?.status === "interrupted", "a streaming session restores as interrupted");
  assert(t2?.requestId === null, "its dead request id is cleared");
  assert(
    typeof t2?.error === "string" && t2.error.length > 0,
    "it explains why it stopped rather than looking like a clean finish",
  );
  assert(aiDebugStore.get("run:t3")?.status === "done", "a finished session is left alone");
}

{
  // Idempotent: startup can run it twice (or a later restart with nothing to
  // fix) without churning the file or re-counting.
  const { reconciled } = aiDebugStore.reconcileInterrupted();
  assert(reconciled === 0, "reconcile is idempotent");
}

// ── Ordering ─────────────────────────────────────────────────────────
{
  const keys = aiDebugStore.list().map((s) => s.key);
  const sorted = [...keys].sort(
    (a, b) =>
      (aiDebugStore.get(b)?.updatedAt ?? 0) - (aiDebugStore.get(a)?.updatedAt ?? 0),
  );
  assert(JSON.stringify(keys) === JSON.stringify(sorted), "list() is newest-activity first");
}

// ── Cap ──────────────────────────────────────────────────────────────
aiDebugStore.clear();
for (let i = 0; i < 30; i++) {
  aiDebugStore.save(sess({ key: `run:cap${i}`, updatedAt: 1000 + i }));
}
{
  const all = aiDebugStore.list();
  assert(all.length === 20, "the index is capped at 20 sessions");
  assert(all[0].key === "run:cap29", "the most recent survives");
  assert(
    all.every((s) => s.key !== "run:cap0"),
    "the least recently active is pruned",
  );
}

// ── Remove / clear ───────────────────────────────────────────────────
{
  const before = aiDebugStore.list().length;
  assert(aiDebugStore.remove("run:cap29").removed === 1, "remove() drops a session");
  assert(aiDebugStore.list().length === before - 1, "…and the index shrinks");
  assert(aiDebugStore.remove("run:cap29").removed === 0, "removing it again is a no-op");
  const { removed } = aiDebugStore.clear();
  assert(removed > 0 && aiDebugStore.list().length === 0, "clear() empties the index");
}

// ── Corrupt / foreign files ──────────────────────────────────────────
fs.writeFileSync(indexFile, "{ this is not json", "utf-8");
assert(aiDebugStore.list().length === 0, "a corrupt file reads as empty rather than throwing");
assert(aiDebugStore.get("anything") === null, "…and get() survives it too");

fs.writeFileSync(
  indexFile,
  JSON.stringify({ version: AI_DEBUG_SESSIONS_VERSION + 99, sessions: [sess({ key: "run:x" })] }),
  "utf-8",
);
assert(
  aiDebugStore.list().length === 0,
  "an unrecognized schema version reads as empty rather than half-parsing",
);

fs.writeFileSync(indexFile, JSON.stringify({ version: AI_DEBUG_SESSIONS_VERSION }), "utf-8");
assert(aiDebugStore.list().length === 0, "a file with no sessions array reads as empty");

fs.writeFileSync(indexFile, JSON.stringify([sess({ key: "run:legacy" })]), "utf-8");
assert(
  aiDebugStore.list().length === 0,
  "a bare array (no version envelope) reads as empty rather than being trusted",
);

// Writing after a corrupt read must still produce a valid file.
aiDebugStore.save(sess({ key: "run:after-corrupt" }));
assert(
  aiDebugStore.get("run:after-corrupt")?.key === "run:after-corrupt",
  "the store recovers and writes a valid file after a corrupt read",
);

// ── Atomic write ─────────────────────────────────────────────────────
assert(
  !fs.existsSync(`${indexFile}.tmp`),
  "the temp file used for the atomic rename is not left behind",
);

fs.rmSync(userData, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll AI debug store checks passed");
