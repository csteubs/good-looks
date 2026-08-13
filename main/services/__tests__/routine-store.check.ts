// Standalone regression check for the Routine store. docs/ROUTINES.md.
//
// Drives the REAL store against a throwaway userData dir (`@shell/backend`
// aliased to shell-backend-stub.ts, whose app.getPath reads GLAZE_TEST_USERDATA).
// The migration's own rules are unit-tested in `routine-migration.test.ts`;
// what is only observable HERE is everything that involves the file:
//
//   - `ensureMigrated` is idempotent BY A RECORDED FLAG, not by an emptiness
//     test — the difference is whether a deleted migrated Routine comes back
//     on the next launch, forever;
//   - it records having run even when it produced NOTHING, which is the
//     ordinary case and the one an emptiness test gets wrong;
//   - a hand-edited file is normalized ON READ, not just on write;
//   - `markTestDeleted` MARKS rather than removes, so a saved job does not
//     silently shrink;
//   - `createdAt` belongs to the record, so an editor echoing a stale value
//     cannot re-date a job and reorder the list under the user.
//
// No test runner exists for these (see package.json) — plain assertions + a
// non-zero exit code stand in for one. Run with:
//   npm run check:routine-store

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Point the stub's app.getPath at a throwaway dir BEFORE importing the store.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-routines-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { routineStore } = await import("../routine-store.js");
const { MAX_ROUTINES, MAX_ROUTINE_STEPS } = await import("../../recorder/types.js");
type RoutineStep = import("../../recorder/types.js").RoutineStep;
type RoutineTestStep = import("../../recorder/types.js").RoutineTestStep;

/** The test steps of a Routine, asserted rather than cast: everything below
 *  builds a Routine of test steps, so a `group` appearing here would be a
 *  real defect and `filter` would hide it where this throws. */
function testSteps(steps: readonly RoutineStep[]): RoutineTestStep[] {
  return steps.map((s) => {
    if (s.kind !== "test") throw new Error(`expected a test step, got ${s.kind}`);
    return s;
  });
}


let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const indexFile = path.join(userData, "recorder", "routines.json");

function readRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(indexFile, "utf-8")) as Record<string, unknown>;
}

function writeRaw(value: unknown): void {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(value), "utf-8");
}

function step(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "test",
    testId: "t-a",
    browsers: ["chromium"],
    headless: true,
    onFailure: "continue",
    ...over,
  };
}

function routine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r-1",
    name: "Smoke",
    createdAt: 1_000,
    updatedAt: 1_000,
    steps: [step()],
    defaults: { captureArtifacts: false, concurrency: 2 },
    ...over,
  };
}

// ── Empty state ──────────────────────────────────────────────────────
assert(routineStore.list().length === 0, "starts empty when no file exists");
assert(routineStore.get("nope") === null, "get() on a missing routine → null");

// ── Save + reload ────────────────────────────────────────────────────
const saved = routineStore.save(routine(), 2_000);
assert(saved !== null, "a well-formed routine saves");
assert(fs.existsSync(indexFile), "save() writes the index file");
assert(routineStore.get("r-1")?.name === "Smoke", "a saved routine is retrievable by id");
assert(saved?.updatedAt === 2_000, "save() stamps updatedAt from the clock it was handed");
assert(saved?.createdAt === 1_000, "a new routine keeps the createdAt it arrived with");
// The store re-reads the file on every call, so this genuinely round-trips disk.
assert(
  (readRaw().routines as Array<Record<string, unknown>>)[0].id === "r-1",
  "the routine survives as JSON on disk (survives a restart)",
);
assert(readRaw().version === 1, "the file is an envelope carrying a version");

// ── Upsert, and createdAt belongs to the record ──────────────────────
const edited = routineStore.save(routine({ name: "Smoke v2", createdAt: 99_000 }), 3_000);
assert(routineStore.list().length === 1, "save() upserts by id rather than appending");
assert(edited?.name === "Smoke v2", "the edit is stored");
assert(
  edited?.createdAt === 1_000,
  "createdAt comes from the stored record, not the payload — an editor echoing a stale value cannot re-date a job",
);
assert(edited?.updatedAt === 3_000, "updatedAt moves with the edit");

// ── Rebuild, not filter ──────────────────────────────────────────────
const hostile = routineStore.save(
  routine({
    id: "r-2",
    name: "   ",
    steps: [
      step({ testId: "t-b", browsers: ["webkit", "webkit", "nope"] }),
      step({ testId: "t-b", browsers: ["firefox"] }),
      step({ testId: "t-c", browsers: [] }),
      step({ testId: "t-d", onFailure: "explode" }),
      { kind: "wait", ms: 10 },
      "not a step",
    ],
    defaults: { captureArtifacts: "yes", concurrency: 0 },
    extraKeyNobodyDeclared: "carried?",
  }),
  4_000,
);
assert(hostile !== null, "a routine with junk in it still saves what is runnable");
assert(hostile?.name === "Untitled routine", "a blank name becomes something pointable");
assert(
  testSteps(hostile?.steps ?? []).map((s) => s.testId).join(",") === "t-b,t-d",
  "engines are validated and deduped, an engineless step is dropped, an unbuilt kind is dropped",
);
assert(
  testSteps(hostile?.steps ?? [])[0].browsers.join(",") === "webkit",
  "a duplicate engine cannot run one test twice on one browser",
);
assert(
  hostile?.steps.length === 2,
  "two steps naming one test collapse — the runner serialises them into one lane, so keeping both draws a job that lies",
);
assert(
  testSteps(hostile?.steps ?? [])[1].onFailure === "continue",
  "an unknown failure policy falls back",
);
assert(hostile?.defaults.captureArtifacts === false, "a truthy non-boolean is not true");
assert(hostile?.defaults.concurrency === 1, "a zero lane count is not honoured");
assert(
  !("extraKeyNobodyDeclared" in (hostile as unknown as Record<string, unknown>)),
  "an undeclared key does not survive the rebuild",
);
assert(routineStore.save({ name: "no id" }, 4_000) === null, "a routine with no id is refused");
assert(routineStore.save("nope", 4_000) === null, "a non-object is refused");

// ── The schedule ─────────────────────────────────────────────────────
const scheduled = routineStore.save(
  routine({
    id: "r-sched",
    schedule: { kind: "dailyAt", minute: 570 },
    lastScheduledRunAt: 12_345,
  }),
  4_000,
);
assert(
  JSON.stringify(scheduled?.schedule) === JSON.stringify({ kind: "dailyAt", minute: 570 }),
  "a valid schedule round-trips",
);
assert(
  scheduled?.lastScheduledRunAt === 12_345,
  "and so does the record of when it last fired — the store never invents it",
);
const badSchedule = routineStore.save(
  routine({ id: "r-bad-sched", schedule: { kind: "everyHours", hours: 5 } }),
  4_000,
);
assert(
  badSchedule !== null && badSchedule.schedule === undefined,
  "an hour step that does not divide the day is DROPPED, not rounded — a rounded cadence is one nobody chose",
);
assert(
  routineStore.save(routine({ id: "r-no-sched" }), 4_000)?.schedule === undefined,
  "a routine with no schedule stays unscheduled",
);
assert(
  routineStore.save(
    routine({ id: "r-junk-stamp", lastScheduledRunAt: "yesterday" }),
    4_000,
  )?.lastScheduledRunAt === undefined,
  "a last-fired stamp that is not a time is dropped rather than carried into the scheduler",
);
routineStore.remove("r-sched");
routineStore.remove("r-bad-sched");
routineStore.remove("r-no-sched");
routineStore.remove("r-junk-stamp");

// ── markTestDeleted MARKS ────────────────────────────────────────────
const before = routineStore.get("r-2")?.steps.length ?? 0;
const marked = routineStore.markTestDeleted("t-b");
assert(marked.marked === 1, "the step naming the deleted test is marked");
assert(
  routineStore.get("r-2")?.steps.length === before,
  "the step is KEPT — silently shrinking a saved job is the bug this guards",
);
assert(
  testSteps(routineStore.get("r-2")?.steps ?? []).find((s) => s.testId === "t-b")?.testDeleted ===
    true,
  "and it is flagged so the editor can render it broken",
);
assert(routineStore.markTestDeleted("t-b").marked === 0, "marking twice is a no-op");
assert(routineStore.markTestDeleted("t-nothing").marked === 0, "an unknown test marks nothing");

// ── remove ───────────────────────────────────────────────────────────
assert(routineStore.remove("r-2").removed === 1, "remove() removes by id");
assert(routineStore.get("r-2") === null, "and it is gone");
assert(routineStore.remove("r-2").removed === 0, "removing twice is a no-op");

// ── A hand-edited file is untrusted input too ────────────────────────
writeRaw({
  version: 1,
  routines: [
    routine({ id: "r-3", steps: [step({ browsers: ["nope"] })] }),
    { id: "", name: "no id" },
    "not a routine",
  ],
});
const reread = routineStore.list();
assert(reread.length === 1, "unusable records in a hand-edited file are dropped on READ");
assert(
  reread[0].steps.length === 0,
  "a step with no valid engine is dropped on read, not only on write",
);

// ── ensureMigrated ───────────────────────────────────────────────────
// A fresh dir, because the file above has no migration flag but does have
// routines in it — which is exactly the state an emptiness test gets wrong.
const userData2 = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-routines-2-"));
process.env.GLAZE_TEST_USERDATA = userData2;
const indexFile2 = path.join(userData2, "recorder", "routines.json");

const batchSettings = {
  batchOrder: ["t-a", "t-b"],
  batchTestOptions: {
    "t-a": { selected: true, browsers: ["chromium"], headless: true },
    "t-b": { selected: false, browsers: ["firefox"], headless: false },
  },
  defaultCaptureArtifacts: true,
  defaultBatchConcurrency: 3,
};

const first = routineStore.ensureMigrated(batchSettings, ["t-a", "t-b"], 5_000);
assert(first.migrated === true, "the first launch migrates the Batch checklist");
assert(first.routine?.name === "Batch", "the migrated routine keeps the word the user knows");
assert(
  testSteps(first.routine?.steps ?? []).map((s) => s.testId).join(",") === "t-a",
  "only the ticked row comes across — an absent or unticked row is not in the batch",
);
assert(first.routine?.defaults.concurrency === 3, "the batch's own lane count comes across");
assert(first.routine?.defaults.captureArtifacts === true, "so does artifact capture");
assert(
  typeof (JSON.parse(fs.readFileSync(indexFile2, "utf-8")) as Record<string, unknown>)
    .migratedFromBatchAt === "number",
  "the file records that the migration ran",
);

const second = routineStore.ensureMigrated(batchSettings, ["t-a", "t-b"], 6_000);
assert(second.migrated === false, "a second launch does not migrate again");
assert(routineStore.list().length === 1, "and does not produce a second copy");

// THE CASE AN EMPTINESS TEST GETS WRONG: the user deletes the migrated job.
routineStore.remove(first.routine!.id);
routineStore.ensureMigrated(batchSettings, ["t-a", "t-b"], 7_000);
assert(
  routineStore.list().length === 0,
  "a deleted migrated routine STAYS deleted — the flag is what makes this true, an empty list would resurrect it forever",
);

// ── The ordinary case: nothing was ever ticked ───────────────────────
const userData3 = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-routines-3-"));
process.env.GLAZE_TEST_USERDATA = userData3;
const nothing = routineStore.ensureMigrated(
  { batchOrder: ["t-a"], batchTestOptions: {} },
  ["t-a"],
  8_000,
);
assert(nothing.migrated === false, "a user who never ticked a row gets no routine");
assert(
  routineStore.list().length === 0,
  "and no empty job named Batch appears in their library as if they made it",
);
assert(
  routineStore.ensureMigrated(batchSettings, ["t-a", "t-b"], 9_000).migrated === false,
  "a migration that produced nothing is still recorded as having run",
);

// ── Ordering ─────────────────────────────────────────────────────────
const userData4 = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-routines-4-"));
process.env.GLAZE_TEST_USERDATA = userData4;
routineStore.save(routine({ id: "r-old", createdAt: 100 }), 10_000);
routineStore.save(routine({ id: "r-new", createdAt: 900 }), 10_001);
// EDIT THE NEWER ONE, deliberately. Editing the older one leaves "oldest
// createdAt first" and "most recently edited first" agreeing, and the
// assertion then passes against the ordering it exists to rule out.
routineStore.save(routine({ id: "r-new", createdAt: 900, name: "edited" }), 20_000);
assert(
  routineStore
    .list()
    .map((r) => r.id)
    .join(",") === "r-old,r-new",
  "the list is oldest first and an edit does NOT jump a row to the top under the user",
);

// ── Groups ────────────────────────────────────────────────────────────
//
// Capability 3's first slice. A group is pure structure over test steps, and
// the properties worth pinning are the ones that are silent when wrong.

{
  const saved = routineStore.save({
    id: "r-groups",
    name: "Grouped",
    steps: [
      { kind: "test", testId: "t-a", browsers: ["chromium"], headless: false, onFailure: "continue" },
      {
        kind: "group",
        id: "g-1",
        label: "Seed",
        steps: [
          { kind: "test", testId: "t-b", browsers: ["webkit"], headless: true, onFailure: "skipGroup" },
          // Same test as the top-level step above. The lane invariant is
          // GLOBAL — the runner keys a live run by testId — so one test in a
          // group and again outside it is the same collision as one test twice.
          { kind: "test", testId: "t-a", browsers: ["chromium"], headless: false, onFailure: "continue" },
        ],
      },
      // The reverse direction of the same rule: a test claimed INSIDE a group
      // must not reappear at the top level after it. `seen` is threaded
      // through rather than copied per group precisely so additions inside one
      // are visible to everything that follows.
      { kind: "test", testId: "t-b", browsers: ["chromium"], headless: false, onFailure: "continue" },
      // Empty after normalisation: a group `skipGroup` can point at with
      // nothing inside is a step that can never do anything.
      { kind: "group", id: "g-2", label: "Empty", steps: [] },
      // One level deep. A nested group is dropped rather than flattened.
      { kind: "group", id: "g-3", label: "Outer", steps: [{ kind: "group", id: "g-4", label: "Inner", steps: [] }] },
    ],
    defaults: { captureArtifacts: false, concurrency: 1 },
  } as unknown as Parameters<typeof routineStore.save>[0]);

  assert(
    saved?.steps.length === 2,
    "a group is stored beside top-level steps, and a test claimed inside one does not reappear after it",
  );
  const group = saved?.steps[1];
  assert(group?.kind === "group" && group.id === "g-1", "a group keeps the position it was written in");
  assert(
    group?.kind === "group" && group.steps.map((c) => c.testId).join(",") === "t-b",
    "a test already claimed at the top level does not reappear inside a group",
  );
  assert(
    group?.kind === "group" && group.steps[0].onFailure === "skipGroup",
    "skipGroup survives now that there is a group for it to point at",
  );
  assert(
    !saved?.steps.some((st) => st.kind === "group" && st.id === "g-2"),
    "an empty group is dropped — it is a container nothing can happen in",
  );
  assert(
    !saved?.steps.some((st) => st.kind === "group" && st.id === "g-3"),
    "a group containing only another group is dropped: v1 is one level deep",
  );
}

{
  // `markTestDeleted` reaches inside. A broken step nested in a group is more
  // invisible than one at the top level, not less: the group still renders and
  // simply runs one test fewer than it lists.
  routineStore.save({
    id: "r-mark",
    name: "Marked",
    steps: [
      {
        kind: "group",
        id: "g-1",
        label: "Seed",
        steps: [
          { kind: "test", testId: "t-x", browsers: ["chromium"], headless: false, onFailure: "continue" },
        ],
      },
    ],
    defaults: { captureArtifacts: false, concurrency: 1 },
  } as unknown as Parameters<typeof routineStore.save>[0]);

  assert(routineStore.markTestDeleted("t-x").marked === 1, "a step inside a group is marked");
  const after = routineStore.get("r-mark")?.steps[0];
  assert(
    after?.kind === "group" && after.steps[0].testDeleted === true,
    "a marked step inside a group is KEPT and flagged, not removed",
  );
}


// ── Caps ─────────────────────────────────────────────────────────────
const userData5 = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-routines-5-"));
process.env.GLAZE_TEST_USERDATA = userData5;
const manySteps = Array.from({ length: MAX_ROUTINE_STEPS + 20 }, (_, i) =>
  step({ testId: `t-${i}` }),
);
assert(
  routineStore.save(routine({ steps: manySteps }), 1)?.steps.length === MAX_ROUTINE_STEPS,
  "a routine's steps are capped, bounding both the file and one IPC payload",
);
for (let i = 0; i < MAX_ROUTINES; i++) routineStore.save(routine({ id: `cap-${i}` }), 1);
assert(routineStore.list().length === MAX_ROUTINES, "the index fills to the cap");
assert(routineStore.save(routine({ id: "one-too-many" }), 1) === null, "and refuses past it");
assert(
  routineStore.save(routine({ id: "cap-0", name: "still editable" }), 2)?.name ===
    "still editable",
  "a full index can still be EDITED — refusing a save because the list is full would trap the user with jobs they cannot fix",
);

console.log(failures === 0 ? "\nAll routine-store checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
