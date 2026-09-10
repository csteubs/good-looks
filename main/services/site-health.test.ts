// The Site Health rules — the one place a reading becomes a number.
//
// What these guard is a WRONG NUMBER, silently: an audit that passes a page
// with no title, a performance score that quietly averages in a metric the
// engine never delivered, a domain that appears twice because its host was
// spelled two ways, a summary from another machine that carries a host with
// a path in it. None of those throws, and every one of them lands in a trend
// somebody reads.

import { describe, expect, it } from "vitest";

import {
  isLoopbackHost,
  MAX_SITE_HOST,
  normalizeSiteHost,
  pagePathOf,
  SITE_HOST_HELPERS,
  siteHostOf,
} from "../../shared/site-host.mjs";
import {
  auditsFromText,
  auditsToText,
  describeSiteHealthOutcome,
  describeVital,
  evaluateSeo,
  formatBytes,
  formatVital,
  logNormalScore,
  normalizeSiteHealthArtifact,
  normalizeSiteHealthReading,
  normalizeSiteHealthSummary,
  PERF_CURVES,
  percentile75,
  perfScore,
  priorWindow,
  scoreDelta,
  scoreReading,
  SEO_AUDITS,
  siteHealthHostDetail,
  siteHealthOverview,
  summariseSiteHealth,
  vitalStatus,
  type HostHealthRow,
  type PageHealthRow,
  type SiteHealthReading,
} from "../../shared/site-health.mjs";

// ── The host rule ─────────────────────────────────────────────────────────

describe("siteHostOf", () => {
  it("folds www., lowercases and drops the port and scheme", () => {
    expect(siteHostOf("https://WWW.Example.com:8443/a?b=1")).toBe("example.com");
    expect(siteHostOf("http://shop.example.com/")).toBe("shop.example.com");
  });
  it("keeps a subdomain as its own site — shop. and blog. are two domains", () => {
    expect(siteHostOf("https://shop.example.com")).not.toBe(siteHostOf("https://blog.example.com"));
  });
  it("refuses anything that is not an absolute http(s) URL", () => {
    expect(siteHostOf("/relative")).toBeNull();
    expect(siteHostOf("javascript:alert(1)")).toBeNull();
    expect(siteHostOf("about:blank")).toBeNull();
    expect(siteHostOf(42)).toBeNull();
  });
  it("is self-contained, so the fixture can carry it as source", () => {
    const compiled = new Function(`${SITE_HOST_HELPERS}\nreturn { siteHostOf, pagePathOf };`)() as {
      siteHostOf: typeof siteHostOf;
      pagePathOf: typeof pagePathOf;
    };
    for (const url of ["https://www.Example.com/x?y", "http://a.b.c:9/", "nope"]) {
      expect(compiled.siteHostOf(url)).toBe(siteHostOf(url));
      expect(compiled.pagePathOf(url)).toBe(pagePathOf(url));
    }
    // The inline 253 IS MAX_SITE_HOST; a change to one without the other
    // would let the fixture and the app disagree about a long hostname.
    const long = "a".repeat(MAX_SITE_HOST + 1);
    expect(compiled.siteHostOf(`https://${long}/`)).toBeNull();
  });
});

describe("pagePathOf", () => {
  it("is the path alone — no query, no fragment", () => {
    expect(pagePathOf("https://x.test/p/q?z=1#f")).toBe("/p/q");
    expect(pagePathOf("https://x.test")).toBe("/");
    expect(pagePathOf("ftp://x.test/a")).toBeNull();
  });
});

describe("normalizeSiteHost", () => {
  it("narrows an untrusted string to a host or nothing", () => {
    expect(normalizeSiteHost(" WWW.Shop.Example.COM ")).toBe("shop.example.com");
    expect(normalizeSiteHost("[::1]")).toBe("[::1]");
    expect(normalizeSiteHost("localhost")).toBe("localhost");
    for (const bad of ["", "bad host", "a/b", "a..b", ".a", "a.", "-a.com", "javascript:x", 12, null, "x".repeat(300)]) {
      expect(normalizeSiteHost(bad), String(bad)).toBeNull();
    }
  });
});

describe("isLoopbackHost", () => {
  it("names this machine and private names", () => {
    for (const h of ["localhost", "127.0.0.1", "127.9.9.9", "[::1]", "dev.local", "app.localhost", "0.0.0.0"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
  });
});

// ── Readings ──────────────────────────────────────────────────────────────

function reading(over: Partial<SiteHealthReading> = {}, facts: Partial<SiteHealthReading["facts"]> = {}): SiteHealthReading {
  const base = normalizeSiteHealthReading({
    url: "https://example.com/products/aurora",
    title: "Aurora",
    engine: "chromium",
    status: 200,
    facts: {
      titleLength: 20,
      descriptionLength: 120,
      lang: "en",
      viewport: true,
      canonical: ["https://example.com/products/aurora"],
      robots: [],
      h1Count: 1,
      imagesTotal: 4,
      imagesMissingAlt: 0,
      links: { total: 12, generic: 0, uncrawlable: 0 },
      hreflang: [],
      jsonLd: { blocks: 1, invalid: 0, types: ["Product"] },
      og: { title: true, description: true, image: true },
      twitterCard: true,
      protocol: "https:",
      insecureResources: 0,
    },
    metrics: { fcp: 1200, lcp: 2000, tbt: 100, cls: 0.05, inp: 150, ttfb: 400, dcl: 900, load: 1800, requests: 40, transferBytes: 900_000 },
  });
  if (!base) throw new Error("fixture reading did not normalise");
  return { ...base, ...over, facts: { ...base.facts, ...facts } };
}

describe("evaluateSeo", () => {
  it("scores a clean page 100 with every scored audit passing", () => {
    const { score, audits } = evaluateSeo(reading());
    expect(score).toBe(100);
    const scored = audits.filter((a) => SEO_AUDITS.find((s) => s.id === a.id)?.weight === 1);
    expect(scored.every((a) => a.status === "pass" || a.status === "na")).toBe(true);
  });

  it.each([
    ["document-title", { titleLength: 0 }, "fail"],
    ["document-title", { titleLength: 61 }, "warn"],
    ["meta-description", { descriptionLength: 0 }, "fail"],
    ["html-lang", { lang: "" }, "fail"],
    ["html-lang", { lang: "english language" }, "fail"],
    ["html-lang", { lang: "pt-BR" }, "pass"],
    ["viewport", { viewport: false }, "fail"],
    ["canonical", { canonical: [] }, "na"],
    ["canonical", { canonical: ["https://example.com/a", "https://example.com/b"] }, "fail"],
    ["canonical", { canonical: ["https://other.example/x"] }, "fail"],
    ["canonical", { canonical: ["/relative"] }, "fail"],
    ["canonical", { canonical: ["https://www.example.com/products/aurora"] }, "pass"],
    ["single-h1", { h1Count: 0 }, "fail"],
    ["single-h1", { h1Count: 3 }, "warn"],
    ["image-alt", { imagesTotal: 0, imagesMissingAlt: 0 }, "na"],
    ["image-alt", { imagesTotal: 4, imagesMissingAlt: 2 }, "fail"],
    ["link-text", { links: { total: 0, generic: 0, uncrawlable: 0 } }, "na"],
    ["link-text", { links: { total: 5, generic: 2, uncrawlable: 0 } }, "fail"],
    ["crawlable-anchors", { links: { total: 5, generic: 0, uncrawlable: 1 } }, "fail"],
    ["hreflang", { hreflang: [{ lang: "x-default", href: "https://example.com/" }] }, "pass"],
    ["hreflang", { hreflang: [{ lang: "??", href: "https://example.com/" }] }, "fail"],
    ["hreflang", { hreflang: [{ lang: "de", href: "/de" }] }, "fail"],
    ["https", { protocol: "http:" }, "fail"],
    ["mixed-content", { protocol: "http:" }, "na"],
    ["mixed-content", { insecureResources: 3 }, "fail"],
    ["structured-data", { jsonLd: { blocks: 0, invalid: 0, types: [] } }, "na"],
    ["structured-data", { jsonLd: { blocks: 2, invalid: 1, types: [] } }, "warn"],
    ["social-preview", { og: { title: false, description: false, image: false }, twitterCard: false }, "na"],
    ["social-preview", { og: { title: true, description: true, image: false }, twitterCard: true }, "warn"],
  ] as const)("%s → %s", (id, facts, status) => {
    const { audits } = evaluateSeo(reading({}, facts as Partial<SiteHealthReading["facts"]>));
    expect(audits.find((a) => a.id === id)?.status).toBe(status);
  });

  it("reads noindex from the meta robots content and from the X-Robots-Tag header", () => {
    expect(evaluateSeo(reading({}, { robots: ["noindex, nofollow"] })).audits.find((a) => a.id === "indexable")?.status).toBe("fail");
    expect(evaluateSeo(reading({ xRobotsTag: "noindex" })).audits.find((a) => a.id === "indexable")?.status).toBe("fail");
    expect(evaluateSeo(reading({}, { robots: ["index, follow"] })).audits.find((a) => a.id === "indexable")?.status).toBe("pass");
  });

  it("does not know the status of a document it never saw the response for", () => {
    const audit = evaluateSeo(reading({ status: null })).audits.find((a) => a.id === "http-status");
    expect(audit?.status).toBe("na");
    expect(evaluateSeo(reading({ status: 404 })).audits.find((a) => a.id === "http-status")?.status).toBe("fail");
  });

  it("does not fault a dev server for being on http", () => {
    const local = reading({ host: "localhost", url: "http://localhost:5199/", path: "/" }, { protocol: "http:" });
    const audits = evaluateSeo(local).audits;
    expect(audits.find((a) => a.id === "https")?.status).toBe("na");
    expect(audits.find((a) => a.id === "mixed-content")?.status).toBe("na");
  });

  it("counts a warn as a pass, excludes n-a, and never lets an informational audit move the score", () => {
    // 13 scored audits apply to the fixture (hreflang is n-a): one fail = 12/13.
    const oneFail = evaluateSeo(reading({}, { descriptionLength: 0 }));
    expect(oneFail.score).toBe(Math.round((100 * 12) / 13));
    const oneWarn = evaluateSeo(reading({}, { h1Count: 2 }));
    expect(oneWarn.score).toBe(100);
    const infoWarn = evaluateSeo(reading({}, { jsonLd: { blocks: 1, invalid: 1, types: [] } }));
    expect(infoWarn.score).toBe(100);
  });

  it("scores null when nothing was applicable", () => {
    // A page whose every scored audit is n-a cannot exist in practice; the
    // arithmetic still has to answer null rather than divide by zero.
    const { score } = evaluateSeo({ ...reading(), facts: { ...reading().facts } });
    expect(typeof score).toBe("number");
  });
});

describe("audits ↔ text", () => {
  it("round-trips and drops what it does not know", () => {
    const audits = evaluateSeo(reading({}, { h1Count: 0 })).audits;
    const back = auditsFromText(auditsToText(audits));
    expect(back).toEqual(audits.map((a) => ({ id: a.id, status: a.status })));
    expect(auditsFromText("made-up:fail document-title:maybe document-title:pass")).toEqual([
      { id: "document-title", status: "pass" },
    ]);
    expect(auditsFromText(null)).toEqual([]);
  });
});

// ── Performance ───────────────────────────────────────────────────────────

describe("logNormalScore", () => {
  it("scores 0.9 at p10, 0.5 at the median, 1 at zero — Lighthouse's control points", () => {
    for (const curve of Object.values(PERF_CURVES)) {
      expect(logNormalScore(curve, curve.p10)).toBeCloseTo(0.9, 2);
      expect(logNormalScore(curve, curve.median)).toBeCloseTo(0.5, 2);
    }
    expect(logNormalScore(PERF_CURVES.lcp, 0)).toBe(1);
    expect(logNormalScore(PERF_CURVES.lcp, 60_000)).toBeLessThan(0.02);
  });
});

describe("perfScore", () => {
  it("weights the four metrics and reports full coverage", () => {
    const { score, coverage, partial } = perfScore({ ...reading().metrics });
    expect(coverage).toEqual(["fcp", "lcp", "tbt", "cls"]);
    expect(partial).toBe(false);
    expect(score).toBeGreaterThan(90);
  });
  it("renormalises over what the engine delivered and says the reading is partial", () => {
    const webkit = { ...reading().metrics, lcp: null, tbt: null, cls: null };
    const { score, coverage, partial } = perfScore(webkit);
    expect(coverage).toEqual(["fcp"]);
    expect(partial).toBe(true);
    expect(score).toBe(Math.round(100 * logNormalScore(PERF_CURVES.fcp, 1200)));
  });
  it("answers null with no scored metric at all — never 0", () => {
    const none = { ...reading().metrics, fcp: null, lcp: null, tbt: null, cls: null };
    expect(perfScore(none).score).toBeNull();
    expect(perfScore(none).coverage).toEqual([]);
  });
});

describe("vitalStatus", () => {
  it("compares against the published target as a number, and says nothing when unmeasured", () => {
    expect(vitalStatus("lcp", 2500)).toBe("within");
    expect(vitalStatus("lcp", 2501)).toBe("over");
    expect(vitalStatus("cls", 0.25)).toBe("over");
    expect(vitalStatus("inp", null)).toBeNull();
    expect(vitalStatus("nope", 1)).toBeNull();
  });
});

// ── The gates ─────────────────────────────────────────────────────────────

describe("normalizeSiteHealthReading", () => {
  it("derives host and path from the URL and drops the query", () => {
    const r = normalizeSiteHealthReading({ url: "https://www.Example.com/a?session=abc", facts: {}, metrics: {} });
    expect(r?.host).toBe("example.com");
    expect(r?.path).toBe("/a");
    expect(r?.url).toBe("https://www.Example.com/a?session=abc".slice(0, 2048));
  });
  it("refuses a reading that names no host", () => {
    expect(normalizeSiteHealthReading({ url: "about:blank", facts: {} })).toBeNull();
    expect(normalizeSiteHealthReading("string")).toBeNull();
    expect(normalizeSiteHealthReading(null)).toBeNull();
  });
  it("bounds every page-authored string and list, and carries no unknown key", () => {
    const r = normalizeSiteHealthReading({
      url: "https://example.com/",
      title: "t".repeat(5000),
      engine: "netscape",
      navType: "teleport",
      status: 999,
      xRobotsTag: "x".repeat(5000),
      leak: "no",
      facts: {
        titleLength: -5,
        lang: "l".repeat(100),
        canonical: ["a", "b", "c", "d", 5],
        robots: Array.from({ length: 50 }, () => "noindex"),
        hreflang: Array.from({ length: 50 }, () => ({ lang: "en", href: "https://x/" })),
        jsonLd: { blocks: 3, invalid: 1, types: Array.from({ length: 40 }, (_, i) => `T${i}`) },
        imagesTotal: 2,
        imagesMissingAlt: 9,
        links: { total: 3, generic: 1 },
      },
      metrics: { lcp: -1, fcp: "fast", cls: 0.1 },
    });
    expect(r?.title).toHaveLength(200);
    expect(r?.engine).toBe("unknown");
    expect(r?.navType).toBe("unknown");
    expect(r?.status).toBeNull();
    expect(r?.xRobotsTag).toHaveLength(200);
    expect("leak" in (r as object)).toBe(false);
    expect(r?.facts.titleLength).toBe(0);
    expect(r?.facts.lang).toHaveLength(35);
    expect(r?.facts.canonical).toHaveLength(3);
    expect(r?.facts.robots).toHaveLength(4);
    expect(r?.facts.hreflang).toHaveLength(20);
    expect(r?.facts.jsonLd.types).toHaveLength(10);
    expect(r?.facts.imagesMissingAlt).toBe(2);
    expect(r?.facts.links.uncrawlable).toBe(0);
    expect(r?.metrics.lcp).toBeNull();
    expect(r?.metrics.fcp).toBeNull();
    expect(r?.metrics.coverage).toEqual(["cls"]);
  });
  it("bounds the artifact's page count and drops readings that fail their gate", () => {
    const pages = Array.from({ length: 250 }, (_, i) => ({ url: `https://example.com/${i}`, facts: {}, metrics: {} }));
    pages[3] = { url: "nope", facts: {}, metrics: {} };
    const a = normalizeSiteHealthArtifact({ testId: "t", runId: "r", attempt: 1, ms: 42, pages });
    expect(a?.pages.length).toBe(199);
    expect(a?.ms).toBe(42);
    expect(normalizeSiteHealthArtifact([])).toBeNull();
  });
});

describe("summariseSiteHealth and its gate", () => {
  it("means each host's scores over its pages, most pages first, capped", () => {
    // No canonical on these, so the host override does not turn the fixture's
    // example.com canonical into a cross-host finding: 12 audits apply.
    const pages = [
      reading({ host: "a.test", url: "https://a.test/1", path: "/1" }, { canonical: [] }),
      reading({ host: "a.test", url: "https://a.test/2", path: "/2" }, { canonical: [], descriptionLength: 0 }),
      reading({ host: "b.test", url: "https://b.test/", path: "/" }, { canonical: [] }),
      ...Array.from({ length: 15 }, (_, i) => reading({ host: `h${i}.test`, url: `https://h${i}.test/`, path: "/" }, { canonical: [] })),
    ];
    const summary = summariseSiteHealth({ testId: "t", runId: "r", attempt: 0, ms: 300, pages });
    expect(summary.pages).toBe(pages.length);
    expect(summary.hosts[0]).toMatchObject({ host: "a.test", pages: 2, seo: Math.round((100 + Math.round((100 * 11) / 12)) / 2) });
    expect(summary.hosts).toHaveLength(12);
  });
  it("normalises a summary from another machine — hosts narrowed, scores clamped, unknown keys gone", () => {
    const s = normalizeSiteHealthSummary({
      pages: 3.7,
      ms: "fast",
      extra: true,
      hosts: [
        { host: "WWW.Example.com", pages: 2, seo: 140, perf: -3 },
        { host: "bad host", pages: 1, seo: 50, perf: 50 },
        { host: "ok.test", pages: 1, seo: "50", perf: null },
      ],
    });
    expect(s).toEqual({ pages: 3, ms: 0, hosts: [
      { host: "example.com", pages: 2, seo: 100, perf: 0 },
      { host: "ok.test", pages: 1, seo: null, perf: null },
    ] });
    expect(normalizeSiteHealthSummary({ pages: 1 })).toBeUndefined();
    expect(normalizeSiteHealthSummary("x")).toBeUndefined();
  });
});

describe("describeSiteHealthOutcome", () => {
  it("names the hosts and their scores, and words zero pages as a fault", () => {
    const line = describeSiteHealthOutcome({ pages: 4, ms: 300, hosts: [{ host: "store.example.com", pages: 4, seo: 78, perf: 54 }] });
    expect(line).toBe("Site Health: 4 pages scored on store.example.com — SEO 78, performance 54 (0.3s).");
    expect(describeSiteHealthOutcome({ pages: 0, ms: 0, hosts: [] })).toMatch(/fault/);
    expect(describeSiteHealthOutcome(null)).toMatch(/fault/);
  });
});

// ── Shaping ───────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function hostRow(over: Partial<HostHealthRow> = {}): HostHealthRow {
  return { runId: "r1", host: "example.com", pages: 2, seo: 80, perf: 60, at: NOW - DAY, testId: "t1", testName: "Checkout", browser: "chromium", ...over };
}

function pageRow(over: Partial<PageHealthRow> = {}): PageHealthRow {
  return {
    runId: "r1", pageIndex: 0, host: "example.com", path: "/", url: "https://example.com/", title: "Home", tab: 0, cold: 1, navType: "navigate",
    engine: "chromium", status: 200, seo: 80, seoAudits: "document-title:pass meta-description:fail single-h1:warn structured-data:pass",
    perf: 60, coverage: "fcp lcp tbt cls", fcp: 1500, lcp: 3000, cls: 0.02, tbt: 300, inp: 250, ttfb: 500, dcl: 1000, load: 2000,
    requests: 80, transferBytes: 2_000_000, at: NOW - DAY, testId: "t1", testName: "Checkout", ...over,
  };
}

describe("siteHealthOverview", () => {
  it("scopes to the window, scores the latest reading per page and compares with the period before", () => {
    const hostRows = [
      hostRow({ runId: "old", at: NOW - 40 * DAY, seo: 90, perf: 90 }),
      hostRow({ runId: "r1", at: NOW - 5 * DAY, seo: 80, perf: 60 }),
      hostRow({ runId: "r2", at: NOW - DAY, seo: 76, perf: 58 }),
    ];
    const pageRows = [
      pageRow({ runId: "old", at: NOW - 40 * DAY, seo: 90, perf: 90 }),
      pageRow({ runId: "r1", at: NOW - 5 * DAY, path: "/", seo: 80 }),
      pageRow({ runId: "r2", pageIndex: 0, at: NOW - DAY, path: "/", seo: 70 }),
      pageRow({ runId: "r2", pageIndex: 1, at: NOW - DAY, path: "/cart", seo: 82 }),
    ];
    const { hosts } = siteHealthOverview({ hostRows, pageRows, sinceMs: NOW - 30 * DAY, untilMs: NOW });
    expect(hosts).toHaveLength(1);
    const h = hosts[0];
    expect(h.runs).toBe(2);
    expect(h.pages).toBe(2);
    // The latest reading per path: / → 70 (r2), /cart → 82. Mean 76.
    expect(h.seo).toBe(76);
    expect(h.seoPrev).toBe(90);
    expect(h.series.map((p) => p.runId)).toEqual(["r1", "r2"]);
  });
  it("falls back to the run summary when no page row survived, and has no prior on All", () => {
    const hostRows = [hostRow({ runId: "r1", at: NOW - DAY, seo: 66, perf: 44 })];
    const { hosts } = siteHealthOverview({ hostRows, pageRows: [], sinceMs: 0, untilMs: NOW });
    expect(hosts[0]).toMatchObject({ seo: 66, perf: 44, seoPrev: null, perfPrev: null, runs: 1 });
  });
  it("caps the overview series at the sparkline window", () => {
    const hostRows = Array.from({ length: 30 }, (_, i) => hostRow({ runId: `r${i}`, at: NOW - (30 - i) * 3_600_000 }));
    const { hosts } = siteHealthOverview({ hostRows, pageRows: [], sinceMs: 0, untilMs: NOW });
    expect(hosts[0].series).toHaveLength(20);
    expect(hosts[0].series[19].runId).toBe("r29");
  });
});

describe("siteHealthHostDetail", () => {
  it("turns audits into findings with capped examples, and vitals into p75 against the target", () => {
    const pageRows = [
      pageRow({ runId: "r1", pageIndex: 0, path: "/", lcp: 2000 }),
      pageRow({ runId: "r1", pageIndex: 1, path: "/a", lcp: 3000, seoAudits: "meta-description:fail image-alt:fail" }),
      pageRow({ runId: "r1", pageIndex: 2, path: "/b", lcp: 4000, seoAudits: "meta-description:fail single-h1:warn social-preview:warn" }),
      pageRow({ runId: "r1", pageIndex: 3, path: "/c", lcp: 5000, engine: "webkit", coverage: "fcp", seoAudits: "document-title:pass" }),
    ];
    const d = siteHealthHostDetail({ host: "example.com", hostRows: [hostRow()], pageRows, sinceMs: NOW - 30 * DAY, untilMs: NOW });
    expect(d.pageCount).toBe(4);
    expect(d.findings[0]).toMatchObject({ id: "meta-description", status: "fail", pages: 3, of: 4 });
    expect(d.findings.find((f) => f.id === "single-h1")).toMatchObject({ status: "warn", pages: 2 });
    expect(d.findings.some((f) => f.id === "structured-data")).toBe(false);
    expect(d.info.find((i) => i.id === "structured-data")).toMatchObject({ pages: 1 });
    // p75 of [2000,3000,4000,5000] by nearest rank is the third value.
    expect(d.vitals.lcp).toEqual({ p75: 4000, n: 4, status: "over" });
    expect(d.engines).toEqual([
      { engine: "chromium", readings: 3, partial: 0 },
      { engine: "webkit", readings: 1, partial: 1 },
    ]);
    expect(d.tests).toEqual([{ testId: "t1", testName: "Checkout" }]);
  });
  it("lists examples up to the cap only", () => {
    const pageRows = Array.from({ length: 9 }, (_, i) => pageRow({ pageIndex: i, path: `/${i}`, seoAudits: "https:fail" }));
    const d = siteHealthHostDetail({ host: "example.com", hostRows: [], pageRows, sinceMs: 0, untilMs: NOW });
    expect(d.findings[0].pages).toBe(9);
    expect(d.findings[0].examples).toHaveLength(5);
  });
});

describe("windows and percentiles", () => {
  it("names the prior period of the same length, or none on All", () => {
    expect(priorWindow(100, 130)).toEqual({ since: 70, until: 100 });
    expect(priorWindow(0, 130)).toBeNull();
  });
  it("takes the nearest-rank p75", () => {
    expect(percentile75([1, 2, 3, 4])).toBe(3);
    expect(percentile75([5])).toBe(5);
    expect(percentile75([null, undefined])).toBeNull();
  });
});

describe("words and numbers", () => {
  it("states a change without a status word", () => {
    expect(scoreDelta(54, 58)).toBe("−4 vs prior");
    expect(scoreDelta(60, 58)).toBe("+2 vs prior");
    expect(scoreDelta(58, 58)).toBe("no change vs prior");
    expect(scoreDelta(58, null)).toBeNull();
  });
  it("formats vitals in the unit a person reads", () => {
    expect(formatVital("lcp", 3400)).toBe("3.4 s");
    expect(formatVital("inp", 310)).toBe("310 ms");
    expect(formatVital("cls", 0.02)).toBe("0.02");
    expect(formatVital("cls", 0.004)).toBe("0.004");
    expect(formatVital("lcp", null)).toBe("—");
    expect(describeVital("lcp", 3400)).toBe("over the 2.5 s target");
    expect(describeVital("cls", 0.02)).toBe("within the 0.1 target");
    expect(formatBytes(3.1 * 1024 * 1024)).toBe("3.1 MB");
    expect(formatBytes(412 * 1024)).toBe("412 KB");
  });
});

describe("scoreReading", () => {
  it("carries the reading with both scores and the coverage", () => {
    const s = scoreReading(reading());
    expect(s.seo).toBe(100);
    expect(s.perf).toBeGreaterThan(90);
    expect(s.partial).toBe(false);
    expect(s.audits.length).toBe(SEO_AUDITS.length);
  });
});
