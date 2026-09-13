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
// It happened again with `tabsOpened` (the tabs the page opened and the run
// followed): the runner spread it in, this type did not name it, and the count
// reached the record for a CLI run and never for an app one — so `triage_run`
// told a reader the browser opened no tabs on exactly the runs the app drove.
// A field the runner passes is only persisted if it is asserted here.
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

describe("append: tabsOpened", () => {
  it("persists the count the runner passes, through the file", () => {
    // The runner spreads it in only when positive; the store must still name
    // it, or the spread is dropped with no compile error.
    const opened = 2;
    const rec = runHistoryStore.append(
      { ...base("t1"), ...(opened > 0 ? { tabsOpened: opened } : {}) },
      "log",
    );
    expect(rec.tabsOpened).toBe(2);

    const stored = runHistoryStore.list().find((r) => r.id === "t1");
    expect(stored?.tabsOpened).toBe(2);
  });

  it("absent stays absent for a run that opened no tabs", () => {
    // Absent must keep reading the same as a row predating the field, which is
    // why the runner sends nothing at zero and the store refuses one anyway.
    runHistoryStore.append({ ...base("t2") }, "log");
    runHistoryStore.append({ ...base("t3"), tabsOpened: 0 }, "log");
    const all = runHistoryStore.list();
    expect("tabsOpened" in (all.find((r) => r.id === "t2") ?? {})).toBe(false);
    expect("tabsOpened" in (all.find((r) => r.id === "t3") ?? {})).toBe(false);
  });

  it("a non-integer count is refused, not stored", () => {
    runHistoryStore.append({ ...base("t4"), tabsOpened: 1.5 as unknown as number }, "log");
    expect("tabsOpened" in (runHistoryStore.list().find((r) => r.id === "t4") ?? {})).toBe(false);
  });
});

describe("append: siteHealth", () => {
  const summary = {
    pages: 3,
    ms: 420,
    hosts: [{ host: "shop.example.com", pages: 3, seo: 88, perf: 61 }],
  };

  it("persists the summary the runner passes, through the file", () => {
    runHistoryStore.append({ ...base("r-sh"), siteHealth: summary }, "log");
    const stored = runHistoryStore.list().find((r) => r.id === "r-sh");
    expect(stored?.siteHealth).toEqual(summary);
  });

  it("keeps a measured-nothing summary, because it is a finding about the probe", () => {
    runHistoryStore.append({ ...base("r-sh0"), siteHealth: { pages: 0, ms: 12, hosts: [] } }, "log");
    const stored = runHistoryStore.list().find((r) => r.id === "r-sh0");
    expect(stored?.siteHealth).toEqual({ pages: 0, ms: 12, hosts: [] });
  });

  it("absent stays absent for a run that did not measure", () => {
    runHistoryStore.append(base("r-sh-none"), "log");
    const stored = runHistoryStore.list().find((r) => r.id === "r-sh-none");
    expect(stored).toBeDefined();
    expect("siteHealth" in (stored ?? {})).toBe(false);
  });
});

describe("append: stepsDigest", () => {
  // Same failure shape as `tabsOpened` above, and the same reason it is worth a
  // block here: the runner spreads the digest in, and if this type does not
  // name it the field is dropped with no compile error at all. What the drop
  // would cost is the run panel's strongest sentence — with no digest on the
  // record, every recovery reads as "we cannot tell", forever, silently.
  const DIGEST = "s1:0123456789abcdef";

  it("persists the digest the runner passes, through the file", () => {
    const rec = runHistoryStore.append({ ...base("r-sd"), stepsDigest: DIGEST }, "log");
    expect(rec.stepsDigest).toBe(DIGEST);
    const stored = runHistoryStore.list().find((r) => r.id === "r-sd");
    expect(stored?.stepsDigest).toBe(DIGEST);
  });

  it("persists it on a FAILED run too", () => {
    // The comparison the panel makes is against the failing run, so a digest
    // written only on passes would answer nothing.
    runHistoryStore.append(
      { ...base("r-sd-fail", "failed"), stepsDigest: DIGEST },
      "log",
    );
    const stored = runHistoryStore.list().find((r) => r.id === "r-sd-fail");
    expect(stored?.stepsDigest).toBe(DIGEST);
  });

  it("refuses a mis-shaped digest rather than storing it", () => {
    // Two other processes write this file. A bad token stored here would be
    // compared against a good one for the rest of that run's life, and the
    // comparison would be wrong in the confident direction.
    for (const [id, bad] of [
      ["r-sd-b1", "0123456789abcdef"],
      ["r-sd-b2", "s1:nothexatall!!!"],
      ["r-sd-b3", "s1:0123456789abcdef0"],
      ["r-sd-b4", ""],
    ] as const) {
      runHistoryStore.append({ ...base(id), stepsDigest: bad }, "log");
      const stored = runHistoryStore.list().find((r) => r.id === id);
      expect(stored).toBeDefined();
      expect("stepsDigest" in (stored ?? {})).toBe(false);
    }
  });

  it("absent stays absent, and absent is UNKNOWN to every reader", () => {
    runHistoryStore.append(base("r-sd-none"), "log");
    const stored = runHistoryStore.list().find((r) => r.id === "r-sd-none");
    expect(stored).toBeDefined();
    expect("stepsDigest" in (stored ?? {})).toBe(false);
  });
});
