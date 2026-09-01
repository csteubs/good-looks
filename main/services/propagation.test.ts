// The propagation core's contract (PR 2 of docs/plans/preemptive-updates.md).
//
// Lives here rather than beside the module because a test under shared/
// matches NEITHER vitest project — the cli-exit.test.ts precedent.
//
// Every gate is tested in both directions: the rows that admit evidence and
// the rows that refuse it are the same feature, and most of the bugs this
// engine could ship are silent (a proposal that should not exist looks
// exactly like one that should).

import { describe, expect, it } from "vitest";

import {
  AUTO_APPLY_MIN,
  donorFromEdit,
  donorsFromJournal,
  fingerprintsSimilar,
  MAX_SEEDS_PER_KEY,
  PROPAGATION_WINDOW_MS,
  PROPOSE_MIN,
  PROPOSE_ONLY_TYPES,
  proposalsFor,
  REASON_CODES,
  seedsForTest,
  type Donor,
  type ExistingProposalLike,
  type JournalEntryLike,
  type TestLike,
} from "../../shared/propagation.mjs";
import { healKeyFor } from "../../shared/heal-key.mjs";

const NOW = 1_800_000_000_000;

const OLD = { k: "testid", v: "submit" };
const NEW = { k: "testid", v: "submit-v2" };
const OTHER_NEW = { k: "role", role: "button", name: "Place order" };

function entry(over: Partial<JournalEntryLike> = {}): JournalEntryLike {
  return {
    id: "h1",
    testId: "donor",
    stepId: "d-s1",
    source: "run",
    runId: "r1",
    originalLocator: OLD,
    appliedLocator: NEW,
    applied: false,
    status: "pending",
    at: NOW - 1000,
    ...over,
  };
}

function makeTest(id: string, over: Partial<TestLike> = {}): TestLike {
  return {
    id,
    url: "https://shop.example.test/",
    steps: [],
    ...over,
  };
}

function step(id: string, locator: object | undefined, over: Record<string, unknown> = {}) {
  return { id, type: "click", locator, ...over };
}

/** One confirmed donor (accepted heal) plus its test; base confidence 0.75. */
function acceptedDonor(): Donor[] {
  return donorsFromJournal({ entries: [entry({ status: "accepted" })], now: NOW });
}

function donorTest(): TestLike {
  return makeTest("donor", { steps: [step("d-s1", OLD)] });
}

describe("donorsFromJournal — the evidence gates", () => {
  it("a reverted heal is anti-evidence, never a donor", () => {
    // Shapes that would QUALIFY under every other gate — a trainer heal, and
    // an applied run heal — so this row tests the reverted rule and not some
    // other refusal standing in front of it. (The first version used a bare
    // run entry, which the run-outcome gate also rejected: the mutation that
    // deleted the reverted rule passed the suite.)
    const trainer = entry({ status: "reverted", source: "trainer", runId: undefined });
    const applied = entry({ status: "reverted", applied: true });
    expect(donorsFromJournal({ entries: [trainer, applied], now: NOW })).toEqual([]);
  });

  it("an accepted heal is a donor even with no run outcome on record", () => {
    const donors = donorsFromJournal({ entries: [entry({ status: "accepted" })], now: NOW });
    expect(donors).toHaveLength(1);
    expect(donors[0].kind).toBe("heal-accepted");
  });

  it("a pending run heal needs its run to have PASSED", () => {
    const passed = donorsFromJournal({
      entries: [entry()],
      runsById: { r1: { status: "passed" } },
      now: NOW,
    });
    expect(passed).toHaveLength(1);
    expect(passed[0].kind).toBe("heal-run-passed");

    // A mis-heal usually succeeds at the step; the run's outcome is the
    // usable signal, so a failing run's heal proves nothing.
    const failed = donorsFromJournal({
      entries: [entry()],
      runsById: { r1: { status: "failed" } },
      now: NOW,
    });
    expect(failed).toEqual([]);
    // And no run record at all is the same honest answer.
    expect(donorsFromJournal({ entries: [entry()], now: NOW })).toEqual([]);
  });

  it("an applied run heal carries its own gate — apply-mode only writes on a passing run", () => {
    const donors = donorsFromJournal({ entries: [entry({ applied: true })], now: NOW });
    expect(donors).toHaveLength(1);
    expect(donors[0].kind).toBe("heal-run-passed");
  });

  it("a trainer heal is a donor of its own middling kind", () => {
    const donors = donorsFromJournal({ entries: [entry({ source: "trainer", runId: undefined })], now: NOW });
    expect(donors).toHaveLength(1);
    expect(donors[0].kind).toBe("heal-trainer");
  });

  it("a donor outside the recency window creates nothing", () => {
    const stale = entry({ status: "accepted", at: NOW - PROPAGATION_WINDOW_MS - 1 });
    expect(donorsFromJournal({ entries: [stale], now: NOW })).toEqual([]);
    const fresh = entry({ status: "accepted", at: NOW - PROPAGATION_WINDOW_MS + 1000 });
    expect(donorsFromJournal({ entries: [fresh], now: NOW })).toHaveLength(1);
  });

  it("no originalLocator means no from-identity — skipped", () => {
    expect(
      donorsFromJournal({ entries: [entry({ status: "accepted", originalLocator: undefined })], now: NOW }),
    ).toEqual([]);
  });

  it("a heal to a different SPELLING of the same identity is not a donor", () => {
    // nth is deliberately absent from the heal key, so an nth-only change has
    // nothing to propagate.
    const spelled = entry({ status: "accepted", appliedLocator: { ...OLD, nth: 1 } });
    expect(donorsFromJournal({ entries: [spelled], now: NOW })).toEqual([]);
  });

  it("carries the heal's page URL for origin grouping", () => {
    const donors = donorsFromJournal({
      entries: [entry({ status: "accepted", pageUrl: "https://shop.example.test/checkout" })],
      now: NOW,
    });
    expect(donors[0].pageUrl).toBe("https://shop.example.test/checkout");
  });
});

describe("donorFromEdit — a manual fix as evidence", () => {
  it("shapes a hand-made locator change into the strongest donor kind", () => {
    const donor = donorFromEdit({ testId: "t", stepId: "s", before: OLD, after: NEW, at: NOW });
    expect(donor?.kind).toBe("manual-edit");
    expect(donor?.fromKey).toBe(healKeyFor(OLD));
    expect(donor?.toKey).toBe(healKeyFor(NEW));
  });

  it("a same-key respelling or a missing side is not an edit worth propagating", () => {
    expect(donorFromEdit({ testId: "t", stepId: "s", before: OLD, after: { ...OLD, nth: 2 }, at: NOW })).toBeNull();
    expect(donorFromEdit({ testId: "t", stepId: "s", before: undefined, after: NEW, at: NOW })).toBeNull();
    expect(donorFromEdit({ testId: "t", stepId: "s", before: OLD, after: undefined, at: NOW })).toBeNull();
  });
});

describe("proposalsFor — targets and exclusions", () => {
  it("proposes for a same-origin sibling and keeps the TARGET's own spelling as the undo", () => {
    const targetLocator = { ...OLD, nth: 1 };
    const sibling = makeTest("sibling", { steps: [step("s-s1", targetLocator)] });
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donorTest(), sibling] });
    expect(out.create).toHaveLength(1);
    expect(out.create[0].testId).toBe("sibling");
    expect(out.create[0].stepId).toBe("s-s1");
    // The undo must restore the step EXACTLY, nth included — the donor's
    // spelling shares the key but is not this step's locator.
    expect(out.create[0].fromLocator).toEqual(targetLocator);
    expect(out.create[0].toLocator).toEqual(NEW);
    expect(out.create[0].origin).toBe("https://shop.example.test");
  });

  it("a different origin is a different site — no proposal", () => {
    const elsewhere = makeTest("elsewhere", {
      url: "https://other.example.test/",
      steps: [step("e-s1", OLD)],
    });
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donorTest(), elsewhere] });
    expect(out.create).toEqual([]);
  });

  it("the heal's recorded page URL outranks the donor test's start URL", () => {
    // The donor test STARTS on shop.* but the heal fired on account.* — the
    // element lives where the heal happened, so account.* siblings match and
    // shop.* siblings do not.
    const donors = donorsFromJournal({
      entries: [entry({ status: "accepted", pageUrl: "https://account.example.test/profile" })],
      now: NOW,
    });
    const onAccount = makeTest("on-account", {
      url: "https://account.example.test/",
      steps: [step("a-s1", OLD)],
    });
    const onShop = makeTest("on-shop", { steps: [step("p-s1", OLD)] });
    const out = proposalsFor({ donors, tests: [donorTest(), onAccount, onShop] });
    expect(out.create.map((p) => p.testId)).toEqual(["on-account"]);
  });

  it("imported, script-edited and diverged tests are never touched", () => {
    const imported = makeTest("imported", { sourceDir: "/proj", steps: [step("i", OLD)] });
    const edited = makeTest("edited", { scriptEdited: true, steps: [step("e", OLD)] });
    const diverged = makeTest("diverged", { stepsDiverged: true, steps: [step("v", OLD)] });
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donorTest(), imported, edited, diverged] });
    expect(out.create).toEqual([]);
  });

  it("framed and disabled steps are excluded — the heal key ignores frames, so a match there would target the wrong document", () => {
    const sibling = makeTest("sibling", {
      steps: [
        step("framed", { ...OLD, frame: [{ kind: "css", value: "iframe" }] }),
        step("off", OLD, { disabled: true }),
      ],
    });
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donorTest(), sibling] });
    expect(out.create).toEqual([]);
  });

  it("the donor's own step is excluded; a same-key sibling in the SAME test is not", () => {
    const donor = makeTest("donor", { steps: [step("d-s1", OLD), step("d-s2", OLD)] });
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donor] });
    expect(out.create.map((p) => p.stepId)).toEqual(["d-s2"]);
  });

  it("a drag's toLocator is not matched — heal evidence only ever concerns `locator`", () => {
    const sibling = makeTest("sibling", {
      steps: [{ id: "drag", type: "drag", locator: NEW, toLocator: OLD } as never],
    });
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donorTest(), sibling] });
    expect(out.create).toEqual([]);
  });
});

describe("proposalsFor — the conflict rule", () => {
  it("donors that disagree on the fix produce NO proposal, and the conflict is surfaced", () => {
    const donors = donorsFromJournal({
      entries: [
        entry({ id: "h1", status: "accepted" }),
        entry({ id: "h2", status: "accepted", appliedLocator: OTHER_NEW, stepId: "d-s2" }),
      ],
      now: NOW,
    });
    const sibling = makeTest("sibling", { steps: [step("s", OLD)] });
    const out = proposalsFor({ donors, tests: [donorTest(), sibling] });
    expect(out.create).toEqual([]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0].fromKey).toBe(healKeyFor(OLD));
    expect(out.conflicts[0].toKeys).toHaveLength(2);
  });

  it("agreeing donors merge into one proposal that says they agree", () => {
    const donors = donorsFromJournal({
      entries: [
        entry({ id: "h1", status: "accepted" }),
        entry({ id: "h2", status: "accepted", stepId: "d-s2", at: NOW - 500 }),
      ],
      now: NOW,
    });
    const sibling = makeTest("sibling", { steps: [step("s", OLD)] });
    const out = proposalsFor({ donors, tests: [donorTest(), sibling] });
    expect(out.create).toHaveLength(1);
    expect(out.create[0].donors).toHaveLength(2);
    expect(out.create[0].reasons).toContain("donors-agree");
  });
});

describe("proposalsFor — confidence, in both directions", () => {
  it("a lone trainer heal sits below the propose floor", () => {
    const donors = donorsFromJournal({ entries: [entry({ source: "trainer" })], now: NOW });
    const sibling = makeTest("sibling", { steps: [step("s", OLD)] });
    const out = proposalsFor({ donors, tests: [donorTest(), sibling] });
    expect(out.create).toEqual([]);
  });

  it("the same trainer heal crosses the floor once the target's own recorder corroborates it", () => {
    const donors = donorsFromJournal({ entries: [entry({ source: "trainer" })], now: NOW });
    const sibling = makeTest("sibling", {
      steps: [step("s", OLD, { fingerprint: { candidates: [NEW], attributes: {}, depth: 1 } })],
    });
    const out = proposalsFor({ donors, tests: [donorTest(), sibling] });
    expect(out.create).toHaveLength(1);
    expect(out.create[0].reasons).toContain("fingerprint-key-match");
    expect(out.create[0].reasons).toContain("donor-trainer");
  });

  it("a run-validated heal alone lands exactly on the floor and proposes", () => {
    const donors = donorsFromJournal({
      entries: [entry()],
      runsById: { r1: { status: "passed" } },
      now: NOW,
    });
    const sibling = makeTest("sibling", { steps: [step("s", OLD)] });
    const out = proposalsFor({ donors, tests: [donorTest(), sibling] });
    expect(out.create).toHaveLength(1);
    expect(out.create[0].confidence).toBeCloseTo(PROPOSE_MIN, 5);
  });

  it("similar fingerprints add a weak reason; absent fingerprints add nothing", () => {
    const fp = { attributes: { id: "buy", type: "submit" }, depth: 2, text: "Buy now" };
    const donor = makeTest("donor", { steps: [step("d-s1", OLD, { fingerprint: fp })] });
    const similar = makeTest("similar", { steps: [step("s1", OLD, { fingerprint: { ...fp, depth: 5 } })] });
    const bare = makeTest("bare", { steps: [step("s2", OLD)] });
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donor, similar, bare] });
    const bySite = new Map(out.create.map((p) => [p.testId, p]));
    expect(bySite.get("similar")?.reasons).toContain("fingerprint-similar");
    expect(bySite.get("bare")?.reasons).not.toContain("fingerprint-similar");
    expect(bySite.get("similar")!.confidence).toBeGreaterThan(bySite.get("bare")!.confidence);
  });

  it("a target already going red gains the target-failing reason — retried passes count as red", () => {
    const sibling = makeTest("sibling", { steps: [step("s", OLD)] });
    const failing = proposalsFor({
      donors: acceptedDonor(),
      tests: [donorTest(), sibling],
      latestRunByTest: { sibling: { status: "failed" } },
    });
    expect(failing.create[0].reasons).toContain("target-failing");

    // A run that only passed on retry is PASSED as an outcome and FAILED as a
    // signal (shared/run-attempts.mjs) — and this reads the signal.
    const retried = proposalsFor({
      donors: acceptedDonor(),
      tests: [donorTest(), sibling],
      latestRunByTest: { sibling: { status: "passed", passedOnRetry: true } },
    });
    expect(retried.create[0].reasons).toContain("target-failing");

    const green = proposalsFor({
      donors: acceptedDonor(),
      tests: [donorTest(), sibling],
      latestRunByTest: { sibling: { status: "passed" } },
    });
    expect(green.create[0].reasons).not.toContain("target-failing");
  });

  it("every emitted reason is a declared code", () => {
    const donors = donorsFromJournal({
      entries: [entry({ id: "h1", status: "accepted" }), entry({ id: "h2", status: "accepted", stepId: "d-s2" })],
      now: NOW,
    });
    const sibling = makeTest("sibling", {
      steps: [step("s", OLD, { fingerprint: { candidates: [NEW], attributes: {}, depth: 1 } })],
    });
    const out = proposalsFor({
      donors,
      tests: [donorTest(), sibling],
      latestRunByTest: { sibling: { status: "failed" } },
    });
    for (const reason of out.create[0].reasons) {
      expect(REASON_CODES).toContain(reason);
    }
  });
});

describe("proposalsFor — auto-apply eligibility", () => {
  it("high confidence WITH strong corroboration is eligible", () => {
    const sibling = makeTest("sibling", {
      steps: [step("s", OLD, { fingerprint: { candidates: [NEW], attributes: {}, depth: 1 } })],
    });
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donorTest(), sibling] });
    expect(out.create[0].confidence).toBeGreaterThanOrEqual(AUTO_APPLY_MIN);
    expect(out.create[0].autoApplyEligible).toBe(true);
  });

  it("the same confidence WITHOUT strong corroboration or agreement is not", () => {
    // accepted (0.75) + similar (0.1) reaches the number but not the bar: one
    // donor, weak corroboration.
    const fp = { attributes: { id: "buy", type: "submit" }, depth: 2 };
    const donor = makeTest("donor", { steps: [step("d-s1", OLD, { fingerprint: fp })] });
    const sibling = makeTest("sibling", { steps: [step("s", OLD, { fingerprint: { ...fp } })] });
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donor, sibling] });
    expect(out.create[0].confidence).toBeGreaterThanOrEqual(AUTO_APPLY_MIN);
    expect(out.create[0].autoApplyEligible).toBe(false);
  });

  it("two agreeing donors satisfy the corroboration bar on their own", () => {
    const donors = donorsFromJournal({
      entries: [entry({ id: "h1", status: "accepted" }), entry({ id: "h2", status: "accepted", stepId: "d-s2" })],
      now: NOW,
    });
    const sibling = makeTest("sibling", { steps: [step("s", OLD)] });
    const out = proposalsFor({ donors, tests: [donorTest(), sibling] });
    expect(out.create[0].autoApplyEligible).toBe(true);
  });

  it.each(PROPOSE_ONLY_TYPES.map((t) => [t]))(
    "a %s step is propose-only at any confidence — its success never proves the element was right",
    (type) => {
      const sibling = makeTest("sibling", {
        steps: [step("s", OLD, { type, fingerprint: { candidates: [NEW], attributes: {}, depth: 1 } })],
      });
      const out = proposalsFor({ donors: acceptedDonor(), tests: [donorTest(), sibling] });
      expect(out.create).toHaveLength(1);
      expect(out.create[0].autoApplyEligible).toBe(false);
    },
  );
});

describe("proposalsFor — dedupe, supersede, settled decisions, staleness", () => {
  const sibling = () => makeTest("sibling", { steps: [step("s", OLD)] });

  function pending(over: Partial<ExistingProposalLike> = {}): ExistingProposalLike {
    return {
      id: "p1",
      testId: "sibling",
      stepId: "s",
      status: "pending",
      fromLocator: OLD,
      toLocator: NEW,
      confidence: 0.75,
      reasons: ["donor-accepted"],
      donors: [{}],
      ...over,
    };
  }

  it("an identical sweep is idempotent — no create, no refresh churn", () => {
    const out = proposalsFor({ donors: acceptedDonor(), tests: [donorTest(), sibling()], existing: [pending()] });
    expect(out.create).toEqual([]);
    expect(out.refresh).toEqual([]);
    expect(out.supersede).toEqual([]);
  });

  it("new agreeing evidence refreshes the pending entry in place", () => {
    const donors = donorsFromJournal({
      entries: [entry({ id: "h1", status: "accepted" }), entry({ id: "h2", status: "accepted", stepId: "d-s2" })],
      now: NOW,
    });
    const out = proposalsFor({ donors, tests: [donorTest(), sibling()], existing: [pending()] });
    expect(out.create).toEqual([]);
    expect(out.refresh).toHaveLength(1);
    expect(out.refresh[0].id).toBe("p1");
    expect(out.refresh[0].donors).toHaveLength(2);
  });

  it("a different fix for the same element supersedes rather than edits", () => {
    const out = proposalsFor({
      donors: acceptedDonor(),
      tests: [donorTest(), sibling()],
      existing: [pending({ toLocator: OTHER_NEW })],
    });
    expect(out.create).toEqual([]);
    expect(out.supersede).toHaveLength(1);
    expect(out.supersede[0].id).toBe("p1");
    expect(out.supersede[0].next.toLocator).toEqual(NEW);
  });

  it("a dismissed proposal for the same fix is asked-and-answered — never recreated", () => {
    const out = proposalsFor({
      donors: acceptedDonor(),
      tests: [donorTest(), sibling()],
      existing: [pending({ status: "dismissed" })],
    });
    expect(out.create).toEqual([]);
  });

  it("a dismissal of a DIFFERENT fix does not block a new one", () => {
    const out = proposalsFor({
      donors: acceptedDonor(),
      tests: [donorTest(), sibling()],
      existing: [pending({ status: "dismissed", toLocator: OTHER_NEW })],
    });
    expect(out.create).toHaveLength(1);
  });

  it("a pending entry whose target moved goes stale", () => {
    const moved = makeTest("sibling", { steps: [step("s", OTHER_NEW)] });
    const out = proposalsFor({ donors: [], tests: [moved], existing: [pending()] });
    expect(out.stale).toEqual(["p1"]);
  });

  it("a pending entry whose test is gone goes stale", () => {
    const out = proposalsFor({ donors: [], tests: [], existing: [pending()] });
    expect(out.stale).toEqual(["p1"]);
  });

  it("a pending entry whose target still matches is left alone", () => {
    const out = proposalsFor({ donors: [], tests: [sibling()], existing: [pending()] });
    expect(out.stale).toEqual([]);
  });
});

describe("seedsForTest — protecting runs without touching tests", () => {
  const targetTest = () => makeTest("sibling", { steps: [step("s", OLD)] });

  function pendingSeed(over: Partial<ExistingProposalLike> = {}): ExistingProposalLike {
    return {
      id: "p1",
      testId: "sibling",
      stepId: "s",
      status: "pending",
      fromLocator: OLD,
      toLocator: NEW,
      confidence: 0.75,
      ...over,
    };
  }

  it("keys seeds by the heal-map key and orders them best-first, capped", () => {
    const proposals = [
      pendingSeed({ id: "p1", toLocator: NEW, confidence: 0.6 }),
      pendingSeed({ id: "p2", toLocator: OTHER_NEW, confidence: 0.9 }),
      pendingSeed({ id: "p3", toLocator: { k: "label", v: "Submit" }, confidence: 0.7 }),
      pendingSeed({ id: "p4", toLocator: { k: "text", v: "Submit" }, confidence: 0.5 }),
    ];
    const seeds = seedsForTest({ test: targetTest(), proposals });
    const key = healKeyFor(OLD);
    expect(Object.keys(seeds)).toEqual([key]);
    expect(seeds[key]).toHaveLength(MAX_SEEDS_PER_KEY);
    expect(seeds[key][0]).toEqual(OTHER_NEW);
    expect(seeds[key][1]).toEqual({ k: "label", v: "Submit" });
  });

  it("a proposal whose step moved seeds nothing — the key would fire for the wrong reason", () => {
    const moved = makeTest("sibling", { steps: [step("s", OTHER_NEW)] });
    expect(seedsForTest({ test: moved, proposals: [pendingSeed()] })).toEqual({});
  });

  it("settled proposals and other tests' proposals seed nothing", () => {
    expect(
      seedsForTest({ test: targetTest(), proposals: [pendingSeed({ status: "dismissed" })] }),
    ).toEqual({});
    expect(
      seedsForTest({ test: targetTest(), proposals: [pendingSeed({ testId: "someone-else" })] }),
    ).toEqual({});
  });

  it("duplicate fixes collapse to the strongest copy", () => {
    const proposals = [
      pendingSeed({ id: "p1", confidence: 0.6 }),
      pendingSeed({ id: "p2", confidence: 0.9 }),
    ];
    const seeds = seedsForTest({ test: targetTest(), proposals });
    expect(seeds[healKeyFor(OLD)]).toHaveLength(1);
  });
});

describe("fingerprintsSimilar — every arm, both ways", () => {
  it("equal non-empty own text", () => {
    expect(fingerprintsSimilar({ text: "Buy now" }, { text: "Buy now" })).toBe(true);
    expect(fingerprintsSimilar({ text: "" }, { text: "" })).toBe(false);
    expect(fingerprintsSimilar({ text: "Buy" }, { text: "Sell" })).toBe(false);
  });

  it("equal non-empty neighbour text", () => {
    expect(fingerprintsSimilar({ neighborText: "Billing" }, { neighborText: "Billing" })).toBe(true);
    expect(fingerprintsSimilar({ neighborText: "" }, { neighborText: "" })).toBe(false);
  });

  it("two identifying attributes agree; one alone does not", () => {
    expect(
      fingerprintsSimilar(
        { attributes: { id: "buy", type: "submit" } },
        { attributes: { id: "buy", type: "submit", href: "/x" } },
      ),
    ).toBe(true);
    expect(
      fingerprintsSimilar({ attributes: { id: "buy" } }, { attributes: { id: "buy" } }),
    ).toBe(false);
  });

  it("nearby centres agree; distant ones do not", () => {
    const at = (x: number, y: number) => ({ rect: { x, y, w: 0.1, h: 0.05 } });
    expect(fingerprintsSimilar(at(0.4, 0.4), at(0.45, 0.44))).toBe(true);
    expect(fingerprintsSimilar(at(0.1, 0.1), at(0.8, 0.8))).toBe(false);
  });

  it("absent fingerprints are never similar", () => {
    expect(fingerprintsSimilar(undefined, { text: "x" })).toBe(false);
    expect(fingerprintsSimilar({ text: "x" }, undefined)).toBe(false);
  });
});
