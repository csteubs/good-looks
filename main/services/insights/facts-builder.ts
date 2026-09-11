// The deterministic half of an insights report: what happened, as data.
//
// Everything the model is told comes through here, and the shape of what it
// is told is a SECURITY property as much as a content one. The builder reads
// INDEXES and AGGREGATES — run records, the metrics DB's curated queries, the
// digest — and never a run log, a console/network capture, a script source or
// a Shopify header value. Those routinely carry page content, tokens and
// typed fixture values, and this payload leaves the machine unattended when
// the provider is hosted. `check:insights-egress` pins that property at the
// source level; keep new facts inside it.
//
// Deps-injected so tests drive it with seeded data and no disk; the real
// wiring lives in insights-service.ts.

import type {
  InsightsCadence,
  InsightStats,
  RoutineSchedule,
  RunDayCount,
  RunRecord,
} from "../../recorder/types.js";
import { periodDigest, type PeriodDigest } from "../../../shared/period-digest.mjs";
import { siteHealthHostRows, siteHealthPageRows, type Db as MetricsDb } from "../../../shared/metrics-query.mjs";
import { priorWindow, siteHealthOverview } from "../../../shared/site-health.mjs";
import {
  changedStepCount,
  failureClusters,
  type Db,
} from "../../../shared/metrics-query.mjs";
import { isDue as routineScheduleIsDue } from "../../../shared/routine-schedule.mjs";
import { CADENCE_PERIOD_LABEL } from "./insight-schedule.js";
import { unseenNotes, type ReleaseNote } from "./release-notes.js";

/** How many entries any one list in the facts pack may carry. The pack is a
 *  prompt, not an export — a top-5 that names the worst is worth more than a
 *  top-50 that blows the context window of a local model. */
const LIST_CAP = 5;
const CLUSTER_CAP = 6;

export interface InsightFactCluster {
  signature: string;
  totalRuns: number;
  tests: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** First seen inside this report's window — the "something changed on the
   *  site" primitive. */
  isNew: boolean;
}

export interface InsightFactDomain {
  host: string;
  runs: number;
  pages: number;
  seo: number | null;
  perf: number | null;
  seoPrev: number | null;
  perfPrev: number | null;
}

export interface InsightFacts {
  cadence: InsightsCadence;
  periodLabel: string;
  window: { since: number; until: number };
  /** The period digest — same rule the Stats panel renders. */
  digest: PeriodDigest;
  /** Failure clusters active this window; null = metrics DB unavailable. */
  clusters: InsightFactCluster[] | null;
  /** Steps over their visual threshold this window; null = DB unavailable. */
  visualChangedSteps: number | null;
  heals: {
    healedSteps: number;
    healFailures: number;
    topTests: { testName: string; healedSteps: number }[];
  };
  a11y: { newViolationSteps: number };
  /** Site Health per domain this window against the window before: a host
   *  name and four scores, nothing else — never a page title, path or URL.
   *  null = metrics DB unavailable. */
  siteHealth: { domains: InsightFactDomain[] } | null;
  library: {
    totalTests: number;
    testsCreated: number;
    unreviewedScriptChanges: number;
    pendingHeals: number;
  };
  routines: { name: string; overdue: boolean; lastScheduledRunAt: number | null }[];
  /** Signatures worth a warning: expiring, expired or unreadable. Host and
   *  expiry only — never a header value. */
  shopify: { host: string; state: string; daysLeft: number | null }[];
  app: {
    version: string;
    previousVersion: string | null;
    releaseNotes: ReleaseNote[];
  };
  /** The tests the model may reference in an action. THE action validator's
   *  oracle at parse time. */
  tests: { id: string; name: string }[];
}

/** The store surface the builder reads. Narrow on purpose: nothing here can
 *  hand back a log, a script or a secret, so the builder can't leak what it
 *  was never given. */
export interface InsightFactsDeps {
  runs(): RunRecord[];
  prunedDays(): RunDayCount[];
  tests(): { id: string; name: string; createdAt: number }[];
  /** metricsStore.handle() — null on a runtime without node:sqlite. */
  metricsDb(): Db;
  pendingHeals(): number;
  unreviewedScriptChanges(): number;
  routines(): {
    name: string;
    schedule?: RoutineSchedule;
    lastScheduledRunAt?: number;
  }[];
  shopifyStatuses(): Promise<
    { host: string; state: string; expiresAt: number | null }[]
  >;
  appVersion(): string;
  lastSeenAppVersion(): string | null;
}

export async function buildInsightFacts(
  cadence: InsightsCadence,
  window: { since: number; until: number },
  deps: InsightFactsDeps,
): Promise<{ facts: InsightFacts; stats: InsightStats; testIndex: Set<string> }> {
  const now = window.until;
  const allRuns = deps.runs();
  const inWindow = allRuns.filter((r) => r.startedAt >= window.since && r.startedAt <= now);

  const digest = periodDigest(allRuns, now, {
    periodMs: now - window.since,
    periodLabel: CADENCE_PERIOD_LABEL[cadence],
    prunedDays: deps.prunedDays(),
  });

  const db = deps.metricsDb();
  // All-time clusters, then narrowed to ones ACTIVE this window. Querying with
  // `since` directly would clip firstSeenAt to the window and report every
  // long-standing failure as brand new.
  const allClusters = db ? failureClusters(db, { since: 0, limit: 200 }) : null;
  const clusters: InsightFactCluster[] | null = allClusters
    ? allClusters
        .filter((c) => c.lastSeenAt >= window.since)
        .slice(0, CLUSTER_CAP)
        .map((c) => ({
          signature: c.signature,
          totalRuns: c.runs,
          tests: c.tests,
          firstSeenAt: c.firstSeenAt,
          lastSeenAt: c.lastSeenAt,
          isNew: c.firstSeenAt >= window.since,
        }))
    : null;
  const visualChangedSteps = db ? changedStepCount(db, { since: window.since }) : null;

  const healedSteps = sum(inWindow, (r) => r.healedSteps ?? 0);
  const healFailures = sum(inWindow, (r) => r.healFailedSteps ?? 0);
  const healsByTest = new Map<string, number>();
  for (const r of inWindow) {
    const healed = r.healedSteps ?? 0;
    if (healed > 0) {
      healsByTest.set(r.testName, (healsByTest.get(r.testName) ?? 0) + healed);
    }
  }
  const topHealTests = [...healsByTest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LIST_CAP)
    .map(([testName, count]) => ({ testName, healedSteps: count }));

  const a11yNewSteps = sum(inWindow, (r) => r.a11yNewSteps ?? 0);

  // Site Health, shaped by the same function the view and the MCP tool use,
  // so the report and the screen cannot disagree about a domain's delta. The
  // rows are fetched from the start of the PRIOR window because the delta
  // needs it; null when there is no database, never an empty list.
  const siteHealth = db ? { domains: siteHealthDomains(db, window) } : null;

  const tests = deps.tests();
  const testsCreated = tests.filter((t) => t.createdAt >= window.since).length;
  const unreviewedScriptChanges = deps.unreviewedScriptChanges();
  const pendingHeals = deps.pendingHeals();

  const routines = deps.routines()
    .filter((r) => r.schedule != null)
    .slice(0, LIST_CAP)
    .map((r) => ({
      name: r.name,
      overdue: routineScheduleIsDue(r.schedule, r.lastScheduledRunAt, now),
      lastScheduledRunAt: r.lastScheduledRunAt ?? null,
    }));

  const DAY_MS = 86_400_000;
  const shopify = (await deps.shopifyStatuses())
    .filter((s) => s.state !== "valid")
    .slice(0, LIST_CAP)
    .map((s) => ({
      host: s.host,
      state: s.state,
      // expiresAt is Unix SECONDS in the register.
      daysLeft: s.expiresAt === null ? null : Math.floor((s.expiresAt * 1000 - now) / DAY_MS),
    }));

  const version = deps.appVersion();
  const previousVersion = deps.lastSeenAppVersion();
  const releaseNotes = unseenNotes(previousVersion, version);

  const facts: InsightFacts = {
    cadence,
    periodLabel: CADENCE_PERIOD_LABEL[cadence],
    window,
    digest,
    clusters,
    visualChangedSteps,
    heals: { healedSteps, healFailures, topTests: topHealTests },
    a11y: { newViolationSteps: a11yNewSteps },
    siteHealth,
    library: {
      totalTests: tests.length,
      testsCreated,
      unreviewedScriptChanges,
      pendingHeals,
    },
    routines,
    shopify,
    app: { version, previousVersion, releaseNotes },
    tests: tests.map((t) => ({ id: t.id, name: t.name })),
  };

  const stats: InsightStats = {
    runs: digest.runs,
    failed: digest.failed,
    previousRuns: digest.previousRuns,
    flakyRuns: digest.flaky,
    healedSteps,
    healFailures,
    visualChanges: visualChangedSteps,
    newClusters: clusters === null ? null : clusters.filter((c) => c.isNew).length,
    a11yNewSteps,
    siteHealthDomains: siteHealth ? siteHealth.domains.length : null,
    testsCreated,
    unreviewedScriptChanges,
    expiringSignatures: shopify.length,
  };

  return { facts, stats, testIndex: new Set(tests.map((t) => t.id)) };
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((n, item) => n + pick(item), 0);
}

/** The per-domain rows for the report: aggregates only. */
function siteHealthDomains(db: MetricsDb, window: { since: number; until: number }): InsightFactDomain[] {
  const prior = priorWindow(window.since, window.until);
  const fetchSince = prior ? prior.since : window.since;
  const overview = siteHealthOverview({
    hostRows: siteHealthHostRows(db, { sinceMs: fetchSince }),
    pageRows: siteHealthPageRows(db, { sinceMs: fetchSince }),
    sinceMs: window.since,
    untilMs: window.until,
  });
  return overview.hosts.slice(0, LIST_CAP).map((h) => ({
    host: h.host,
    runs: h.runs,
    pages: h.pages,
    seo: h.seo,
    perf: h.perf,
    seoPrev: h.seoPrev,
    perfPrev: h.perfPrev,
  }));
}
