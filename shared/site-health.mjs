// SITE HEALTH: what a page reading MEANS. The SEO audits, the performance
// curve, the run summary and the per-domain shaping — every rule three
// processes need, written once (docs/plans/site-health.md).
//
// ── Facts cross the page boundary, never verdicts ─────────────────────────
// The fixture's in-page probe hands back FACTS about a document — "three
// H1s", "37 images without alt", "canonical is https://…" — bounded before
// they leave the page. Nothing that decides pass or fail runs in the page:
// the rules are here, so a scorer can be corrected without re-running
// anything, a page cannot claim a pass, and the app, the CLI and the MCP
// cannot score the same reading three ways.
//
// ── No status words ────────────────────────────────────────────────────────
// A score carries no "good" / "needs work" / "poor" (review, 2026-09-10). A
// 54 may be an acceptable score to the person reading it; what the app can
// state is the number, its change against the period before, and — for a
// vital — the published Core Web Vitals target, as a number. `scoreDelta`
// and `vitalStatus` are the whole vocabulary.
//
// ── Where the numbers live ─────────────────────────────────────────────────
// A run writes raw readings (`SITE_HEALTH_FILE`, pruned with the run), the
// runner stamps a per-host SUMMARY on the run record (survives retention,
// travels through ingest) and metrics.db shadows both (`host_health` from the
// summary, `page_health` from the artifact). `normalizeSiteHealthReading` and
// `normalizeSiteHealthSummary` are the gates each crosses on the way back in:
// a reading was written by a worker from what a page said, a summary may have
// arrived from another machine, and both are REBUILT from named keys.
//
// Pure: no fs, no shell import, no process.

import { isLoopbackHost, normalizeSiteHost, pagePathOf, siteHostOf } from "./site-host.mjs";

/** The env switch both runners set and the fixture reads. */
export const SITE_HEALTH_ENV = "GLAZE_SITE_HEALTH";
/** The artifact the fixture writes beside the manifest. */
export const SITE_HEALTH_FILE = "site-health.json";
/** The two scores. Never combined. */
export const SITE_HEALTH_CATEGORIES = /** @type {const} */ (["seo", "performance"]);
/** Hosts a run summary may name. A run rarely visits more than two. */
export const MAX_SUMMARY_HOSTS = 12;
/** Points the overview carries per host — the sparkline's window. */
export const SERIES_CAP = 20;
/** Example pages a finding lists. */
export const MAX_FINDING_EXAMPLES = 5;

/** @param {unknown} v */
export function isSiteHealthCategory(v) {
  return v === "seo" || v === "performance";
}

// ── Bounds on what a reading may carry ────────────────────────────────────
const MAX_ID = 64;
const MAX_URL = 2048;
const MAX_TITLE = 200;
const MAX_LANG = 35;
const MAX_CANONICALS = 3;
const MAX_ROBOTS = 4;
const MAX_HREFLANG = 20;
const MAX_TYPES = 10;
const MAX_SHORT = 200;
const MAX_HREF = 500;
const MAX_TYPE = 60;
const MAX_PAGES_PER_RUN = 200;

// ── SEO ───────────────────────────────────────────────────────────────────

/**
 * The audit catalogue. Lighthouse's SEO category, where every scored audit
 * weighs 1; two informational rows weigh 0 and never move the score.
 *
 * @type {readonly { id: string, label: string, weight: number, why: string }[]}
 */
export const SEO_AUDITS = [
  { id: "document-title", label: "Page has a title", weight: 1, why: "The title is the search result's headline." },
  { id: "meta-description", label: "Meta description present", weight: 1, why: "Without one the search engine writes the snippet itself." },
  { id: "html-lang", label: "Document language set", weight: 1, why: "A missing or malformed lang attribute hides the page from language-targeted search and screen readers." },
  { id: "viewport", label: "Viewport meta present", weight: 1, why: "Pages without a viewport meta are scaled on mobile and ranked as not mobile-friendly." },
  { id: "http-status", label: "Page answered 2xx", weight: 1, why: "A page that answers 4xx or 5xx is not indexed." },
  { id: "indexable", label: "Page is indexable", weight: 1, why: "A noindex directive keeps the page out of search results." },
  { id: "canonical", label: "Canonical is valid", weight: 1, why: "A canonical pointing at another host hands the page's ranking to that host." },
  { id: "single-h1", label: "One H1", weight: 1, why: "The H1 states what the page is about; none says nothing, several say too much." },
  { id: "image-alt", label: "Images have alt text", weight: 1, why: "Alt text is what image search and screen readers index." },
  { id: "link-text", label: "Links have descriptive text", weight: 1, why: "“Learn more” tells a crawler nothing about the target." },
  { id: "crawlable-anchors", label: "Links are crawlable", weight: 1, why: "A javascript: or empty href is a link a crawler cannot follow." },
  { id: "hreflang", label: "hreflang links are valid", weight: 1, why: "A malformed alternate is ignored, and the page loses its language variants." },
  { id: "https", label: "Served over HTTPS", weight: 1, why: "HTTPS is a ranking signal and a browser warning otherwise." },
  { id: "mixed-content", label: "No insecure subresources", weight: 1, why: "An https page loading http resources is flagged by browsers and search engines." },
  { id: "structured-data", label: "Structured data present", weight: 0, why: "JSON-LD is what rich results are built from. Informational." },
  { id: "social-preview", label: "Social preview tags", weight: 0, why: "og:title, og:description, og:image and twitter:card. Informational." },
];

const AUDIT_BY_ID = new Map(SEO_AUDITS.map((a) => [a.id, a]));

/** @param {string} id */
export function seoAuditLabel(id) {
  return AUDIT_BY_ID.get(id)?.label ?? id;
}

/** Link texts a crawler learns nothing from. Lighthouse's own list. */
export const GENERIC_LINK_TEXT = [
  "click here",
  "click this",
  "go",
  "here",
  "this",
  "start",
  "right here",
  "more",
  "learn more",
  "read more",
  "more info",
  "link",
];

const LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;

/**
 * Evaluate one reading's SEO facts.
 *
 * Every audit answers pass, fail, warn or n-a; warn counts as a pass in the
 * score and n-a is excluded from it.
 *
 * @param {import("./site-health.d.mts").SiteHealthReading} reading
 * @returns {{ score: number | null, audits: import("./site-health.d.mts").SeoAudit[] }}
 */
export function evaluateSeo(reading) {
  const f = reading.facts;
  /** @type {import("./site-health.d.mts").SeoAudit[]} */
  const audits = [];
  const add = (id, status, detail) => {
    audits.push(detail ? { id, status, detail } : { id, status });
  };

  if (f.titleLength > 0) {
    if (f.titleLength > 60) add("document-title", "warn", `${f.titleLength} characters, over 60`);
    else add("document-title", "pass");
  } else add("document-title", "fail", "no title");

  if (f.descriptionLength > 0) add("meta-description", "pass");
  else add("meta-description", "fail", "no meta description");

  if (f.lang && LANG_RE.test(f.lang)) add("html-lang", "pass");
  else add("html-lang", "fail", f.lang ? `lang is "${f.lang}"` : "no lang attribute");

  add("viewport", f.viewport ? "pass" : "fail", f.viewport ? undefined : "no viewport meta");

  if (reading.status === null || reading.status === undefined) add("http-status", "na");
  else if (reading.status >= 200 && reading.status <= 299) add("http-status", "pass");
  else add("http-status", "fail", `answered ${reading.status}`);

  const noindex =
    f.robots.some((r) => /\bnoindex\b/i.test(r)) ||
    (typeof reading.xRobotsTag === "string" && /\bnoindex\b/i.test(reading.xRobotsTag));
  add("indexable", noindex ? "fail" : "pass", noindex ? "noindex" : undefined);

  if (f.canonical.length === 0) add("canonical", "na");
  else if (f.canonical.length > 1) add("canonical", "fail", `${f.canonical.length} canonical links`);
  else {
    const target = siteHostOf(f.canonical[0]);
    if (!target) add("canonical", "fail", "canonical is not an absolute http(s) URL");
    else if (target !== reading.host) add("canonical", "fail", `points to ${target}`);
    else add("canonical", "pass");
  }

  if (f.h1Count === 1) add("single-h1", "pass");
  else if (f.h1Count === 0) add("single-h1", "fail", "no H1");
  else add("single-h1", "warn", `${f.h1Count} H1s`);

  if (f.imagesTotal === 0) add("image-alt", "na");
  else if (f.imagesMissingAlt === 0) add("image-alt", "pass");
  else add("image-alt", "fail", `${f.imagesMissingAlt} of ${f.imagesTotal} images`);

  if (f.links.total === 0) {
    add("link-text", "na");
    add("crawlable-anchors", "na");
  } else {
    add("link-text", f.links.generic === 0 ? "pass" : "fail", f.links.generic ? `${f.links.generic} links` : undefined);
    add(
      "crawlable-anchors",
      f.links.uncrawlable === 0 ? "pass" : "fail",
      f.links.uncrawlable ? `${f.links.uncrawlable} links` : undefined,
    );
  }

  if (f.hreflang.length === 0) add("hreflang", "na");
  else {
    const bad = f.hreflang.filter(
      (h) => !(h.lang === "x-default" || LANG_RE.test(h.lang)) || !/^https?:\/\//i.test(h.href),
    ).length;
    add("hreflang", bad === 0 ? "pass" : "fail", bad ? `${bad} of ${f.hreflang.length} alternates` : undefined);
  }

  if (isLoopbackHost(reading.host)) {
    add("https", "na");
    add("mixed-content", "na");
  } else if (f.protocol === "https:") {
    add("https", "pass");
    add(
      "mixed-content",
      f.insecureResources === 0 ? "pass" : "fail",
      f.insecureResources ? `${f.insecureResources} resources over http` : undefined,
    );
  } else {
    add("https", "fail", `served over ${f.protocol.replace(/:$/, "") || "http"}`);
    add("mixed-content", "na");
  }

  if (f.jsonLd.blocks === 0) add("structured-data", "na");
  else if (f.jsonLd.invalid > 0) add("structured-data", "warn", `${f.jsonLd.invalid} of ${f.jsonLd.blocks} blocks do not parse`);
  else add("structured-data", "pass", f.jsonLd.types.join(", ") || undefined);

  const social = [f.og.title, f.og.description, f.og.image, f.twitterCard];
  const missing = ["og:title", "og:description", "og:image", "twitter:card"].filter((_, i) => !social[i]);
  if (missing.length === 4) add("social-preview", "na");
  else if (missing.length > 0) add("social-preview", "warn", `missing ${missing.join(", ")}`);
  else add("social-preview", "pass");

  let applicable = 0;
  let passing = 0;
  for (const a of audits) {
    const weight = AUDIT_BY_ID.get(a.id)?.weight ?? 0;
    if (weight === 0 || a.status === "na") continue;
    applicable += weight;
    if (a.status === "pass" || a.status === "warn") passing += weight;
  }
  return { score: applicable > 0 ? Math.round((100 * passing) / applicable) : null, audits };
}

/** "id:status id:status …" — how a reading's audits ride one DB column. */
export function auditsToText(audits) {
  return audits.map((a) => `${a.id}:${a.status}`).join(" ");
}

/** The inverse. Unknown ids and statuses are dropped, never guessed at. */
export function auditsFromText(text) {
  if (typeof text !== "string" || !text) return [];
  /** @type {{ id: string, status: "pass" | "fail" | "warn" | "na" }[]} */
  const out = [];
  for (const token of text.split(/\s+/)) {
    const i = token.lastIndexOf(":");
    if (i <= 0) continue;
    const id = token.slice(0, i);
    const status = token.slice(i + 1);
    if (!AUDIT_BY_ID.has(id)) continue;
    if (status !== "pass" && status !== "fail" && status !== "warn" && status !== "na") continue;
    out.push({ id, status });
  }
  return out;
}

// ── Performance ───────────────────────────────────────────────────────────

/** Lighthouse v10's lab weights without Speed Index, which needs frame capture. */
export const PERF_WEIGHTS = { fcp: 10, lcp: 25, tbt: 30, cls: 25 };

/** Lighthouse's published control points: the value that scores 0.9 and the
 *  value that scores 0.5. */
export const PERF_CURVES = {
  fcp: { p10: 1800, median: 3000 },
  lcp: { p10: 2500, median: 4000 },
  tbt: { p10: 200, median: 600 },
  cls: { p10: 0.1, median: 0.25 },
};

/** The scored metrics, in weight order. */
export const PERF_METRICS = /** @type {const} */ (["fcp", "lcp", "tbt", "cls"]);

/** Every vital the view and the issue body show, in reading order. */
export const VITAL_IDS = /** @type {const} */ (["lcp", "cls", "inp", "ttfb", "fcp", "tbt"]);

/** What each vital IS, and its Core Web Vitals target as a number. The copy
 *  the cards, the tooltip, the issue body and the MCP tool all read. */
export const VITAL_META = {
  lcp: { label: "LCP", name: "Largest Contentful Paint", unit: "ms", target: 2500, definition: "how long until the largest visible image or text block finished rendering" },
  cls: { label: "CLS", name: "Cumulative Layout Shift", unit: "", target: 0.1, definition: "how much visible content moved unexpectedly while the page loaded (unitless)" },
  inp: { label: "INP", name: "Interaction to Next Paint", unit: "ms", target: 200, definition: "the slowest response to a click, tap or key press, from the input to the next frame" },
  ttfb: { label: "TTFB", name: "Time to First Byte", unit: "ms", target: 800, definition: "from the request to the first byte of the HTML response" },
  fcp: { label: "FCP", name: "First Contentful Paint", unit: "ms", target: 1800, definition: "how long until the first text or image painted" },
  tbt: { label: "TBT", name: "Total Blocking Time", unit: "ms", target: 200, definition: "how long the main thread was blocked by long tasks after first paint, when input would have had to wait" },
};

/** erfc, Abramowitz and Stegun 7.1.26 — the approximation Lighthouse uses. */
function erfc(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const result = y * Math.exp(-x * x);
  return x >= 0 ? result : 2 - result;
}

const INV_ERFC_ONE_FIFTH = 0.9061938024368232;

/**
 * Lighthouse's log-normal scoring curve: 1 at zero, 0.9 at `p10`, 0.5 at
 * `median`, tending to 0.
 *
 * @param {{ p10: number, median: number }} curve
 * @param {number} value
 * @returns {number} 0..1
 */
export function logNormalScore(curve, value) {
  if (!(value > 0)) return 1;
  const location = Math.log(curve.median);
  const shape = Math.abs(Math.log(curve.p10 / curve.median)) / (Math.SQRT2 * INV_ERFC_ONE_FIFTH);
  const standardized = (Math.log(value) - location) / (Math.SQRT2 * shape);
  const score = 0.5 * erfc(standardized);
  return Math.max(0, Math.min(1, score));
}

/**
 * The performance score of one reading, over the metrics its engine could
 * measure. `coverage` names them; `partial` is true when any of the four is
 * missing, and the score is then a score of what was measured — said, never
 * quietly lower.
 *
 * @param {import("./site-health.d.mts").SiteHealthMetrics} metrics
 * @returns {{ score: number | null, coverage: string[], partial: boolean }}
 */
export function perfScore(metrics) {
  let weight = 0;
  let sum = 0;
  const coverage = [];
  for (const id of PERF_METRICS) {
    const value = metrics[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    coverage.push(id);
    weight += PERF_WEIGHTS[id];
    sum += PERF_WEIGHTS[id] * logNormalScore(PERF_CURVES[id], value);
  }
  return {
    score: weight > 0 ? Math.round((100 * sum) / weight) : null,
    coverage,
    partial: coverage.length < PERF_METRICS.length,
  };
}

/**
 * Whether a vital is within its published target. Null when unmeasured.
 *
 * @param {string} id
 * @param {number | null | undefined} value
 * @returns {"within" | "over" | null}
 */
export function vitalStatus(id, value) {
  const meta = VITAL_META[id];
  if (!meta || typeof value !== "number" || !Number.isFinite(value)) return null;
  return value <= meta.target ? "within" : "over";
}

// ── Readings: the artifact's page entries, rebuilt on the way in ──────────

const str = (v, max) => (typeof v === "string" ? (v.length > max ? v.slice(0, max) : v) : "");
const int = (v, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0;
const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const bool = (v) => v === true;

const NAV_TYPES = new Set(["navigate", "reload", "back_forward", "prerender"]);
const ENGINES = new Set(["chromium", "firefox", "webkit"]);
const METRIC_KEYS = ["ttfb", "fcp", "lcp", "cls", "tbt", "inp", "dcl", "load", "requests", "transferBytes"];

/**
 * Narrow one page reading from the artifact. Null when it does not name a
 * host — a reading nothing can file under a domain is not a reading.
 *
 * @param {unknown} raw
 * @returns {import("./site-health.d.mts").SiteHealthReading | null}
 */
export function normalizeSiteHealthReading(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = /** @type {Record<string, any>} */ (raw);
  const url = str(r.url, MAX_URL);
  const host = normalizeSiteHost(r.host) ?? siteHostOf(url);
  const path = pagePathOf(url) ?? (typeof r.path === "string" && r.path.startsWith("/") ? str(r.path, 1024) : null);
  if (!host || !path) return null;
  const facts = r.facts && typeof r.facts === "object" ? r.facts : {};
  const links = facts.links && typeof facts.links === "object" ? facts.links : {};
  const jsonLd = facts.jsonLd && typeof facts.jsonLd === "object" ? facts.jsonLd : {};
  const og = facts.og && typeof facts.og === "object" ? facts.og : {};
  const metricsIn = r.metrics && typeof r.metrics === "object" ? r.metrics : {};
  /** @type {any} */
  const metrics = {};
  for (const k of METRIC_KEYS) metrics[k] = numOrNull(metricsIn[k]);
  metrics.coverage = Array.isArray(metricsIn.coverage)
    ? metricsIn.coverage.filter((c) => PERF_METRICS.includes(c)).slice(0, 4)
    : PERF_METRICS.filter((id) => metrics[id] !== null);
  const engine = typeof r.engine === "string" && ENGINES.has(r.engine) ? r.engine : "unknown";
  return {
    id: str(r.id, MAX_ID) || `${host}${path}`,
    url: url || `https://${host}${path}`,
    host,
    path,
    title: str(r.title, MAX_TITLE),
    tab: int(r.tab, 99),
    cold: bool(r.cold),
    navType: typeof r.navType === "string" && NAV_TYPES.has(r.navType) ? r.navType : "unknown",
    engine,
    action: typeof r.action === "number" && Number.isInteger(r.action) && r.action >= 0 ? r.action : null,
    at: int(r.at),
    status: typeof r.status === "number" && Number.isInteger(r.status) && r.status >= 100 && r.status <= 599 ? r.status : null,
    xRobotsTag: typeof r.xRobotsTag === "string" ? str(r.xRobotsTag, MAX_SHORT) : null,
    facts: {
      titleLength: int(facts.titleLength, 100_000),
      descriptionLength: int(facts.descriptionLength, 100_000),
      lang: str(facts.lang, MAX_LANG),
      viewport: bool(facts.viewport),
      canonical: (Array.isArray(facts.canonical) ? facts.canonical : [])
        .filter((c) => typeof c === "string")
        .slice(0, MAX_CANONICALS)
        .map((c) => str(c, MAX_HREF)),
      robots: (Array.isArray(facts.robots) ? facts.robots : [])
        .filter((c) => typeof c === "string")
        .slice(0, MAX_ROBOTS)
        .map((c) => str(c, MAX_SHORT)),
      h1Count: int(facts.h1Count, 10_000),
      imagesTotal: int(facts.imagesTotal, 100_000),
      imagesMissingAlt: Math.min(int(facts.imagesMissingAlt, 100_000), int(facts.imagesTotal, 100_000)),
      links: {
        total: int(links.total, 100_000),
        generic: int(links.generic, 100_000),
        uncrawlable: int(links.uncrawlable, 100_000),
      },
      hreflang: (Array.isArray(facts.hreflang) ? facts.hreflang : [])
        .filter((h) => h && typeof h === "object")
        .slice(0, MAX_HREFLANG)
        .map((h) => ({ lang: str(h.lang, MAX_LANG), href: str(h.href, MAX_HREF) })),
      jsonLd: {
        blocks: int(jsonLd.blocks, 1000),
        invalid: int(jsonLd.invalid, 1000),
        types: (Array.isArray(jsonLd.types) ? jsonLd.types : [])
          .filter((t) => typeof t === "string")
          .slice(0, MAX_TYPES)
          .map((t) => str(t, MAX_TYPE)),
      },
      og: { title: bool(og.title), description: bool(og.description), image: bool(og.image) },
      twitterCard: bool(facts.twitterCard),
      protocol: str(facts.protocol, 10),
      insecureResources: int(facts.insecureResources, 100_000),
    },
    metrics,
    source: "lab",
  };
}

/**
 * The whole artifact, rebuilt. Readings that do not survive their own gate are
 * dropped rather than failing the file; the count of pages is bounded.
 *
 * @param {unknown} raw
 * @returns {import("./site-health.d.mts").SiteHealthArtifact | null}
 */
export function normalizeSiteHealthArtifact(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = /** @type {Record<string, any>} */ (raw);
  const pages = (Array.isArray(r.pages) ? r.pages : [])
    .slice(0, MAX_PAGES_PER_RUN)
    .map(normalizeSiteHealthReading)
    .filter((p) => p !== null);
  return {
    testId: str(r.testId, 200),
    runId: str(r.runId, 200),
    attempt: int(r.attempt, 99),
    ms: int(r.ms),
    pages,
  };
}

/**
 * One reading, scored.
 *
 * @param {import("./site-health.d.mts").SiteHealthReading} reading
 * @returns {import("./site-health.d.mts").ScoredReading}
 */
export function scoreReading(reading) {
  const seo = evaluateSeo(reading);
  const perf = perfScore(reading.metrics);
  return { reading, seo: seo.score, audits: seo.audits, perf: perf.score, coverage: perf.coverage, partial: perf.partial };
}

/** Mean of the non-null numbers, rounded; null when there are none. */
function meanScore(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

// ── The run summary ───────────────────────────────────────────────────────

/**
 * What a run record carries: per host, how many pages were read and the mean
 * of each score. Both runners derive it from the artifact through this one
 * function.
 *
 * @param {import("./site-health.d.mts").SiteHealthArtifact} artifact
 * @returns {import("./site-health.d.mts").SiteHealthSummary}
 */
export function summariseSiteHealth(artifact) {
  /** @type {Map<string, { pages: number, seo: (number|null)[], perf: (number|null)[] }>} */
  const byHost = new Map();
  for (const reading of artifact.pages) {
    const scored = scoreReading(reading);
    const entry = byHost.get(reading.host) ?? { pages: 0, seo: [], perf: [] };
    entry.pages++;
    entry.seo.push(scored.seo);
    entry.perf.push(scored.perf);
    byHost.set(reading.host, entry);
  }
  const hosts = [...byHost.entries()]
    .map(([host, e]) => ({ host, pages: e.pages, seo: meanScore(e.seo), perf: meanScore(e.perf) }))
    .sort((a, b) => b.pages - a.pages || a.host.localeCompare(b.host))
    .slice(0, MAX_SUMMARY_HOSTS);
  return { pages: artifact.pages.length, ms: artifact.ms, hosts };
}

const score = (v) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;

/**
 * The gate a summary crosses on the way onto a run record — from a runner's
 * own memory, from an ingested record, from a stored one. Undefined for
 * anything that is not a summary, so the field stays absent.
 *
 * @param {unknown} raw
 * @returns {import("./site-health.d.mts").SiteHealthSummary | undefined}
 */
export function normalizeSiteHealthSummary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = /** @type {Record<string, any>} */ (raw);
  if (!Array.isArray(r.hosts)) return undefined;
  const hosts = [];
  for (const h of r.hosts.slice(0, MAX_SUMMARY_HOSTS)) {
    if (!h || typeof h !== "object") continue;
    const host = normalizeSiteHost(h.host);
    if (!host) continue;
    hosts.push({ host, pages: int(h.pages, MAX_PAGES_PER_RUN), seo: score(h.seo), perf: score(h.perf) });
  }
  return { pages: int(r.pages, MAX_PAGES_PER_RUN), ms: int(r.ms), hosts };
}

// ── The run's Output line ─────────────────────────────────────────────────

/**
 * What the check did, in the Output panel. Zero pages with the switch on is a
 * FAULT and is worded as one — the accessibility rule: "found nothing" and
 * "measured nothing" must never read alike.
 *
 * @param {import("./site-health.d.mts").SiteHealthSummary | null | undefined} summary
 * @returns {string}
 */
export function describeSiteHealthOutcome(summary) {
  if (!summary || summary.pages === 0 || summary.hosts.length === 0) {
    return "Site Health: no page was scored — the probe was armed but reported nothing, which is a fault, not a clean result.";
  }
  const parts = summary.hosts.slice(0, 3).map((h) => {
    const seo = h.seo === null ? "SEO —" : `SEO ${h.seo}`;
    const perf = h.perf === null ? "performance —" : `performance ${h.perf}`;
    return `${h.pages} page${h.pages === 1 ? "" : "s"} scored on ${h.host} — ${seo}, ${perf}`;
  });
  const more = summary.hosts.length > 3 ? ` and ${summary.hosts.length - 3} more host${summary.hosts.length - 3 === 1 ? "" : "s"}` : "";
  const cost = summary.ms > 0 ? ` (${(summary.ms / 1000).toFixed(1)}s)` : "";
  return `Site Health: ${parts.join("; ")}${more}${cost}.`;
}

// ── Shaping DB rows into the overview and one domain ──────────────────────

/** The prior period of the same length, or null on All (sinceMs 0). */
export function priorWindow(sinceMs, untilMs) {
  if (!(sinceMs > 0) || !(untilMs > sinceMs)) return null;
  const length = untilMs - sinceMs;
  return { since: Math.max(0, sinceMs - length), until: sinceMs };
}

function inWindow(at, since, until) {
  return at >= since && at < until;
}

/** Latest reading per path. Rows must carry `path` and `at`. */
function latestPerPath(pageRows) {
  /** @type {Map<string, any>} */
  const best = new Map();
  for (const row of pageRows) {
    const prev = best.get(row.path);
    if (!prev || row.at > prev.at || (row.at === prev.at && row.pageIndex > prev.pageIndex)) best.set(row.path, row);
  }
  return [...best.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Nearest-rank 75th percentile. */
export function percentile75(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  return nums[Math.max(0, Math.ceil(0.75 * nums.length) - 1)];
}

/** A domain's two current scores over a window: the mean of the latest reading
 *  per page, falling back to the latest run's summary when no page row is in
 *  the window (the artifact was gone before it was rolled up). */
function currentScores(hostRows, pageRows, since, until) {
  const pages = latestPerPath(pageRows.filter((r) => inWindow(r.at, since, until)));
  if (pages.length > 0) {
    return { seo: meanScore(pages.map((p) => p.seo)), perf: meanScore(pages.map((p) => p.perf)), pages: pages.length, fromPages: true };
  }
  const runs = hostRows.filter((r) => inWindow(r.at, since, until)).sort((a, b) => b.at - a.at);
  const latest = runs[0];
  return latest
    ? { seo: latest.seo, perf: latest.perf, pages: latest.pages, fromPages: false }
    : { seo: null, perf: null, pages: 0, fromPages: false };
}

function seriesOf(hostRows, since, until) {
  return hostRows
    .filter((r) => inWindow(r.at, since, until))
    .sort((a, b) => a.at - b.at || a.runId.localeCompare(b.runId))
    .map((r) => ({
      runId: r.runId,
      at: r.at,
      seo: r.seo,
      perf: r.perf,
      pages: r.pages,
      testId: r.testId,
      testName: r.testName,
      browser: r.browser,
      ingested: Boolean(r.ingested),
    }));
}

/**
 * Every domain, for the Domains panel and the MCP overview.
 *
 * @param {{ hostRows: import("./site-health.d.mts").HostHealthRow[], pageRows: import("./site-health.d.mts").PageHealthRow[], sinceMs: number, untilMs: number }} input
 * @returns {import("./site-health.d.mts").SiteHealthOverview}
 */
export function siteHealthOverview({ hostRows, pageRows, sinceMs, untilMs }) {
  const since = sinceMs > 0 ? sinceMs : 0;
  const until = untilMs;
  const prior = priorWindow(since, until);
  const hosts = new Set([...hostRows.map((r) => r.host), ...pageRows.map((r) => r.host)]);
  const out = [];
  for (const host of hosts) {
    const hr = hostRows.filter((r) => r.host === host);
    const pr = pageRows.filter((r) => r.host === host);
    const runs = hr.filter((r) => inWindow(r.at, since, until));
    if (runs.length === 0 && !pr.some((r) => inWindow(r.at, since, until))) continue;
    const now = currentScores(hr, pr, since, until);
    const prev = prior ? currentScores(hr, pr, prior.since, prior.until) : null;
    const series = seriesOf(hr, since, until);
    out.push({
      host,
      pages: now.pages,
      runs: runs.length,
      seo: now.seo,
      perf: now.perf,
      seoPrev: prev ? prev.seo : null,
      perfPrev: prev ? prev.perf : null,
      series: series.slice(-SERIES_CAP).map((p) => ({ runId: p.runId, at: p.at, seo: p.seo, perf: p.perf })),
      lastAt: series.length ? series[series.length - 1].at : Math.max(0, ...pr.map((r) => r.at)),
    });
  }
  out.sort((a, b) => a.host.localeCompare(b.host));
  return { since, until, hosts: out };
}

/**
 * One domain: trend, pages, findings, vitals, engines.
 *
 * @param {{ host: string, hostRows: import("./site-health.d.mts").HostHealthRow[], pageRows: import("./site-health.d.mts").PageHealthRow[], sinceMs: number, untilMs: number }} input
 * @returns {import("./site-health.d.mts").SiteHealthHostDetail}
 */
export function siteHealthHostDetail({ host, hostRows, pageRows, sinceMs, untilMs }) {
  const since = sinceMs > 0 ? sinceMs : 0;
  const until = untilMs;
  const prior = priorWindow(since, until);
  const hr = hostRows.filter((r) => r.host === host);
  const pr = pageRows.filter((r) => r.host === host);
  const inRange = pr.filter((r) => inWindow(r.at, since, until));
  const now = currentScores(hr, pr, since, until);
  const prev = prior ? currentScores(hr, pr, prior.since, prior.until) : null;
  const series = seriesOf(hr, since, until);
  const latest = latestPerPath(inRange);

  const pages = latest.map((p) => ({
    path: p.path,
    url: p.url,
    title: p.title,
    seo: p.seo,
    perf: p.perf,
    audits: auditsFromText(p.seoAudits),
    coverage: typeof p.coverage === "string" && p.coverage ? p.coverage.split(" ").filter(Boolean) : [],
    fcp: p.fcp,
    lcp: p.lcp,
    cls: p.cls,
    tbt: p.tbt,
    inp: p.inp,
    ttfb: p.ttfb,
    dcl: p.dcl,
    load: p.load,
    requests: p.requests,
    transferBytes: p.transferBytes,
    engine: p.engine,
    cold: Boolean(p.cold),
    navType: p.navType,
    status: p.status,
    at: p.at,
    runId: p.runId,
    testId: p.testId,
    testName: p.testName,
  }));

  /** @type {Map<string, { status: "fail" | "warn", pages: number, examples: any[] }>} */
  const findingsById = new Map();
  /** @type {Map<string, { status: "pass" | "warn", pages: number }>} */
  const infoById = new Map();
  for (const p of pages) {
    for (const a of p.audits) {
      const meta = AUDIT_BY_ID.get(a.id);
      if (!meta) continue;
      if (meta.weight === 0) {
        if (a.status === "pass" || a.status === "warn") {
          const e = infoById.get(a.id) ?? { status: a.status, pages: 0 };
          e.pages++;
          if (a.status === "warn") e.status = "warn";
          infoById.set(a.id, e);
        }
        continue;
      }
      if (a.status !== "fail" && a.status !== "warn") continue;
      const e = findingsById.get(a.id) ?? { status: a.status, pages: 0, examples: [] };
      e.pages++;
      if (a.status === "fail") e.status = "fail";
      if (e.examples.length < MAX_FINDING_EXAMPLES) {
        e.examples.push({ path: p.path, runId: p.runId, testId: p.testId, testName: p.testName });
      }
      findingsById.set(a.id, e);
    }
  }
  const findings = [...findingsById.entries()]
    .map(([id, e]) => ({ id, label: seoAuditLabel(id), status: e.status, pages: e.pages, of: pages.length, examples: e.examples }))
    .sort((a, b) => (a.status === b.status ? b.pages - a.pages : a.status === "fail" ? -1 : 1));
  const info = [...infoById.entries()]
    .map(([id, e]) => ({ id, label: seoAuditLabel(id), status: e.status, pages: e.pages, of: pages.length }))
    .sort((a, b) => a.id.localeCompare(b.id));

  /** @type {any} */
  const vitals = {};
  for (const id of VITAL_IDS) {
    const values = inRange.map((r) => r[id]).filter((v) => typeof v === "number" && Number.isFinite(v));
    const p75 = percentile75(values);
    vitals[id] = { p75, n: values.length, status: vitalStatus(id, p75) };
  }

  /** @type {Map<string, { readings: number, partial: number }>} */
  const enginesById = new Map();
  for (const r of inRange) {
    const e = enginesById.get(r.engine) ?? { readings: 0, partial: 0 };
    e.readings++;
    const cov = typeof r.coverage === "string" && r.coverage ? r.coverage.split(" ").filter(Boolean) : [];
    if (cov.length < PERF_METRICS.length) e.partial++;
    enginesById.set(r.engine, e);
  }
  const engines = [...enginesById.entries()]
    .map(([engine, e]) => ({ engine, readings: e.readings, partial: e.partial }))
    .sort((a, b) => b.readings - a.readings);

  const runIds = new Set(series.map((p) => p.runId));
  for (const r of inRange) runIds.add(r.runId);

  return {
    host,
    since,
    until,
    runs: runIds.size,
    readings: inRange.length,
    pageCount: pages.length,
    seo: { score: now.seo, prev: prev ? prev.seo : null },
    perf: { score: now.perf, prev: prev ? prev.perf : null },
    series,
    pages,
    findings,
    info,
    vitals,
    engines,
    tests: [...new Map(series.map((p) => [p.testId, p.testName])).entries()]
      .map(([testId, testName]) => ({ testId, testName }))
      .slice(0, 10),
  };
}

// ── Words and numbers ─────────────────────────────────────────────────────

/**
 * "−4 vs prior", "+2 vs prior", "no change vs prior" — or null when there is
 * nothing to compare (no prior period, or no score on one side).
 *
 * @param {number | null | undefined} current
 * @param {number | null | undefined} prev
 * @returns {string | null}
 */
export function scoreDelta(current, prev) {
  if (typeof current !== "number" || typeof prev !== "number") return null;
  const d = current - prev;
  if (d === 0) return "no change vs prior";
  return `${d > 0 ? "+" : "−"}${Math.abs(d)} vs prior`;
}

/** @param {number | null | undefined} ms */
function formatMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

/**
 * A vital's value in the unit a person reads: seconds past a second,
 * milliseconds under it, CLS as a unitless decimal.
 *
 * @param {string} id
 * @param {number | null | undefined} value
 * @returns {string}
 */
export function formatVital(id, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (id === "cls") return value < 0.01 && value > 0 ? value.toFixed(3) : value.toFixed(2);
  return formatMs(value);
}

/** The target, as a person reads it: "2.5 s", "0.1", "200 ms". */
export function formatVitalTarget(id) {
  const meta = VITAL_META[id];
  if (!meta) return "";
  return id === "cls" ? String(meta.target) : formatMs(meta.target);
}

/** "over the 2.5 s target" / "within the 2.5 s target" / "". */
export function describeVital(id, value) {
  const status = vitalStatus(id, value);
  if (!status) return "";
  return `${status} the ${formatVitalTarget(id)} target`;
}

/** @param {number | null | undefined} bytes */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
