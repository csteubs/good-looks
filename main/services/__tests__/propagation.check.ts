// Standalone regression check for cross-test propagation's app half: the
// store, the service's one apply path, and the boundaries around both.
//
// The engine's rules live in shared/propagation.mjs and are unit-tested (and
// mutation-verified) in main/services/propagation.test.ts. What THIS check
// pins is everything that could go quietly wrong around them:
//
//   • suggest mode never touches tests.json — the whole "out of the way"
//     promise is that nothing changes on disk without an accept;
//   • the ONE apply path refuses stale / script-edited / imported / live-
//     recording targets, and marks stale correctly;
//   • revert restores the TARGET's own locator, and only when applied;
//   • pruning never drops a pending entry — pending is the review queue AND,
//     when applied, the only undo record;
//   • a locator this feature writes survives generate → parse → generate as
//     a FIXED POINT, or a later hand edit silently drops the step;
//   • the heal journal's five consumers never read propagations.json — the
//     miscount that made script-change-store a separate file;
//   • the kill switch is a real off: no proposals computed, no seeds emitted.
//
// Driven against the real stores in a temp userData dir. Bundled with esbuild
// + the @shell/backend stub — see package.json. Run with:
//   npm run check:propagation

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { propagationStore, type PropagationEntry } from "../propagation-store.js";
import { propagationService } from "../propagation-service.js";
import { healJournalStore } from "../heal-journal-store.js";
import { recorderSettingsStore } from "../recorder-settings-store.js";
import { testStore } from "../test-store.js";
import { generateSpec } from "../script-generator.js";
import { parseSpecDetailed } from "../spec-parser.js";
import { healKeyFor } from "../../../shared/heal-key.mjs";
import type { Locator, Step } from "../../recorder/types.js";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-propagation-check-"));
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

function assertThrows(fn: () => unknown, contains: string, label: string): void {
  try {
    fn();
    failures++;
    console.error(`FAIL ${label} — expected a throw`);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (msg.includes(contains)) {
      console.log(`ok   ${label}`);
    } else {
      failures++;
      console.error(`FAIL ${label} — threw "${msg}", expected it to mention "${contains}"`);
    }
  }
}

const OLD: Locator = { k: "testid", v: "submit" };
const NEW: Locator = { k: "testid", v: "submit-v2" };

const step = (id: string, locator: Locator | undefined, over: Partial<Step> = {}): Step =>
  ({ id, type: "click", timestamp: 0, locator, ...over }) as Step;

function seedTest(id: string, steps: Step[], over: Record<string, unknown> = {}): void {
  testStore.save({
    id,
    name: id,
    url: "https://shop.example.test/",
    createdAt: 1,
    updatedAt: 1,
    steps,
    scriptPath: path.join(userData, "recorder", "scripts", id + ".spec.ts"),
    ...over,
  } as never);
}

function stepLoc(testId: string, stepId: string): Locator | undefined {
  return testStore.get(testId)?.steps.find((s) => s.id === stepId)?.locator;
}

function proposalFor(testId: string, over: Partial<PropagationEntry> = {}): PropagationEntry {
  const entry = propagationStore.record({
    testId,
    stepId: "s1",
    stepLabel: "click submit",
    origin: "https://shop.example.test",
    fromLocator: OLD,
    toLocator: NEW,
    donors: [{ kind: "heal-accepted", testId: "donor", stepId: "d1", at: 1 }],
    confidence: 0.95,
    reasons: ["donor-accepted", "fingerprint-key-match"],
    autoApplyEligible: true,
    ...over,
  } as never);
  if (!entry) throw new Error("test fixture entry refused");
  return entry;
}

function main(): void {
  // ── 0. Before init, nothing may write to a test ──────────────────────────
  seedTest("pre-init", [step("s1", OLD)]);
  const preInit = proposalFor("pre-init");
  assertThrows(
    () => propagationService.applyEntry(preInit.id),
    "recording session",
    "before init every apply is refused — the conservative default",
  );

  propagationService.init({ isRecording: () => false });

  // ── 1. The store: lifecycle, normalization, pruning ──────────────────────
  {
    const e = proposalFor("store-t");
    assertEqual(e.status, "pending", "a recorded proposal starts pending");
    assertEqual(e.applied, false, "…and unapplied");
    assert(!!propagationStore.get(e.id), "it reads back by id");

    const settled = propagationStore.setStatus(e.id, "dismissed");
    assertEqual(settled?.status, "dismissed", "setStatus settles it");
    assert(typeof settled?.decidedAt === "number", "settling stamps decidedAt");
    assertEqual(
      propagationStore.refresh(e.id, {
        confidence: 0.5,
        reasons: [],
        donors: [],
        autoApplyEligible: false,
      }),
      null,
      "refresh touches only PENDING entries — a settled one is history",
    );

    // Normalized on the way out: a hand-mangled file drops the bad rows.
    const file = path.join(userData, "recorder", "propagations.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>[];
    raw.push({ ...raw[0], id: "evil", status: "totally-new-status" });
    raw.push({ ...raw[0], id: "evil2", fromLocator: { k: "not-a-kind", v: "x" } });
    const withReasons = {
      ...raw[0],
      id: "noisy",
      status: "pending",
      reasons: ["donor-accepted", "made-up-reason", 42],
      confidence: 7,
    };
    raw.push(withReasons);
    fs.writeFileSync(file, JSON.stringify(raw), "utf-8");
    const readBack = propagationStore.listAll();
    assert(
      !readBack.some((x) => x.id === "evil" || x.id === "evil2"),
      "an unknown status or locator kind drops the ENTRY, not repaired",
    );
    const noisy = readBack.find((x) => x.id === "noisy");
    assertEqual(noisy?.reasons, ["donor-accepted"], "unknown reason codes are filtered out");
    assertEqual(noisy?.confidence, 1, "confidence is clamped to the 0-1 scale");

    // Pruning: settled first, never pending.
    for (let i = 0; i < 60; i++) {
      const p = proposalFor("cap-t", { stepId: `s${i}` } as never);
      if (i % 10 !== 0) propagationStore.setStatus(p.id, "dismissed");
    }
    const capped = propagationStore.list("cap-t");
    assert(capped.length <= 50, `the store is capped per test (got ${capped.length})`);
    assertEqual(
      capped.filter((x) => x.status === "pending").length,
      6,
      "every pending entry survives the cap — pending is the review queue and the undo",
    );
  }

  // ── 2. Suggest mode never touches tests.json ─────────────────────────────
  {
    recorderSettingsStore.set({ autoHealApply: "suggest", propagateFixes: true });
    seedTest("donor", [step("d1", OLD)]);
    seedTest("sibling", [
      step("s1", OLD, {
        fingerprint: { candidates: [NEW], attributes: {}, depth: 1 } as never,
      }),
    ]);
    const heal = healJournalStore.record({
      testId: "donor",
      stepId: "d1",
      stepIndex: 0,
      stepLabel: "click submit",
      source: "run",
      runId: "r-donor",
      originalLocator: OLD,
      appliedLocator: NEW,
      candidates: [],
      applied: true,
    });
    healJournalStore.setStatus(heal.id, "accepted");

    propagationService.noteHealAccepted();

    const pending = propagationStore.pending("sibling");
    assertEqual(pending.length, 1, "an accepted heal proposes for the same-origin sibling");
    assert(pending[0].autoApplyEligible, "…judged auto-apply eligible (key-match corroboration)");
    assertEqual(
      stepLoc("sibling", "s1"),
      OLD,
      "SUGGEST MODE NEVER WRITES — the sibling's locator on disk is untouched",
    );
    assert(
      pending[0].stepLabel.length > 0,
      "the proposal carries a human step label from describeStep",
    );

    // The sweep is idempotent: running it again neither duplicates nor churns.
    propagationService.noteHealAccepted();
    assertEqual(
      propagationStore.pending("sibling").length,
      1,
      "a second sweep is a no-op — no duplicate proposals",
    );

    // Seeds derive from the pending proposal, keyed by the heal key.
    const seeds = propagationService.seedsFor("sibling");
    assertEqual(Object.keys(seeds), [healKeyFor(OLD)], "seeds are keyed by the heal key");
    assertEqual(seeds[healKeyFor(OLD)], [NEW] as never, "…and carry the proposed locator");
  }

  // ── 3. The one apply path, and its refusals ──────────────────────────────
  {
    const pending = propagationStore.pending("sibling")[0];

    // Live recording refusal (probe injected true for this one call).
    propagationService.init({ isRecording: (id) => id === "sibling" });
    assertThrows(
      () => propagationService.applyEntry(pending.id),
      "recording session",
      "a live recording session refuses the apply — the trainer would discard it",
    );
    propagationService.init({ isRecording: () => false });

    // Accept: the step changes, the spec regenerates, the entry settles.
    const accepted = propagationService.applyEntry(pending.id);
    assertEqual(accepted.status, "accepted", "accepting settles the entry");
    assertEqual(accepted.applied, true, "…and marks the test as actually changed");
    assertEqual(stepLoc("sibling", "s1"), NEW, "accepting writes the proposed locator");
    const spec = fs.readFileSync(testStore.get("sibling")!.scriptPath, "utf-8");
    assert(spec.includes('getByTestId("submit-v2")'), "…and the regenerated spec emits it");
    assertThrows(
      () => propagationService.applyEntry(pending.id),
      "already settled",
      "a settled proposal cannot be applied twice",
    );

    // Revert: the step goes back, byte-for-byte.
    const reverted = propagationService.revertEntry(pending.id);
    assertEqual(reverted.status, "reverted", "reverting settles the entry");
    assertEqual(stepLoc("sibling", "s1"), OLD, "…and restores the TARGET's own locator");

    // Dismiss never touches the test.
    seedTest("dismiss-t", [step("s1", OLD)]);
    const d = proposalFor("dismiss-t");
    propagationStore.setStatus(d.id, "dismissed");
    assertEqual(stepLoc("dismiss-t", "s1"), OLD, "dismissing leaves the test alone");

    // Stale: the step moved under the proposal.
    seedTest("stale-t", [step("s1", { k: "role", role: "button", name: "Buy" })]);
    const st = proposalFor("stale-t");
    assertThrows(
      () => propagationService.applyEntry(st.id),
      "changed since",
      "a target whose locator moved refuses the apply",
    );
    assertEqual(
      propagationStore.get(st.id)?.status,
      "stale",
      "…and the entry is marked stale, not left pending",
    );

    // Script-edited and imported tests are never written.
    seedTest("edited-t", [step("s1", OLD)], { scriptEdited: true });
    const se = proposalFor("edited-t");
    assertThrows(
      () => propagationService.applyEntry(se.id),
      "hand-edited",
      "a script-edited test refuses the apply",
    );
    seedTest("imported-t", [step("s1", OLD)], { sourceDir: "/somewhere" });
    const si = proposalFor("imported-t");
    assertThrows(
      () => propagationService.applyEntry(si.id),
      "imported",
      "an imported test refuses the apply",
    );

    // Revert on an unapplied entry is just a decline — no write.
    const un = proposalFor("dismiss-t", { stepId: "s1" } as never);
    const undone = propagationService.revertEntry(un.id);
    assertEqual(undone.status, "reverted", "reverting an unapplied proposal declines it");
    assertEqual(stepLoc("dismiss-t", "s1"), OLD, "…without touching the test");
  }

  // ── 4. Auto-apply obeys the mode and the eligibility bit ─────────────────
  {
    recorderSettingsStore.set({ autoHealApply: "apply" });
    seedTest("auto-t", [
      step("a1", OLD, { fingerprint: { candidates: [NEW], attributes: {}, depth: 1 } as never }),
      step("a2", OLD, { type: "assert" } as never),
    ]);
    propagationService.noteHealAccepted();
    assertEqual(
      stepLoc("auto-t", "a1"),
      NEW,
      "apply-mode auto-applies an eligible proposal without review",
    );
    assertEqual(
      stepLoc("auto-t", "a2"),
      OLD,
      "an assert step is propose-only whatever the mode — its success proves nothing",
    );
    const autoEntries = propagationStore.list("auto-t");
    assert(
      autoEntries.some((x) => x.status === "accepted" && x.applied),
      "the auto-applied entry lands accepted+applied — the reviewable record",
    );
    assert(
      autoEntries.some((x) => x.status === "pending" && x.stepId === "a2"),
      "…while the assert step's proposal stays pending for a person",
    );
    recorderSettingsStore.set({ autoHealApply: "suggest" });
  }

  // ── 5. Manual-edit donors ────────────────────────────────────────────────
  {
    // Its own from-key, deliberately: the earlier sections left an accepted
    // heal for OLD's key in the journal, and a manual fix that DISAGREES with
    // it would (correctly) hit the conflict rule and propose nothing — which
    // this section learned the hard way on its first run.
    const EDITOR_OLD: Locator = { k: "testid", v: "editor-btn" };
    seedTest("editor", [step("m1", EDITOR_OLD)]);
    seedTest("editor-sibling", [step("m2", EDITOR_OLD)]);
    propagationService.noteManualEdits({
      testId: "editor",
      before: [step("m1", EDITOR_OLD)],
      after: [step("m1", { k: "label", v: "Submit order" })],
    });
    const proposed = propagationStore.pending("editor-sibling");
    assertEqual(proposed.length, 1, "a hand-fixed locator proposes for the sibling");
    assertEqual(
      proposed[0]?.toLocator,
      { k: "label", v: "Submit order" },
      "…with the same fix",
    );
  }

  // ── 6. The kill switch is a real off ─────────────────────────────────────
  {
    // Its own from-key (the section-5 lesson): with a key shared with earlier
    // sections, the conflict rule would refuse the proposal EVEN WITH THE
    // SWITCH BROKEN, and this section would pass vacuously — which is exactly
    // how the first kill-switch mutation escaped.
    const OFF_OLD: Locator = { k: "testid", v: "off-btn" };
    recorderSettingsStore.set({ propagateFixes: false });
    seedTest("off-donor", [step("o1", OFF_OLD)]);
    seedTest("off-sibling", [step("o2", OFF_OLD)]);
    const offHeal = healJournalStore.record({
      testId: "off-donor",
      stepId: "o1",
      stepIndex: 0,
      stepLabel: "click",
      source: "trainer",
      originalLocator: OFF_OLD,
      appliedLocator: { k: "label", v: "Off" },
      candidates: [],
      applied: false,
    });
    healJournalStore.setStatus(offHeal.id, "accepted");
    propagationService.noteHealAccepted();
    assertEqual(
      propagationStore.pending("off-sibling").length,
      0,
      "propagateFixes off computes no proposals",
    );
    assertEqual(propagationService.seedsFor("off-sibling"), {}, "…and emits no seeds");
    recorderSettingsStore.set({ propagateFixes: true });

    // With the switch back ON the same evidence proposes — the row above
    // measured the switch, not an accident of the fixture.
    propagationService.noteHealAccepted();
    assertEqual(
      propagationStore.pending("off-sibling").length,
      1,
      "the same evidence proposes once the switch is on again",
    );
  }

  // ── 7. A written locator is a generate → parse → generate fixed point ────
  {
    const chained: Locator = {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", v: "billing-card" }, withinHasText: "Billing" },
    };
    seedTest("round-t", [step("s1", OLD)]);
    const rp = proposalFor("round-t", { toLocator: chained } as never);
    propagationService.applyEntry(rp.id);
    const storedBack = stepLoc("round-t", "s1");
    const specOf = (l: Locator): string =>
      generateSpec(
        {
          name: "round",
          url: "https://shop.example.test/",
          steps: [step("s1", l)],
        } as never,
        { resolveFlow: () => null } as never,
      );
    const once = specOf(storedBack!);
    const reparsed = parseSpecDetailed(once);
    assertEqual(reparsed.skipped, 0, "the emitted step re-parses — nothing dropped");
    const parsedStep = reparsed.steps.find((s) => s.locator);
    assert(!!parsedStep, "the re-parsed spec still carries a locator-bearing step");
    const twice = specOf(parsedStep!.locator as Locator);
    assertEqual(twice, once, "generate → parse → generate is a FIXED POINT for written locators");
  }

  // ── 8. The heal journal's five consumers never read this store ───────────
  {
    const consumers = [
      "main/services/metrics-store.ts",
      "shared/rollup.mjs",
      "main/services/flake-source.ts",
      "mcp/server.mjs",
    ];
    for (const file of consumers) {
      const src = fs.readFileSync(file, "utf-8");
      assert(
        !src.includes("propagations.json") && !src.includes("propagation-store"),
        `${file} never reads the propagation store — proposals must not count as heals`,
      );
    }
    // Positive control: the scanner would notice the string where it DOES
    // exist, so a green run above means absence, not blindness.
    const own = fs.readFileSync("main/services/propagation-store.ts", "utf-8");
    assert(own.includes("propagations.json"), "the scan target string exists where expected");
  }

  fs.rmSync(userData, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll propagation checks passed");
}

main();
