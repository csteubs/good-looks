// The Site Health probe's IN-PAGE half, driven as the SHIPPED STRING.
//
// The capture-fixture-a11y idiom: `glazeSiteHealthInit` is a context init
// script and `readSiteHealthInPage` is the callback of a `page.evaluate`, so
// both are serialized into the page and keep NO scope from the fixture module.
// A reference to anything in that module — a cap, a helper, the generic-link
// list — is a ReferenceError the page swallows, after which every reading is
// null and the whole feature reports nothing while its switch sits on. So
// this test compiles the two functions from `SITE_HEALTH_PAGE_SOURCE` with
// `new Function`, where the only names in scope are the ones the page has.
//
// Documents are parsed with DOMParser and the page's `location` is a plain
// object the test builds, so the URL — and with it the protocol the
// mixed-content count depends on — is the test's to choose.

import { describe, expect, it } from "vitest";

import { SITE_HEALTH_CAPS, SITE_HEALTH_PAGE_SOURCE } from "../../shared/site-health-fixture-source.mjs";
import { normalizeSiteHealthReading, evaluateSeo } from "../../shared/site-health.mjs";

type Entry = Record<string, unknown>;

/** A `PerformanceObserver` that reports what it supports and can be fed. */
function fakeObserver(supported: string[], feed: Record<string, Entry[]>) {
  const observed: string[] = [];
  class FakePerformanceObserver {
    static supportedEntryTypes = supported;
    cb: (list: { getEntries(): Entry[] }) => void;
    constructor(cb: (list: { getEntries(): Entry[] }) => void) {
      this.cb = cb;
    }
    observe(opts: { type: string }): void {
      observed.push(opts.type);
      const entries = feed[opts.type];
      if (entries) this.cb({ getEntries: () => entries });
    }
    disconnect(): void {
      /* nothing */
    }
  }
  return { FakePerformanceObserver, observed };
}

interface Options {
  url?: string;
  supported?: string[];
  feed?: Record<string, Entry[]>;
  navigation?: Entry | null;
  resources?: Entry[];
  paint?: Entry[];
}

/** The four fields of `location` the reader touches, from a URL. */
function locationOf(url: string) {
  const u = new URL(url);
  return { href: u.href, origin: u.origin, pathname: u.pathname, protocol: u.protocol };
}

const PAGE_GLOBALS = ["window", "document", "location", "performance", "PerformanceObserver"];

/** Compile the shipped source with ONLY the page's globals in scope. */
function compile(tail: string, ...globals: unknown[]) {
  return new Function(...PAGE_GLOBALS, `${SITE_HEALTH_PAGE_SOURCE}\n${tail}`)(...globals);
}

/** Build a document, run the init script in it, then the reader — each
 *  compiled from source with only the page's globals in scope. */
function read(html: string, opts: Options = {}) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const window: Record<string, unknown> = {};
  const location = locationOf(opts.url ?? "https://www.example.com/products/x?utm=1#top");
  const byType: Record<string, Entry[]> = {
    navigation: opts.navigation === null ? [] : [opts.navigation ?? { type: "navigate", startTime: 0, responseStart: 120, domContentLoadedEventEnd: 900, loadEventEnd: 1500, transferSize: 4000 }],
    resource: opts.resources ?? [],
    paint: opts.paint ?? [],
  };
  const performance = { getEntriesByType: (t: string) => byType[t] ?? [] };
  const { FakePerformanceObserver, observed } = fakeObserver(
    opts.supported ?? ["paint", "largest-contentful-paint", "layout-shift", "longtask", "event"],
    opts.feed ?? {},
  );
  const compiled = compile(
    "return { init: glazeSiteHealthInit, read: readSiteHealthInPage };",
    window,
    document,
    location,
    performance,
    FakePerformanceObserver,
  ) as {
    init: () => void;
    read: (caps: typeof SITE_HEALTH_CAPS) => Record<string, unknown>;
  };
  compiled.init();
  const raw = compiled.read(SITE_HEALTH_CAPS);
  return { raw, observed, window, document, location };
}

const GOOD = `<!doctype html><html lang="en"><head>
<title>Blue Running Shoe — Example Store</title>
<meta name="description" content="A blue running shoe with a cushioned sole, available in six sizes and three widths for road and trail use.">
<meta name="viewport" content="width=device-width">
<link rel="canonical" href="https://www.example.com/products/x">
<meta property="og:title" content="Blue Running Shoe"><meta property="og:description" content="x"><meta property="og:image" content="https://cdn.example.com/x.jpg">
<meta name="twitter:card" content="summary">
<link rel="alternate" hreflang="en" href="https://www.example.com/products/x">
<link rel="alternate" hreflang="fr" href="https://www.example.com/fr/products/x">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Blue"}</script>
</head><body>
<h1>Blue Running Shoe</h1>
<img src="a.jpg" alt="Blue shoe"><img src="b.jpg" role="presentation">
<a href="/cart">View cart</a><a href="/about">About us</a>
</body></html>`;

describe("the shipped reader is self-contained", () => {
  it("compiles and runs with only the page's globals in scope", () => {
    const { raw } = read(GOOD);
    expect(raw.url).toBe("https://www.example.com/products/x");
    expect(raw.href).toBe("https://www.example.com/products/x?utm=1#top");
    expect(raw.title).toBe("Blue Running Shoe — Example Store");
  });

  it("does not carry the query string in the url it reports", () => {
    const { raw } = read(GOOD, { url: "https://shop.example.com/account?session=SECRETTOKEN" });
    expect(raw.url).toBe("https://shop.example.com/account");
    expect(JSON.stringify({ url: raw.url, facts: raw.facts, metrics: raw.metrics })).not.toContain("SECRETTOKEN");
  });

  it("mints one document id and keeps it across reads", () => {
    const { raw, window, document, location } = read(GOOD);
    expect(typeof raw.id).toBe("string");
    expect((raw.id as string).length).toBeGreaterThan(8);
    const again = (compile("return readSiteHealthInPage;", window, document, location, { getEntriesByType: () => [] }, undefined) as (c: typeof SITE_HEALTH_CAPS) => { id: string })(SITE_HEALTH_CAPS);
    expect(again.id).toBe(raw.id);
  });
});

describe("facts about a well-formed document", () => {
  it("reports the SEO facts the audits read", () => {
    const { raw } = read(GOOD);
    const facts = raw.facts as Record<string, unknown>;
    expect(facts.titleLength).toBe("Blue Running Shoe — Example Store".length);
    expect(facts.descriptionLength).toBeGreaterThan(50);
    expect(facts.lang).toBe("en");
    expect(facts.viewport).toBe(true);
    expect(facts.canonical).toEqual(["https://www.example.com/products/x"]);
    expect(facts.robots).toEqual([]);
    expect(facts.h1Count).toBe(1);
    expect(facts.imagesTotal).toBe(2);
    expect(facts.imagesMissingAlt).toBe(0);
    expect(facts.links).toEqual({ total: 2, generic: 0, uncrawlable: 0 });
    expect(facts.hreflang).toEqual([
      { lang: "en", href: "https://www.example.com/products/x" },
      { lang: "fr", href: "https://www.example.com/fr/products/x" },
    ]);
    expect(facts.jsonLd).toEqual({ blocks: 1, invalid: 0, types: ["Product"] });
    expect(facts.og).toEqual({ title: true, description: true, image: true });
    expect(facts.twitterCard).toBe(true);
    expect(facts.protocol).toBe("https:");
    expect(facts.insecureResources).toBe(0);
  });

  it("…and the app's scorer passes every audit on it", () => {
    const { raw } = read(GOOD);
    const reading = normalizeSiteHealthReading({ ...raw, host: "example.com", path: "/products/x", status: 200 });
    expect(reading).not.toBeNull();
    const seo = evaluateSeo(reading!);
    expect(seo.score).toBe(100);
    expect(seo.audits.filter((a) => a.status === "fail")).toEqual([]);
  });
});

describe("planted defects reach the facts", () => {
  it("counts h1s, alt-less images, generic and uncrawlable links", () => {
    const { raw } = read(`<!doctype html><html><head><title>x</title></head><body>
      <h1>a</h1><h1>b</h1><h1>c</h1>
      <img src="a.jpg"><img src="b.jpg" alt=""><img src="c.jpg" aria-hidden="true">
      <a href="/x">click here</a><a href="javascript:void(0)">Read more</a><a href="">Learn More</a><a href="/y">Pricing</a>
    </body></html>`);
    const facts = raw.facts as Record<string, unknown>;
    expect(facts.h1Count).toBe(3);
    expect(facts.imagesTotal).toBe(3);
    expect(facts.imagesMissingAlt).toBe(1);
    expect(facts.links).toEqual({ total: 4, generic: 3, uncrawlable: 2 });
    expect(facts.lang).toBe("");
    expect(facts.viewport).toBe(false);
    expect(facts.descriptionLength).toBe(0);
  });

  it("reports robots directives, invalid JSON-LD and a missing social preview", () => {
    const { raw } = read(`<!doctype html><html><head><title>x</title>
      <meta name="robots" content="noindex, nofollow"><meta name="googlebot" content="noindex">
      <script type="application/ld+json">{not json</script>
      <script type="application/ld+json">[{"@type":["Product","Thing"]},{"@graph":[{"@type":"Offer"}]}]</script>
    </head><body></body></html>`);
    const facts = raw.facts as Record<string, unknown>;
    expect(facts.robots).toEqual(["noindex, nofollow", "noindex"]);
    expect(facts.jsonLd).toEqual({ blocks: 2, invalid: 1, types: ["Product", "Thing", "Offer"] });
    expect(facts.og).toEqual({ title: false, description: false, image: false });
    expect(facts.twitterCard).toBe(false);
  });

  it("counts http resources on an https document as insecure, and nothing on http", () => {
    const resources = [
      { name: "http://cdn.example.com/a.js", transferSize: 100 },
      { name: "https://cdn.example.com/b.js", transferSize: 200 },
    ];
    const secure = read(GOOD, { resources });
    expect((secure.raw.facts as Record<string, unknown>).insecureResources).toBe(1);
    const plain = read(GOOD, { url: "http://example.com/", resources });
    expect((plain.raw.facts as Record<string, unknown>).insecureResources).toBe(0);
    expect((plain.raw.facts as Record<string, unknown>).protocol).toBe("http:");
  });
});

describe("caps hold inside the page", () => {
  it("bounds every list and string before it leaves", () => {
    const long = "x".repeat(5000);
    const canon = Array.from({ length: 10 }, (_, i) => `<link rel="canonical" href="https://e.com/${long}${i}">`).join("");
    const robots = Array.from({ length: 10 }, () => `<meta name="robots" content="${long}">`).join("");
    const alts = Array.from({ length: 50 }, (_, i) => `<link rel="alternate" hreflang="${long}" href="/${i}">`).join("");
    const types = `<script type="application/ld+json">${JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ "@type": `T${i}${long}` })))}</script>`;
    const { raw } = read(`<!doctype html><html><head><title>${long}</title>${canon}${robots}${alts}${types}</head><body></body></html>`);
    const facts = raw.facts as Record<string, unknown>;
    expect((raw.title as string).length).toBe(SITE_HEALTH_CAPS.title);
    expect(facts.titleLength).toBe(5000);
    expect((facts.canonical as string[]).length).toBe(SITE_HEALTH_CAPS.canonical);
    for (const c of facts.canonical as string[]) expect(c.length).toBeLessThanOrEqual(SITE_HEALTH_CAPS.href);
    expect((facts.robots as string[]).length).toBe(SITE_HEALTH_CAPS.robots);
    for (const r of facts.robots as string[]) expect(r.length).toBeLessThanOrEqual(200);
    expect((facts.hreflang as unknown[]).length).toBe(SITE_HEALTH_CAPS.hreflang);
    for (const h of facts.hreflang as { lang: string }[]) expect(h.lang.length).toBeLessThanOrEqual(SITE_HEALTH_CAPS.lang);
    const ld = facts.jsonLd as { types: string[] };
    expect(ld.types.length).toBe(SITE_HEALTH_CAPS.types);
    for (const t of ld.types) expect(t.length).toBeLessThanOrEqual(60);
  });

  it("stops walking nodes at the cap", () => {
    const imgs = Array.from({ length: SITE_HEALTH_CAPS.nodes + 50 }, () => `<img src="a.jpg">`).join("");
    const { raw } = read(`<!doctype html><html><head><title>x</title></head><body>${imgs}</body></html>`);
    const facts = raw.facts as Record<string, unknown>;
    expect(facts.imagesTotal).toBe(SITE_HEALTH_CAPS.nodes);
    expect(facts.imagesMissingAlt).toBe(SITE_HEALTH_CAPS.nodes);
  });
});

describe("timings", () => {
  it("reads navigation timing relative to its start, and the observer vitals", () => {
    const { raw, observed } = read(GOOD, {
      navigation: { type: "reload", startTime: 10, responseStart: 210, domContentLoadedEventEnd: 1010, loadEventEnd: 2010, transferSize: 1000, responseStatus: 200 },
      resources: [{ name: "https://e.com/a.js", transferSize: 500 }, { name: "https://e.com/b.css", transferSize: 250 }],
      feed: {
        paint: [{ name: "first-paint", startTime: 300 }, { name: "first-contentful-paint", startTime: 420 }],
        "largest-contentful-paint": [{ startTime: 900 }, { startTime: 1400 }],
        "layout-shift": [
          { value: 0.05, startTime: 500, hadRecentInput: false },
          { value: 0.02, startTime: 800, hadRecentInput: false },
          { value: 0.5, startTime: 900, hadRecentInput: true },
          { value: 0.01, startTime: 9000, hadRecentInput: false },
        ],
        longtask: [{ startTime: 100, duration: 200 }, { startTime: 600, duration: 120 }, { startTime: 700, duration: 30 }],
        event: [{ interactionId: 1, duration: 40 }, { interactionId: 2, duration: 120 }, { interactionId: 0, duration: 900 }],
      },
    });
    expect(observed).toEqual(["paint", "largest-contentful-paint", "layout-shift", "longtask", "event"]);
    expect(raw.navType).toBe("reload");
    expect(raw.status).toBe(200);
    const m = raw.metrics as Record<string, unknown>;
    expect(m.ttfb).toBe(200);
    expect(m.dcl).toBe(1000);
    expect(m.load).toBe(2000);
    expect(m.fcp).toBe(420);
    expect(m.lcp).toBe(1400);
    // Two shifts within a second of each other share a window (0.07); the
    // input-driven one is ignored; the one nine seconds later is its own.
    expect(m.cls).toBeCloseTo(0.07, 5);
    // The first long task ends before FCP? No: 100+200=300 < 420, excluded.
    // 600+120: 70 blocking. 700+30: under 50, nothing.
    expect(m.tbt).toBe(70);
    expect(m.inp).toBe(120);
    expect(m.requests).toBe(3);
    expect(m.transferBytes).toBe(1750);
  });

  it("reports null for a vital the engine does not observe, never zero", () => {
    const { raw } = read(GOOD, { supported: ["paint"], navigation: null });
    const m = raw.metrics as Record<string, unknown>;
    expect(m.lcp).toBeNull();
    expect(m.cls).toBeNull();
    expect(m.tbt).toBeNull();
    expect(m.inp).toBeNull();
    expect(m.ttfb).toBeNull();
    expect(m.dcl).toBeNull();
    expect(m.load).toBeNull();
    expect(raw.navType).toBe("unknown");
    expect(raw.status).toBeNull();
  });

  it("reports zero CLS and TBT on an engine that observes them and saw none", () => {
    const { raw } = read(GOOD, { supported: ["layout-shift", "longtask"] });
    const m = raw.metrics as Record<string, unknown>;
    expect(m.cls).toBe(0);
    expect(m.tbt).toBe(0);
  });

  it("falls back to the paint entry for FCP when no observer ran", () => {
    const { raw } = read(GOOD, { supported: [], paint: [{ name: "first-contentful-paint", startTime: 333 }] });
    expect((raw.metrics as Record<string, unknown>).fcp).toBe(333);
  });

  it("survives a page without PerformanceObserver at all", () => {
    const document = new DOMParser().parseFromString(GOOD, "text/html");
    const out = (compile("glazeSiteHealthInit();\nreturn readSiteHealthInPage;", {}, document, locationOf("https://e.com/"), { getEntriesByType: () => [] }, undefined) as (c: typeof SITE_HEALTH_CAPS) => { id: string; metrics: Record<string, unknown> })(SITE_HEALTH_CAPS);
    expect(out.id.length).toBeGreaterThan(8);
    expect(out.metrics.lcp).toBeNull();
  });
});
