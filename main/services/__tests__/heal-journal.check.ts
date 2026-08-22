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
//   • a bulk clear doesn't either, for the same reason, while an explicit
//     single delete does — that one is the user's own call;
//   • the two apply modes differ in exactly one way (does the test change?).
//
// Driven against the real store writing to a temp userData dir. Bundled with
// esbuild + the @shell/backend stub — see package.json. Run with:
//   npm run check:heal-journal

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { healJournalStore, type HealEntry } from "../heal-journal-store.js";
import { buildHealMap, collectRunHeals, healKeyFor } from "../playwright-runner.js";
import { testStore } from "../test-store.js";
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

  // ── 3b. listAll spans every test ─────────────────────────────────────────
  //
  // The Heals VIEW is cross-test: a locator that keeps breaking is often the
  // same element in several tests, and a per-test list cannot show that.
  {
    healJournalStore.deleteTest("all-a");
    healJournalStore.deleteTest("all-b");
    record("all-a", { stepId: "x", at: 1000 });
    record("all-b", { stepId: "y", at: 3000 });
    record("all-a", { stepId: "z", at: 2000 });
    const all = healJournalStore.listAll().filter((e) => e.testId.startsWith("all-"));
    assertEqual(all.length, 3, "listAll returns heals from every test");
    assertEqual(
      all.map((e) => e.stepId),
      ["y", "z", "x"],
      "listAll is newest first ACROSS tests, not grouped by test",
    );
    assertEqual(
      healJournalStore.list("all-a").length,
      2,
      "…and the per-test list is unaffected",
    );
  }

  // ── 3c. Deleting individual records ──────────────────────────────────────
  //
  // The Heals view lets the user delete a record outright. Two properties
  // matter: it removes exactly one entry (a heal's id is the only thing telling
  // two heals of the same step apart), and an unknown id is a no-op rather than
  // a throw — the view can fire a delete twice from a double-click.
  {
    healJournalStore.deleteTest("del");
    const d1 = record("del", { stepId: "d1" });
    const d2 = record("del", { stepId: "d2" });
    assertEqual(healJournalStore.remove(d1.id), { removed: 1 }, "removing a heal reports one removed");
    assertEqual(
      healJournalStore.list("del").map((e) => e.stepId),
      ["d2"],
      "…and takes only that one with it",
    );
    assertEqual(healJournalStore.get(d1.id), null, "a removed heal is really gone");
    assertEqual(
      healJournalStore.remove(d1.id),
      { removed: 0 },
      "removing it again is a no-op, not an error",
    );
    assertEqual(
      healJournalStore.remove("no-such-id"),
      { removed: 0 },
      "an unknown id removes nothing",
    );

    // A PENDING entry can be removed too — the prune cap protects the user from
    // silently losing an undo they never saw, but an explicit delete is the
    // user's own call. The UI is what has to spell out the cost first.
    assertEqual(healJournalStore.get(d2.id)?.status, "pending", "d2 is still pending");
    assertEqual(healJournalStore.remove(d2.id), { removed: 1 }, "an explicit delete can remove a pending heal");
  }

  // ── 3d. Clearing settled history across every test ───────────────────────
  //
  // The cross-test sibling of clearSettled, for the Heals view. Same rule: a
  // pending entry is a live undo, so a bulk clear must never take one.
  {
    healJournalStore.deleteTest("ca-a");
    healJournalStore.deleteTest("ca-b");
    const keepA = record("ca-a", { stepId: "keep" });
    const goneA = record("ca-a", { stepId: "gone" });
    const goneB = record("ca-b", { stepId: "gone-b" });
    healJournalStore.setStatus(goneA.id, "accepted");
    healJournalStore.setStatus(goneB.id, "reverted");

    const before = healJournalStore.listAll().filter((e) => e.status === "pending").length;
    const swept = healJournalStore.clearAllSettled();
    assert(swept.removed > 0, `clearAllSettled reports what it removed (${swept.removed})`);
    assertEqual(
      healJournalStore.listAll().filter((e) => e.status !== "pending").length,
      0,
      "clearAllSettled leaves no settled entry, in any test",
    );
    assertEqual(
      healJournalStore.listAll().length,
      before,
      "…and every pending entry survives — a pending entry is a live undo",
    );
    assertEqual(
      healJournalStore.get(keepA.id)?.stepId,
      "keep",
      "the pending entry kept is the right one",
    );
    assertEqual(
      healJournalStore.clearAllSettled(),
      { removed: 0 },
      "clearing an already-clear history removes nothing",
    );
  }

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

  // ── The run-outcome gate ─────────────────────────────────────────────────
  //
  // A mis-heal usually SUCCEEDS at the step, so "the healed step got past" is
  // not evidence the heal was right — the RUN's outcome is. A heal is baked into
  // the test on disk only on a PASSING run; on a failing apply-run it is
  // journalled for review (applied:false) and the locator on disk is left as it
  // was. Driven through the real `collectRunHeals` against a temp heals.json and
  // a real test in the store.
  {
    const healEvent = {
      outcome: "healed",
      stepId: "step-1",
      stepIndex: 0,
      stepLabel: 'getByTestId("submit-v1").click()',
      originalLocator: oldLoc,
      appliedLocator: newLoc,
      candidates: [],
      at: Date.now(),
    };
    // A fresh heals.json in a fresh scratch dir per call — collectRunHeals
    // removes the dir on every path out.
    const seedHealDir = (): string => {
      const dir = fs.mkdtempSync(path.join(userData, "heal-scratch-"));
      fs.writeFileSync(path.join(dir, "heals.json"), JSON.stringify([healEvent]));
      return dir;
    };
    const seedTest = (id: string): void => {
      testStore.save({
        id,
        name: id,
        url: "https://x.test",
        createdAt: 1,
        updatedAt: 1,
        steps: [{ id: "step-1", type: "click", timestamp: 0, locator: oldLoc } as Step],
        scriptPath: path.join(userData, "recorder", "scripts", id + ".spec.ts"),
      });
    };
    const stepLoc = (id: string): Locator | undefined =>
      testStore.get(id)?.steps.find((st) => st.id === "step-1")?.locator;

    // apply + FAILED run: journalled, but the test on disk is untouched.
    seedTest("hg-fail");
    const rFail = collectRunHeals("hg-fail", "run-fail", seedHealDir(), "apply", false);
    assertEqual(rFail.healed, 1, "a heal on a failed run is still counted");
    assertEqual(stepLoc("hg-fail"), oldLoc, "a failed run does NOT change the locator on disk");
    const failEntry = healJournalStore.list("hg-fail").find((e) => e.runId === "run-fail");
    assert(!!failEntry, "the heal on a failed run is journalled for review");
    assertEqual(failEntry?.applied, false, "…as a suggestion (applied:false), not a change");

    // apply + PASSED run: baked into the test on disk.
    seedTest("hg-pass");
    const rPass = collectRunHeals("hg-pass", "run-pass", seedHealDir(), "apply", true);
    assertEqual(rPass.healed, 1, "a heal on a passing run is counted");
    assertEqual(stepLoc("hg-pass"), newLoc, "a passing run applies the healed locator to disk");
    const passEntry = healJournalStore.list("hg-pass").find((e) => e.runId === "run-pass");
    assertEqual(passEntry?.applied, true, "…and the journal marks it applied");

    // suggest mode never writes, pass or fail — the outcome gate only tightens
    // apply mode, it does not loosen suggest.
    seedTest("hg-suggest");
    collectRunHeals("hg-suggest", "run-suggest", seedHealDir(), "suggest", true);
    assertEqual(stepLoc("hg-suggest"), oldLoc, "suggest mode leaves the locator alone even on a pass");
    assertEqual(
      healJournalStore.list("hg-suggest").find((e) => e.runId === "run-suggest")?.applied,
      false,
      "…and journals the suggestion as unapplied",
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll heal-journal checks passed");
}

main();
