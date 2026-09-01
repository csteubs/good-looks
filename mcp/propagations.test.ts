// What `list_propagations` reports.
//
// Two properties carry the weight here. The aggregate has to say "this site
// shipped a change" rather than "here are some rows" — that is the whole
// reason the tool reports more than a list. And the entries are an EGRESS
// BOUNDARY: they are rebuilt from named keys, so a field added to
// `PropagationEntry` later cannot ship to an external MCP client because
// nobody looked at this file.

import { describe, expect, it } from "vitest";

import { propagationDigest, SITE_CHANGING_MIN_TESTS } from "./propagations.mjs";

const SHOP = "https://shop.example.com";
const DOCS = "https://docs.example.com";

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    testId: "t1",
    stepId: "s1",
    stepLabel: 'getByTestId("submit-v1").click()',
    origin: SHOP,
    donorPageUrl: "https://shop.example.com/cart",
    fromLocator: { k: "testid", v: "submit-v1" },
    toLocator: { k: "testid", v: "submit-v2" },
    donors: [
      { kind: "heal-accepted", testId: "t9", stepId: "d1", healEntryId: "h1", runId: "r1", at: 5 },
    ],
    confidence: 0.9,
    reasons: ["donor-accepted"],
    autoApplyEligible: true,
    applied: false,
    status: "pending",
    at: 1_000,
    ...over,
  };
}

const NAMES: Record<string, string> = { t1: "Checkout", t2: "Account", t9: "Login" };
const nameOf = (id: string) => NAMES[id] ?? null;

describe("propagationDigest — picking and paging", () => {
  it("reports newest first, with the totals a caller would otherwise recount", () => {
    const out = propagationDigest(
      [
        entry({ id: "a", at: 1 }),
        entry({ id: "b", at: 3 }),
        entry({ id: "c", at: 2, status: "dismissed" }),
      ],
      { nameOf },
    );
    expect(out.entries.map((e) => e.id)).toEqual(["b", "c", "a"]);
    expect(out.total).toBe(3);
    // `pending` is scope-wide and status-independent: it answers "how much is
    // waiting on me", which a status-filtered list cannot.
    expect(out.pending).toBe(2);
  });

  it("filters to one test, and to one status", () => {
    // Distinct times: an assertion on order must not rest on how a tie sorts.
    const rows = [
      entry({ id: "a", testId: "t1", status: "pending", at: 3 }),
      entry({ id: "b", testId: "t2", status: "pending", at: 2 }),
      entry({ id: "c", testId: "t1", status: "accepted", at: 1 }),
    ];
    expect(propagationDigest(rows, { testId: "t1" }).entries.map((e) => e.id)).toEqual(["a", "c"]);
    expect(propagationDigest(rows, { status: "pending" }).entries.map((e) => e.id)).toEqual([
      "a",
      "b",
    ]);
    expect(
      propagationDigest(rows, { testId: "t1", status: "accepted" }).entries.map((e) => e.id),
    ).toEqual(["c"]);
  });

  it("honours the limit without lying about the total", () => {
    const rows = Array.from({ length: 10 }, (_, i) => entry({ id: `p${i}`, at: i }));
    const out = propagationDigest(rows, { limit: 3 });
    expect(out.entries).toHaveLength(3);
    expect(out.total).toBe(10);
  });

  it("survives a file that is not what it should be", () => {
    // The store normalizes on read, but this module reads the FILE — which a
    // user, or a half-written save, can leave in any state.
    expect(propagationDigest(null as never).entries).toEqual([]);
    expect(propagationDigest([null, 3, "x", { noId: true }] as never[]).entries).toEqual([]);
    expect(propagationDigest([]).sitesChanging).toEqual([]);
  });
});

describe("propagationDigest — the site aggregate", () => {
  it("calls out a site once a second TEST is waiting on it", () => {
    const out = propagationDigest([
      entry({ id: "a", testId: "t1", origin: SHOP }),
      entry({ id: "b", testId: "t2", origin: SHOP }),
    ]);
    expect(out.sitesChanging).toEqual([{ origin: SHOP, proposals: 2, tests: 2 }]);
    expect(SITE_CHANGING_MIN_TESTS).toBe(2);
  });

  it("stays quiet about several proposals inside ONE test", () => {
    // Two steps of one test is a test that needs a look, not a site that
    // shipped a change — and reporting it as the latter is how a caller
    // learns to skim the field.
    const out = propagationDigest([
      entry({ id: "a", testId: "t1", stepId: "s1", origin: SHOP }),
      entry({ id: "b", testId: "t1", stepId: "s2", origin: SHOP }),
    ]);
    expect(out.sitesChanging).toEqual([]);
  });

  it("counts only what is still waiting on a decision", () => {
    // A site whose proposals were all answered is not a site that is
    // changing; it is a question already closed.
    const out = propagationDigest([
      entry({ id: "a", testId: "t1", origin: SHOP, status: "dismissed" }),
      entry({ id: "b", testId: "t2", origin: SHOP, status: "accepted" }),
    ]);
    expect(out.sitesChanging).toEqual([]);
  });

  it("ranks the busiest site first and keeps the sites apart", () => {
    const out = propagationDigest([
      entry({ id: "a", testId: "t1", origin: SHOP }),
      entry({ id: "b", testId: "t2", origin: SHOP }),
      entry({ id: "c", testId: "t3", origin: SHOP }),
      entry({ id: "d", testId: "t1", origin: DOCS }),
      entry({ id: "e", testId: "t2", origin: DOCS }),
    ]);
    expect(out.sitesChanging).toEqual([
      { origin: SHOP, proposals: 3, tests: 3 },
      { origin: DOCS, proposals: 2, tests: 2 },
    ]);
  });

  it("scopes the aggregate to the test filter, so it cannot contradict the list", () => {
    const out = propagationDigest(
      [
        entry({ id: "a", testId: "t1", origin: SHOP }),
        entry({ id: "b", testId: "t2", origin: SHOP }),
      ],
      { testId: "t1" },
    );
    expect(out.sitesChanging).toEqual([]);
    expect(out.pending).toBe(1);
  });
});

describe("propagationDigest — what crosses to the client", () => {
  it("names the target test and every donor test, rather than handing over ids", () => {
    const out = propagationDigest([entry()], { nameOf });
    const row = out.entries[0];
    expect(row.testName).toBe("Checkout");
    expect(row.donorTests).toEqual([{ testId: "t9", testName: "Login" }]);
    expect(row.donorCount).toBe(1);
    expect(row.donorKinds).toEqual(["heal-accepted"]);
  });

  it("degrades to a null name for a test that is gone, rather than dropping the row", () => {
    const out = propagationDigest([entry({ testId: "deleted" })], { nameOf });
    expect(out.entries[0].testName).toBeNull();
    expect(out.entries).toHaveLength(1);
  });

  it("REBUILDS the row — a new store field does not ship because nobody looked", () => {
    // The property, stated as a property: whatever else is on the entry, the
    // wire shape is exactly these keys. Spreading the entry would make this
    // test fail the day someone adds a field, which is the point.
    const out = propagationDigest(
      [entry({ secretNewField: "not for the wire", donors: [] } as never)],
      { nameOf },
    );
    expect(Object.keys(out.entries[0]).sort()).toEqual(
      [
        "applied",
        "at",
        "autoApplyEligible",
        "confidence",
        "donorCount",
        "donorKinds",
        "donorPageUrl",
        "donorTests",
        "fromLocator",
        "id",
        "match",
        "origin",
        "reasons",
        "status",
        "stepId",
        "stepLabel",
        "testId",
        "testName",
        "toLocator",
      ].sort(),
    );
    expect(JSON.stringify(out)).not.toContain("not for the wire");
  });

  it("reports whether a proposal is an exact match or a near miss", () => {
    // Different claims: a near miss targets a step whose locator is NOT the
    // one that was fixed, only one pinned on the same identifier, and it is
    // never auto-applied. A caller deciding whether to act on a proposal is
    // deciding a different question in each case.
    expect(propagationDigest([entry({ match: "near-miss" })]).entries[0].match).toBe("near-miss");
    expect(propagationDigest([entry({ match: "exact" })]).entries[0].match).toBe("exact");
    // Stored before the field existed, and before near misses could happen.
    expect(propagationDigest([entry({ match: undefined })]).entries[0].match).toBe("exact");
    // Never a value the file supplied.
    expect(propagationDigest([entry({ match: "whatever" })]).entries[0].match).toBe("exact");
  });

  it("omits the absent optionals rather than sending nulls", () => {
    const row = propagationDigest([entry({ donorPageUrl: undefined, decidedAt: undefined })])
      .entries[0];
    expect("donorPageUrl" in row).toBe(false);
    expect("decidedAt" in row).toBe(false);
  });

  it("carries the decision timestamp once there is one", () => {
    const row = propagationDigest([entry({ status: "accepted", decidedAt: 2_000 })]).entries[0];
    expect(row.decidedAt).toBe(2_000);
    expect(row.status).toBe("accepted");
  });
});
