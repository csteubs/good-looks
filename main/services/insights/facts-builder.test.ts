// The facts builder, over seeded deps.
//
// The claims worth pinning are the honest-degradation ones: a missing metrics
// DB must come out as null (never zero), a cluster that predates the window
// must not be reported as "new", and a valid Shopify signature must not be
// escalated into a warning. Plus the caps — an unbounded list here is an
// unbounded prompt.

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../../recorder/types.js";
import { buildInsightFacts, type InsightFactsDeps } from "./facts-builder.js";

const DAY = 86_400_000;
const NOW = new Date(2026, 7, 18, 12, 0).getTime();
const WINDOW = { since: NOW - 7 * DAY, until: NOW };

function run(over: Partial<RunRecord>): RunRecord {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    testId: "t1",
    testName: "Login",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: NOW - DAY,
    finishedAt: NOW - DAY + 1000,
    durationMs: 1000,
    logFile: "",
    logBytes: 0,
    ...over,
  } as RunRecord;
}

/** A fake metrics handle: answers the two insights queries by SQL shape. */
function fakeDb(opts: {
  clusters?: { signature: string; runs: number; tests: number; firstSeenAt: number; lastSeenAt: number }[];
  changed?: number;
}) {
  return {
    prepare(sql: string) {
      return {
        all: () => {
          if (sql.includes("error_signature")) return opts.clusters ?? [];
          if (sql.includes("diff_state")) return [{ changed: opts.changed ?? 0 }];
          return [];
        },
      };
    },
  };
}

function makeDeps(over: Partial<InsightFactsDeps> = {}): InsightFactsDeps {
  return {
    runs: () => [],
    prunedDays: () => [],
    tests: () => [{ id: "t1", name: "Login", createdAt: NOW - 30 * DAY }],
    metricsDb: () => null,
    pendingHeals: () => 0,
    unreviewedScriptChanges: () => 0,
    routines: () => [],
    shopifyStatuses: async () => [],
    appVersion: () => "1.0.0",
    lastSeenAppVersion: () => null,
    ...over,
  };
}

describe("buildInsightFacts", () => {
  it("digest covers the window and heals sum from run records", async () => {
    const { facts, stats } = await buildInsightFacts("weekly", WINDOW, makeDeps({
      runs: () => [
        run({ status: "failed", healedSteps: 2 }),
        run({ healedSteps: 1, healFailedSteps: 1 }),
        // Outside the window: must not count.
        run({ startedAt: NOW - 20 * DAY, status: "failed" }),
      ],
    }));
    expect(facts.digest.runs).toBe(2);
    expect(facts.digest.failed).toBe(1);
    expect(stats.healedSteps).toBe(3);
    expect(stats.healFailures).toBe(1);
    expect(facts.heals.topTests).toEqual([{ testName: "Login", healedSteps: 3 }]);
  });

  it("no metrics DB reads as null, never as zero", async () => {
    const { facts, stats } = await buildInsightFacts("weekly", WINDOW, makeDeps());
    expect(facts.clusters).toBeNull();
    expect(facts.visualChangedSteps).toBeNull();
    expect(stats.newClusters).toBeNull();
    expect(stats.visualChanges).toBeNull();
  });

  it("Site Health domains come from the metrics rows, aggregates only, and null without a DB", async () => {
    const none = await buildInsightFacts("weekly", WINDOW, makeDeps());
    expect(none.facts.siteHealth).toBeNull();
    expect(none.stats.siteHealthDomains).toBeNull();

    const hostRow = (runId: string, at: number, perf: number) => ({
      runId, host: "shop.example.com", pages: 3, seo: 80, perf, at, testId: "t1", testName: "Login", browser: "chromium", ingested: 0,
    });
    const db = {
      prepare(sql: string) {
        return {
          all: () => {
            if (sql.includes("FROM host_health")) {
              return [hostRow("r-prev", WINDOW.since - DAY, 70), hostRow("r-now", WINDOW.since + DAY, 60)];
            }
            if (sql.includes("FROM page_health")) {
              // A page row carries a TITLE and a PATH — neither may reach the facts.
              return [{ runId: "r-now", pageIndex: 0, host: "shop.example.com", path: "/secret-path", url: "https://shop.example.com/secret-path", title: "Secret Title", tab: 0, cold: 1, navType: "navigate", engine: "chromium", status: 200, seo: 80, seoAudits: "", perf: 60, coverage: "fcp lcp tbt cls", fcp: 1, lcp: 1, cls: 0, tbt: 0, inp: null, ttfb: 1, dcl: 1, load: 1, requests: 1, transferBytes: 1, action: 0, at: WINDOW.since + DAY, runAt: WINDOW.since + DAY, testId: "t1", testName: "Login" }];
            }
            return [];
          },
        };
      },
    };
    const { facts, stats } = await buildInsightFacts("weekly", WINDOW, makeDeps({ metricsDb: () => db as never }));
    expect(facts.siteHealth?.domains).toEqual([
      { host: "shop.example.com", runs: 1, pages: 1, seo: 80, perf: 60, seoPrev: 80, perfPrev: 70 },
    ]);
    expect(stats.siteHealthDomains).toBe(1);
    expect(JSON.stringify(facts.siteHealth)).not.toMatch(/secret-path|Secret Title/);
  });

  it("clusters are queried all-time so 'new' means new, and inactive ones drop", async () => {
    const old = { signature: "old-e", runs: 40, tests: 2, firstSeenAt: NOW - 90 * DAY, lastSeenAt: NOW - DAY };
    const fresh = { signature: "new-e", runs: 3, tests: 1, firstSeenAt: NOW - 2 * DAY, lastSeenAt: NOW - DAY };
    const stale = { signature: "gone-e", runs: 9, tests: 1, firstSeenAt: NOW - 90 * DAY, lastSeenAt: NOW - 30 * DAY };
    const { facts, stats } = await buildInsightFacts("weekly", WINDOW, makeDeps({
      metricsDb: () => fakeDb({ clusters: [old, fresh, stale], changed: 4 }),
    }));
    expect(facts.clusters?.map((c) => c.signature)).toEqual(["old-e", "new-e"]);
    // A cluster that has failed for months is ACTIVE this week, not NEW this
    // week — reporting it as new is the "everything changed today" lie.
    expect(facts.clusters?.find((c) => c.signature === "old-e")?.isNew).toBe(false);
    expect(facts.clusters?.find((c) => c.signature === "new-e")?.isNew).toBe(true);
    expect(stats.newClusters).toBe(1);
    expect(facts.visualChangedSteps).toBe(4);
  });

  it("valid Shopify signatures stay out; expiring ones carry days left", async () => {
    const { facts, stats } = await buildInsightFacts("weekly", WINDOW, makeDeps({
      shopifyStatuses: async () => [
        { host: "ok.myshopify.com", state: "valid", expiresAt: Math.floor((NOW + 60 * DAY) / 1000) },
        { host: "soon.myshopify.com", state: "expiring", expiresAt: Math.floor((NOW + 5 * DAY) / 1000) },
        { host: "dead.myshopify.com", state: "unreadable", expiresAt: null },
      ],
    }));
    expect(facts.shopify.map((s) => s.host)).toEqual([
      "soon.myshopify.com",
      "dead.myshopify.com",
    ]);
    expect(facts.shopify[0].daysLeft).toBe(5);
    expect(facts.shopify[1].daysLeft).toBeNull();
    expect(stats.expiringSignatures).toBe(2);
  });

  it("release notes surface only for an unseen version", async () => {
    const seen = await buildInsightFacts("weekly", WINDOW, makeDeps({
      lastSeenAppVersion: () => "1.0.0",
    }));
    expect(seen.facts.app.releaseNotes).toEqual([]);
    const firstEver = await buildInsightFacts("weekly", WINDOW, makeDeps());
    expect(firstEver.facts.app.releaseNotes.map((n) => n.version)).toEqual(["1.0.0"]);
  });

  it("only scheduled routines are reported, and lists are capped", async () => {
    const routines = Array.from({ length: 9 }, (_v, i) => ({
      name: `Nightly ${i}`,
      schedule: { kind: "dailyAt", time: "09:00" } as never,
      lastScheduledRunAt: NOW - DAY,
    }));
    const { facts } = await buildInsightFacts("weekly", WINDOW, makeDeps({
      routines: () => [{ name: "Manual only" }, ...routines],
    }));
    expect(facts.routines.length).toBeLessThanOrEqual(5);
    expect(facts.routines.every((r) => r.name.startsWith("Nightly"))).toBe(true);
  });

  it("the test index is exactly the library the model was shown", async () => {
    const { facts, testIndex } = await buildInsightFacts("weekly", WINDOW, makeDeps({
      tests: () => [
        { id: "t1", name: "Login", createdAt: NOW - 30 * DAY },
        { id: "t2", name: "Checkout", createdAt: NOW - DAY },
      ],
    }));
    expect([...testIndex].sort()).toEqual(["t1", "t2"]);
    expect(facts.tests).toHaveLength(2);
    expect(facts.library.testsCreated).toBe(1);
  });
});
