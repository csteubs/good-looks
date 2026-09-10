// Types for site-health.mjs. Hand-written beside the implementation, like
// every shared/ module, so `npm run type-check` stays a real gate over the
// TypeScript callers — the runner, the metrics store, the handlers, the
// renderer, the issue tracker's loader and payload.

export type SiteHealthCategory = "seo" | "performance";
export type SeoAuditStatus = "pass" | "fail" | "warn" | "na";
export type PerfMetricId = "fcp" | "lcp" | "tbt" | "cls";
export type VitalId = "lcp" | "cls" | "inp" | "ttfb" | "fcp" | "tbt";
export type VitalStatus = "within" | "over";

export declare const SITE_HEALTH_ENV: string;
export declare const SITE_HEALTH_FILE: string;
export declare const SITE_HEALTH_CATEGORIES: readonly SiteHealthCategory[];
export declare const MAX_SUMMARY_HOSTS: number;
export declare const SERIES_CAP: number;
export declare const MAX_FINDING_EXAMPLES: number;
export declare function isSiteHealthCategory(v: unknown): v is SiteHealthCategory;

/** The audit catalogue: Lighthouse's SEO category, informational rows at weight 0. */
export declare const SEO_AUDITS: readonly { id: string; label: string; weight: number; why: string }[];
export declare function seoAuditLabel(id: string): string;
export declare const GENERIC_LINK_TEXT: readonly string[];

/** What the in-page probe hands back about a document. Facts, never verdicts. */
export interface SiteHealthFacts {
  titleLength: number;
  descriptionLength: number;
  lang: string;
  viewport: boolean;
  canonical: string[];
  /** contents of meta robots / googlebot */
  robots: string[];
  h1Count: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  links: { total: number; generic: number; uncrawlable: number };
  hreflang: { lang: string; href: string }[];
  jsonLd: { blocks: number; invalid: number; types: string[] };
  og: { title: boolean; description: boolean; image: boolean };
  twitterCard: boolean;
  /** `location.protocol`, e.g. "https:" */
  protocol: string;
  insecureResources: number;
}

/** Raw performance readings, null when the engine could not measure one. */
export interface SiteHealthMetrics {
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  tbt: number | null;
  inp: number | null;
  dcl: number | null;
  load: number | null;
  requests: number | null;
  transferBytes: number | null;
  /** which of fcp/lcp/tbt/cls this engine delivered */
  coverage: string[];
}

/** One document's reading, as the artifact stores it (after the gate). */
export interface SiteHealthReading {
  id: string;
  /** origin + path; never a query string */
  url: string;
  host: string;
  path: string;
  title: string;
  tab: number;
  cold: boolean;
  navType: string;
  engine: string;
  /** the capture action index current at the last read, for the screenshot join */
  action: number | null;
  at: number;
  status: number | null;
  xRobotsTag: string | null;
  facts: SiteHealthFacts;
  metrics: SiteHealthMetrics;
  source: "lab";
}

export interface SiteHealthArtifact {
  testId: string;
  runId: string;
  attempt: number;
  /** wall-clock ms the probe cost this run */
  ms: number;
  pages: SiteHealthReading[];
}

export interface SeoAudit {
  id: string;
  status: SeoAuditStatus;
  detail?: string;
}

export declare function evaluateSeo(reading: SiteHealthReading): { score: number | null; audits: SeoAudit[] };
export declare function auditsToText(audits: readonly { id: string; status: SeoAuditStatus }[]): string;
export declare function auditsFromText(text: unknown): { id: string; status: SeoAuditStatus }[];

export declare const PERF_WEIGHTS: Record<PerfMetricId, number>;
export declare const PERF_CURVES: Record<PerfMetricId, { p10: number; median: number }>;
export declare const PERF_METRICS: readonly PerfMetricId[];
export declare const VITAL_IDS: readonly VitalId[];
export declare const VITAL_META: Record<
  VitalId,
  { label: string; name: string; unit: string; target: number; definition: string }
>;
export declare function logNormalScore(curve: { p10: number; median: number }, value: number): number;
export declare function perfScore(metrics: SiteHealthMetrics): { score: number | null; coverage: string[]; partial: boolean };
export declare function vitalStatus(id: string, value: number | null | undefined): VitalStatus | null;

export declare function normalizeSiteHealthReading(raw: unknown): SiteHealthReading | null;
export declare function normalizeSiteHealthArtifact(raw: unknown): SiteHealthArtifact | null;

export interface ScoredReading {
  reading: SiteHealthReading;
  seo: number | null;
  audits: SeoAudit[];
  perf: number | null;
  coverage: string[];
  partial: boolean;
}
export declare function scoreReading(reading: SiteHealthReading): ScoredReading;

/** What a run record carries. */
export interface SiteHealthSummary {
  pages: number;
  ms: number;
  hosts: { host: string; pages: number; seo: number | null; perf: number | null }[];
}
export declare function summariseSiteHealth(artifact: SiteHealthArtifact): SiteHealthSummary;
export declare function normalizeSiteHealthSummary(raw: unknown): SiteHealthSummary | undefined;
export declare function describeSiteHealthOutcome(summary: SiteHealthSummary | null | undefined): string;

/** A `host_health` row joined to its run, as the query returns it. */
export interface HostHealthRow {
  runId: string;
  host: string;
  pages: number;
  seo: number | null;
  perf: number | null;
  at: number;
  testId: string;
  testName: string;
  browser: string | null;
  ingested?: boolean | number | null;
}

/** A `page_health` row joined to its run, as the query returns it. */
export interface PageHealthRow {
  runId: string;
  pageIndex: number;
  host: string;
  path: string;
  url: string;
  title: string;
  tab: number;
  cold: boolean | number;
  navType: string;
  engine: string;
  status: number | null;
  seo: number | null;
  /** "id:status id:status …" */
  seoAudits: string;
  perf: number | null;
  /** "fcp lcp tbt cls" */
  coverage: string;
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  tbt: number | null;
  inp: number | null;
  ttfb: number | null;
  dcl: number | null;
  load: number | null;
  requests: number | null;
  transferBytes: number | null;
  /** the capture action index the reading was last taken at — the join to
   *  that step's screenshot; null when no action had run */
  action?: number | null;
  at: number;
  /** the run's own start, for windowing (the reading's `at` is its own) */
  runAt?: number;
  testId: string;
  testName: string;
  browser?: string | null;
  ingested?: boolean | number | null;
}

export interface SiteHealthSeriesPoint {
  runId: string;
  at: number;
  seo: number | null;
  perf: number | null;
}

export interface SiteHealthHostOverview {
  host: string;
  pages: number;
  runs: number;
  seo: number | null;
  perf: number | null;
  seoPrev: number | null;
  perfPrev: number | null;
  series: SiteHealthSeriesPoint[];
  lastAt: number;
}

export interface SiteHealthOverview {
  since: number;
  until: number;
  hosts: SiteHealthHostOverview[];
}

export interface SiteHealthPage {
  path: string;
  url: string;
  title: string;
  seo: number | null;
  perf: number | null;
  audits: { id: string; status: SeoAuditStatus }[];
  coverage: string[];
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  tbt: number | null;
  inp: number | null;
  ttfb: number | null;
  dcl: number | null;
  load: number | null;
  requests: number | null;
  transferBytes: number | null;
  engine: string;
  cold: boolean;
  navType: string;
  status: number | null;
  at: number;
  runId: string;
  testId: string;
  testName: string;
}

export interface SiteHealthFinding {
  id: string;
  label: string;
  status: "fail" | "warn";
  pages: number;
  of: number;
  examples: { path: string; runId: string; testId: string; testName: string }[];
}

export interface SiteHealthVital {
  p75: number | null;
  n: number;
  status: VitalStatus | null;
}

export interface SiteHealthHostDetail {
  host: string;
  since: number;
  until: number;
  runs: number;
  readings: number;
  pageCount: number;
  seo: { score: number | null; prev: number | null };
  perf: { score: number | null; prev: number | null };
  series: (SiteHealthSeriesPoint & {
    pages: number;
    testId: string;
    testName: string;
    browser: string | null;
    ingested: boolean;
  })[];
  pages: SiteHealthPage[];
  findings: SiteHealthFinding[];
  info: { id: string; label: string; status: "pass" | "warn"; pages: number; of: number }[];
  vitals: Record<VitalId, SiteHealthVital>;
  engines: { engine: string; readings: number; partial: number }[];
  tests: { testId: string; testName: string }[];
}

export declare function priorWindow(sinceMs: number, untilMs: number): { since: number; until: number } | null;
export declare function percentile75(values: readonly (number | null | undefined)[]): number | null;
export declare function siteHealthOverview(input: {
  hostRows: readonly HostHealthRow[];
  pageRows: readonly PageHealthRow[];
  sinceMs: number;
  untilMs: number;
}): SiteHealthOverview;
export declare function siteHealthHostDetail(input: {
  host: string;
  hostRows: readonly HostHealthRow[];
  pageRows: readonly PageHealthRow[];
  sinceMs: number;
  untilMs: number;
}): SiteHealthHostDetail;

export declare function scoreDelta(current: number | null | undefined, prev: number | null | undefined): string | null;
export declare function formatVital(id: string, value: number | null | undefined): string;
export declare function formatVitalTarget(id: string): string;
export declare function describeVital(id: string, value: number | null | undefined): string;
export declare function formatBytes(bytes: number | null | undefined): string;

/** What the `siteHealth:overview` channel answers. `available` is whether the
 *  metrics database could be opened at all; `enabled` is the global setting.
 *  Both are stated so the view can say WHICH is the reason for an empty board. */
export interface SiteHealthOverviewResult {
  available: boolean;
  enabled: boolean;
  overview: SiteHealthOverview;
}

/** What `siteHealth:host` answers for one domain. */
export interface SiteHealthHostResult {
  available: boolean;
  enabled: boolean;
  detail: SiteHealthHostDetail;
}

/** What `siteHealth:forTest` answers: the newest run of a test that measured,
 *  with its per-page readings scored — or null when no run has. */
export interface SiteHealthTestResult {
  run: { id: string; startedAt: number; status: "passed" | "failed"; ingested: boolean };
  summary: SiteHealthSummary;
  pages: ScoredReading[];
}
