// Standalone regression check for the heal journal and the accept/revert path.
//
// The journal exists because Auto-Heal used to change what a test targets and
// leave no trace. What makes that dangerous is that a MIS-heal usually
// succeeds: clicking the wrong button rarely throws, so the step was marked
// passed and the test quietly stopped testing what it was written to test.
//
// So the properties worth pinning are all about not losing the way back:
//   • the original locator is stored, or there is no undo;
//   • revert actually restores it, and only when something was applied;
//   • pruning never drops a PENDING entry — that entry IS the undo record;
//   • the two apply modes differ in exactly one way (does the test change?).
//
// Driven against the real store writing to a temp userData dir. Bundled with
// esbuild + the @glaze/core/backend stub — see package.json. Run with:
//   npm run check:heal-journal

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { healJournalStore, type HealEntry } from "../heal-journal-store.js";
import { buildHealMap, healKeyFor } from "../playwright-runner.js";
import type { Locator, Step } from "../../recorder/types.js";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-heal-journal-check-"));
process.env.GLAZE_TEST_USERDATA = userData;

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

const oldLoc: Locator = { k: "testid", v: "submit-v1" };
const newLoc: Locator = { k: "testid", v: "submit-v2" };

function record(testId: string, overrides: Partial<HealEntry> = {}): HealEntry {
  return healJournalStore.record({
    testId,
    stepId: "step-1",
    stepIndex: 0,
    stepLabel: 'getByTestId("submit-v1").click()',
    source: "run",
    runId: "run-1",
    originalLocator: oldLoc,
    appliedLocator: newLoc,
    candidates: [],
    applied: true,
    ...overrides,
  });
}

function main(): void {
  // ── 1. Recording and reading back ────────────────────────────────────────
  const a = record("t1");
  assert(!!a.id, "a recorded heal gets an id");
  assertEqual(a.status, "pending", "a new heal starts pending");
  assertEqual(
    healJournalStore.list("t1").length,
    1,
    "a recorded heal is listed for its test",
  );
  assertEqual(healJournalStore.list("t2").length, 0, "the journal is scoped per test");
  assertEqual(
    healJournalStore.get(a.id)?.originalLocator,
    oldLoc,
    "the ORIGINAL locator is stored — without it there is no undo",
  );

  // Newest first: the review panel shows the most recent change at the top,
  // which is the one most likely to still be a surprise.
  const b = record("t1", { stepId: "step-2", at: Date.now() + 1000 });
  assertEqual(healJournalStore.list("t1")[0].id, b.id, "the journal lists newest first");

  // ── 2. Pending vs settled ────────────────────────────────────────────────
  assertEqual(healJournalStore.pending("t1").length, 2, "both new heals are pending");
  healJournalStore.setStatus(a.id, "accepted");
  assertEqual(healJournalStore.pending("t1").length, 1, "an accepted heal leaves the queue");
  assertEqual(
    healJournalStore.get(a.id)?.status,
    "accepted",
    "an accepted heal keeps its history entry",
  );
  healJournalStore.setStatus(b.id, "reverted");
  assertEqual(healJournalStore.pending("t1").length, 0, "a reverted heal leaves the queue too");
  assertEqual(healJournalStore.setStatus("nope", "accepted"), null, "an unknown id returns null");

  // ── 3. Clearing history keeps what still needs a decision ────────────────
  const c = record("t1", { stepId: "step-3" });
  const cleared = healJournalStore.clearSettled("t1");
  assertEqual(cleared.removed, 2, "clearing history removes only settled entries");
  assertEqual(
    healJournalStore.list("t1").map((e) => e.id),
    [c.id],
    "a pending heal survives clearing history",
  );

  // ── 4. Deleting a test takes its journal with it ─────────────────────────
  record("t9");
  healJournalStore.deleteTest("t9");
  assertEqual(healJournalStore.list("t9").length, 0, "deleting a test drops its heals");
  assertEqual(healJournalStore.list("t1").length, 1, "…and leaves other tests alone");

  // ── 5. The cap never drops a pending entry ───────────────────────────────
  //
  // A pending entry is the user's only record of a change already made to their
  // test. Pruning by age alone would eventually delete the undo for a heal
  // nobody had reviewed yet — silently, and precisely on the busy tests where
  // it matters most.
  healJournalStore.deleteTest("cap");
  for (let i = 0; i < 210; i++) {
    const e = record("cap", { stepId: `s${i}` });
    // Settle most of them, leaving a handful pending across the whole range.
    if (i % 20 !== 0) healJournalStore.setStatus(e.id, "accepted");
  }
  const capped = healJournalStore.list("cap");
  assert(capped.length <= 200, `the journal is capped per test (got ${capped.length})`);
  assertEqual(
    capped.filter((e) => e.status === "pending").length,
    11,
    "every pending entry survives the cap",
  );

  // ── 6. The heal map the run-time fixture reads ───────────────────────────
  const step = (partial: Partial<Step> & Pick<Step, "type" | "id">): Step =>
    ({ timestamp: 0, ...partial }) as Step;
  const steps: Step[] = [
    step({ id: "a", type: "goto", url: "https://example.com" }),
    step({ id: "b", type: "click", locator: { k: "testid", v: "submit" } }),
    step({ id: "c", type: "fill", locator: { k: "label", v: "Email" }, value: "x" }),
    step({ id: "d", type: "click", locator: { k: "testid", v: "off" }, disabled: true }),
  ];
  const map = buildHealMap(steps);
  assertEqual(
    Object.keys(map).sort(),
    ["label|Email", "testid|submit"],
    "the heal map covers locator-bearing steps only",
  );
  assert(
    !("testid|off" in map),
    "a disabled step is left out — it never runs, so it can never need healing",
  );
  const entry = map["testid|submit"] as { stepId: string; probe: string };
  assertEqual(entry.stepId, "b", "each map entry names the step it came from");
  assert(
    entry.probe.includes("MAX_CANDIDATES"),
    "each map entry carries a pre-built probe script",
  );
  // The probe is built from the SAME function the trainer uses. If this ever
  // stopped being true there would be two ranking implementations to keep in
  // step, and ranking is where every Auto-Heal bug so far has lived.
  assert(
    entry.probe.includes("scoreAgainstFingerprint"),
    "the probe is the same one the trainer runs, fingerprint scoring included",
  );

  // Keys must match what the fixture tags locators with; heal-fixture.test.ts
  // cross-checks the two implementations directly.
  assertEqual(healKeyFor({ k: "role", role: "button" }), "role|button|", "a nameless role keys cleanly");

  fs.rmSync(userData, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll heal-journal checks passed");
}

main();
