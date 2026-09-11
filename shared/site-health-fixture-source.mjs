// The Site Health probe as a run fixture (the settle / signature / user-page
// idiom): a raw JS string written beside the specs, imported by the capture
// fixture, installed on every page of a run when `GLAZE_SITE_HEALTH=1`.
//
// ── What it measures ────────────────────────────────────────────────────────
// One reading per DOCUMENT the browser loads. A context init script (the
// `glazeSiteHealthInit` below, serialized by Playwright into every document
// before the page's own code) mints a document id and buffers the paint,
// largest-contentful-paint, layout-shift, longtask and event observers behind
// `PerformanceObserver.supportedEntryTypes`, so an engine that lacks one
// simply reports nothing for it. The reader (`readSiteHealthInPage`) is one
// `page.evaluate` that returns FACTS about the document — counts, lengths,
// attribute values, timings — bounded by caps handed in as its argument.
//
// It is read after every wrapped action (from the capture fixture's hook,
// beside axe), on every page's `load` after a short settle, and once more at
// teardown for the current page of every tab. LCP grows and CLS accumulates
// across a document's life, so the LAST reading of a document is the one
// kept: a later read of the same id replaces the earlier one.
//
// ── Why the document response is captured HERE ─────────────────────────────
// The HTTP status and the `X-Robots-Tag` header of a document are not
// readable from inside the page (Firefox and WebKit lack
// `PerformanceNavigationTiming.responseStatus`). A `context.on("response")`
// filtered to navigation requests keeps them per URL. It lives in THIS module
// rather than in the capture fixture because `check:log-capture` pins the
// capture fixture's own response subscription at exactly one — the console
// and network recorder's — and a second one there would read as the recorder
// subscribing twice.
//
// ── What crosses the page boundary ─────────────────────────────────────────
// Facts, never verdicts: the rules that turn "three H1s" into a warning live
// in shared/site-health.mjs, where the app, the CLI and the MCP all read them.
// Every string is capped and every list bounded IN THE PAGE, before it
// leaves; the app rebuilds the reading again on the way in
// (`normalizeSiteHealthReading`). No page text beyond the title is carried,
// and URLs are origin + path — never a query, which is where a session token
// would sit.
//
// Diagnostics go to STDERR only; stdout carries the step markers. Nothing here
// can fail or alter a test: every await is bounded and caught.
//
// Plain JavaScript (no TypeScript) because Playwright loads it through its own
// Babel transform.

import { SITE_HOST_HELPERS } from "./site-host.mjs";
import { GENERIC_LINK_TEXT, SITE_HEALTH_ENV, SITE_HEALTH_FILE } from "./site-health.mjs";

export const SITE_HEALTH_FIXTURE_FILE = "glaze-site-health.mjs";

/** How long after `load` the fixture waits before reading a document that no
 *  action has touched since — long enough for LCP candidates to settle,
 *  short enough that a run ending right after a navigation still gets it. */
export const SITE_HEALTH_SETTLE_MS = 1500;
/** Longest a single in-page read may take. A page that stalls the evaluate
 *  must not stall the run. */
export const SITE_HEALTH_READ_TIMEOUT_MS = 2500;
/** Document responses remembered per run, newest kept. */
export const SITE_HEALTH_RESPONSE_CAP = 100;

/**
 * The caps the reader is handed. Passed as the evaluate ARGUMENT, never closed
 * over — the callback is serialized into the page and keeps no scope from
 * this module (the axe lesson, DECISIONS 2026-08-06).
 */
export const SITE_HEALTH_CAPS = {
  title: 200,
  nodes: 2000,
  canonical: 3,
  robots: 4,
  hreflang: 20,
  types: 10,
  href: 500,
  lang: 35,
  resources: 5000,
  generic: GENERIC_LINK_TEXT,
};

/**
 * The context init script. SELF-CONTAINED: Playwright serializes it into
 * every document, where a reference to anything in this module is a
 * ReferenceError the page swallows.
 *
 * Keeps the running vitals under a non-enumerable global the reader looks
 * for. A page can tamper with it — everything a page hands back is untrusted
 * and bounded on the way in.
 */
function glazeSiteHealthInit() {
  try {
    if (window.__glSH) return;
    var state = {
      id: Math.random().toString(36).slice(2, 12) + Date.now().toString(36),
      supported: [],
      fcp: null,
      lcp: null,
      cls: null,
      tbt: null,
      inp: null,
      clsWindow: { value: 0, start: 0, last: 0 },
    };
    var observe = function (type, onEntries, extra) {
      try {
        if (typeof PerformanceObserver === "undefined") return;
        var types = PerformanceObserver.supportedEntryTypes || [];
        if (types.indexOf(type) === -1) return;
        var observer = new PerformanceObserver(function (list) {
          try {
            onEntries(list.getEntries());
          } catch (e) {
            /* a bad entry must not stop the rest */
          }
        });
        var options = { type: type, buffered: true };
        if (extra) for (var k in extra) options[k] = extra[k];
        observer.observe(options);
        state.supported.push(type);
      } catch (e) {
        /* unsupported here */
      }
    };
    observe("paint", function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].name === "first-contentful-paint") state.fcp = entries[i].startTime;
      }
    });
    observe("largest-contentful-paint", function (entries) {
      var last = entries[entries.length - 1];
      if (last) state.lcp = last.startTime;
    });
    observe("layout-shift", function (entries) {
      // The Core Web Vitals session window: shifts within 1 s of the last and
      // 5 s of the first share a window, and CLS is the largest window.
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.hadRecentInput) continue;
        var w = state.clsWindow;
        if (w.value > 0 && e.startTime - w.last < 1000 && e.startTime - w.start < 5000) {
          w.value += e.value;
          w.last = e.startTime;
        } else {
          w.value = e.value;
          w.start = e.startTime;
          w.last = e.startTime;
        }
        if (state.cls === null || w.value > state.cls) state.cls = w.value;
      }
    });
    observe("longtask", function (entries) {
      // Total Blocking Time: the part of each long task past 50 ms, after
      // first paint. Lighthouse stops at interactive; a live page has no
      // such moment, so this counts until the reading is taken.
      for (var i = 0; i < entries.length; i++) {
        var t = entries[i];
        if (state.fcp !== null && t.startTime + t.duration <= state.fcp) continue;
        var blocking = t.duration - 50;
        if (blocking > 0) state.tbt = (state.tbt || 0) + blocking;
      }
    });
    observe(
      "event",
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var ev = entries[i];
          if (ev.interactionId && (state.inp === null || ev.duration > state.inp)) state.inp = ev.duration;
        }
      },
      { durationThreshold: 16 },
    );
    if (state.supported.indexOf("layout-shift") !== -1 && state.cls === null) state.cls = 0;
    if (state.supported.indexOf("longtask") !== -1 && state.tbt === null) state.tbt = 0;
    Object.defineProperty(window, "__glSH", {
      value: state,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch (e) {
    /* never into the page */
  }
}

/**
 * The reader. SELF-CONTAINED, like the init script: it is the callback of a
 * `page.evaluate`, re-evaluated from its source inside the page. Facts only,
 * every string capped and every list bounded before it returns.
 *
 * @param {typeof SITE_HEALTH_CAPS} caps
 */
function readSiteHealthInPage(caps) {
  var d = document;
  var s = window.__glSH || null;
  var entries = function (type) {
    try {
      return performance.getEntriesByType ? performance.getEntriesByType(type) : [];
    } catch (e) {
      return [];
    }
  };
  var cap = function (v, n) {
    return typeof v === "string" ? v.slice(0, n) : "";
  };
  var attr = function (el, name) {
    var v = el.getAttribute(name);
    return typeof v === "string" ? v.trim() : "";
  };
  var nav = entries("navigation")[0] || null;
  var paints = entries("paint");
  var fcpEntry = null;
  for (var i = 0; i < paints.length; i++) if (paints[i].name === "first-contentful-paint") fcpEntry = paints[i];
  var resources = entries("resource").slice(0, caps.resources);

  var description = d.querySelector('meta[name="description"]');
  var canonical = [];
  var canonicalLinks = d.querySelectorAll('link[rel="canonical"]');
  for (var c = 0; c < canonicalLinks.length && canonical.length < caps.canonical; c++) {
    canonical.push(cap(attr(canonicalLinks[c], "href"), caps.href));
  }
  var robots = [];
  var robotMetas = d.querySelectorAll('meta[name="robots"], meta[name="googlebot"]');
  for (var r = 0; r < robotMetas.length && robots.length < caps.robots; r++) {
    robots.push(cap(attr(robotMetas[r], "content"), 200));
  }
  var images = d.querySelectorAll("img");
  var imagesTotal = Math.min(images.length, caps.nodes);
  var imagesMissingAlt = 0;
  for (var m = 0; m < imagesTotal; m++) {
    var img = images[m];
    if (!img.hasAttribute("alt") && attr(img, "role") !== "presentation" && attr(img, "aria-hidden") !== "true") imagesMissingAlt++;
  }
  var anchors = d.querySelectorAll("a[href]");
  var linksTotal = Math.min(anchors.length, caps.nodes);
  var generic = 0;
  var uncrawlable = 0;
  for (var a = 0; a < linksTotal; a++) {
    var link = anchors[a];
    var href = attr(link, "href");
    if (href === "" || /^javascript:/i.test(href)) uncrawlable++;
    var text = (link.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (text && caps.generic.indexOf(text) !== -1) generic++;
  }
  var hreflang = [];
  var alternates = d.querySelectorAll('link[rel="alternate"][hreflang]');
  for (var h = 0; h < alternates.length && hreflang.length < caps.hreflang; h++) {
    hreflang.push({ lang: cap(attr(alternates[h], "hreflang"), caps.lang), href: cap(attr(alternates[h], "href"), caps.href) });
  }
  var ld = d.querySelectorAll('script[type="application/ld+json"]');
  var blocks = 0;
  var invalid = 0;
  var types = [];
  var collectType = function (node) {
    if (!node || typeof node !== "object" || types.length >= caps.types) return;
    var t = node["@type"];
    if (typeof t === "string" && types.indexOf(t) === -1) types.push(cap(t, 60));
    else if (Array.isArray(t)) for (var k = 0; k < t.length; k++) if (typeof t[k] === "string" && types.indexOf(t[k]) === -1 && types.length < caps.types) types.push(cap(t[k], 60));
    if (Array.isArray(node["@graph"])) for (var g = 0; g < node["@graph"].length; g++) collectType(node["@graph"][g]);
  };
  for (var b = 0; b < ld.length && blocks < 1000; b++) {
    blocks++;
    try {
      var parsed = JSON.parse(ld[b].textContent || "");
      if (Array.isArray(parsed)) for (var p = 0; p < parsed.length; p++) collectType(parsed[p]);
      else collectType(parsed);
    } catch (e) {
      invalid++;
    }
  }
  var metaContent = function (selector) {
    var el = d.querySelector(selector);
    return el ? attr(el, "content") : "";
  };
  var protocol = location.protocol;
  var insecure = 0;
  var transferBytes = 0;
  for (var q = 0; q < resources.length; q++) {
    var res = resources[q];
    if (protocol === "https:" && typeof res.name === "string" && res.name.indexOf("http:") === 0) insecure++;
    if (typeof res.transferSize === "number") transferBytes += res.transferSize;
  }
  if (nav && typeof nav.transferSize === "number") transferBytes += nav.transferSize;
  var ms = function (v) {
    return typeof v === "number" && isFinite(v) && v > 0 ? v : null;
  };
  var navMs = function (name) {
    return nav && typeof nav[name] === "number" && nav[name] > 0 ? nav[name] - (nav.startTime || 0) : null;
  };

  return {
    id: s && typeof s.id === "string" ? s.id : "",
    href: location.href,
    url: location.origin + location.pathname,
    title: cap(d.title, caps.title),
    navType: nav && typeof nav.type === "string" ? nav.type : "unknown",
    status: nav && typeof nav.responseStatus === "number" && nav.responseStatus > 0 ? nav.responseStatus : null,
    facts: {
      titleLength: (d.title || "").length,
      descriptionLength: description ? attr(description, "content").length : 0,
      lang: cap(attr(d.documentElement, "lang"), caps.lang),
      viewport: !!d.querySelector('meta[name="viewport"]'),
      canonical: canonical,
      robots: robots,
      h1Count: d.querySelectorAll("h1").length,
      imagesTotal: imagesTotal,
      imagesMissingAlt: imagesMissingAlt,
      links: { total: linksTotal, generic: generic, uncrawlable: uncrawlable },
      hreflang: hreflang,
      jsonLd: { blocks: blocks, invalid: invalid, types: types },
      og: {
        title: metaContent('meta[property="og:title"]') !== "",
        description: metaContent('meta[property="og:description"]') !== "",
        image: metaContent('meta[property="og:image"]') !== "",
      },
      twitterCard: metaContent('meta[name="twitter:card"]') !== "",
      protocol: cap(protocol, 10),
      insecureResources: insecure,
    },
    metrics: {
      ttfb: navMs("responseStart"),
      fcp: s && typeof s.fcp === "number" ? s.fcp : fcpEntry ? ms(fcpEntry.startTime) : null,
      lcp: s && typeof s.lcp === "number" ? s.lcp : null,
      cls: s && typeof s.cls === "number" ? s.cls : null,
      tbt: s && typeof s.tbt === "number" ? s.tbt : null,
      inp: s && typeof s.inp === "number" ? s.inp : null,
      dcl: navMs("domContentLoadedEventEnd"),
      load: navMs("loadEventEnd"),
      requests: resources.length + (nav ? 1 : 0),
      transferBytes: transferBytes > 0 ? transferBytes : null,
    },
  };
}

/** The two in-page functions as source, for the dom test that evaluates the
 *  shipped string the way Playwright does. */
export const SITE_HEALTH_PAGE_SOURCE = `${glazeSiteHealthInit.toString()}\n${readSiteHealthInPage.toString()}`;

export const siteHealthFixtureSource = `import * as fs from "fs";
import * as path from "path";

const ON = process.env.${SITE_HEALTH_ENV} === "1";
const SETTLE_MS = ${SITE_HEALTH_SETTLE_MS};
const READ_TIMEOUT_MS = ${SITE_HEALTH_READ_TIMEOUT_MS};
const RESPONSE_CAP = ${SITE_HEALTH_RESPONSE_CAP};
const FILE = ${JSON.stringify(SITE_HEALTH_FILE)};
const CAPS = ${JSON.stringify(SITE_HEALTH_CAPS)};

// The host and path rules, interpolated from shared/site-host.mjs — the app
// derives the same two from the same source, so a domain cannot be spelled
// one way by the fixture and another by the rollup.
${SITE_HOST_HELPERS}

${glazeSiteHealthInit.toString()}

${readSiteHealthInPage.toString()}

function note(msg) {
  try {
    process.stderr.write("[glaze-site-health] " + msg + "\\n");
  } catch (e) {
    /* best effort */
  }
}

/** Per-run state. workers=1 + one spec per run, so one test owns this at a time. */
const state = {
  readings: new Map(),      // document id (or url) → the latest reading
  responses: new Map(),     // document url → { status, xRobotsTag }
  timers: new Set(),
  engine: "unknown",
  currentAction: null,      // () => number | null, from the capture fixture
  ms: 0,
  seenDocuments: 0,
  installed: false,
};

/** Which engine this run is on, for the reading. */
function engineOf(page) {
  try {
    const browser = page.context().browser();
    const name = browser ? browser.browserType().name() : "";
    return name === "chromium" || name === "firefox" || name === "webkit" ? name : "unknown";
  } catch (e) {
    return "unknown";
  }
}

/** Which tab a page is, stamped by the tabs fixture; 0 for the first. */
function tabIndexOf(page) {
  try {
    const n = page && page.__glTabIndex;
    return typeof n === "number" && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

/** Resolve when \`promise\` settles or \`ms\` elapses. The terminal catch is what
 *  keeps an abandoned evaluate from becoming an unhandled rejection. */
function withTimeout(promise, ms) {
  let timer = null;
  const guarded = Promise.resolve(promise).catch(() => undefined);
  return Promise.race([
    guarded,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).then((v) => {
    if (timer) clearTimeout(timer);
    return v;
  });
}

/** Remember a document response, keyed by its URL, bounded. */
function rememberResponse(res) {
  try {
    const req = res.request();
    if (req.resourceType() !== "document") return;
    let headers = {};
    try { headers = res.headers(); } catch (e) { headers = {}; }
    const tag = headers["x-robots-tag"];
    const entry = { status: res.status(), xRobotsTag: typeof tag === "string" ? tag.slice(0, 200) : null };
    if (state.responses.size >= RESPONSE_CAP) {
      const oldest = state.responses.keys().next().value;
      if (oldest !== undefined) state.responses.delete(oldest);
    }
    state.responses.set(res.url(), entry);
  } catch (e) {
    /* ignore */
  }
}

function responseFor(href) {
  if (typeof href !== "string") return null;
  const direct = state.responses.get(href);
  if (direct) return direct;
  const hash = href.indexOf("#");
  if (hash !== -1) {
    const noHash = state.responses.get(href.slice(0, hash));
    if (noHash) return noHash;
  }
  return null;
}

/**
 * Read the current document of \`page\` and keep it as the latest reading of
 * that document. \`action\` is the capture action index current at the read,
 * which is what joins the reading to a screenshot later.
 */
export async function readSiteHealth(page, action) {
  if (!ON || !page) return null;
  try {
    if (page.isClosed && page.isClosed()) return null;
  } catch (e) {
    return null;
  }
  const t0 = Date.now();
  let raw = null;
  try {
    raw = await withTimeout(page.evaluate(readSiteHealthInPage, CAPS), READ_TIMEOUT_MS);
  } catch (e) {
    raw = null;
  }
  state.ms += Date.now() - t0;
  if (!raw || typeof raw !== "object") return null;
  const host = siteHostOf(raw.url);
  const pagePath = pagePathOf(raw.url);
  if (!host || !pagePath) return null;
  const key = raw.id || raw.url;
  const previous = state.readings.get(key);
  const response = responseFor(raw.href);
  const reading = {
    id: raw.id || key,
    url: raw.url,
    host,
    path: pagePath,
    title: raw.title,
    tab: tabIndexOf(page),
    cold: previous ? previous.cold : state.seenDocuments === 0,
    navType: raw.navType,
    engine: state.engine,
    action: typeof action === "number" ? action : previous && typeof previous.action === "number" ? previous.action : null,
    at: Date.now(),
    status: raw.status !== null && raw.status !== undefined ? raw.status : response ? response.status : null,
    xRobotsTag: response ? response.xRobotsTag : null,
    facts: raw.facts,
    metrics: raw.metrics,
    source: "lab",
  };
  if (!previous) state.seenDocuments++;
  state.readings.set(key, reading);
  return reading;
}

function scheduleRead(page) {
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    readSiteHealth(page, state.currentAction ? state.currentAction() : null).catch(() => undefined);
  }, SETTLE_MS);
  state.timers.add(timer);
}

/** The page-instance half: read every document this page loads, a settle
 *  after \`load\`. Called for every page a run opens — the tabs fixture hands
 *  later ones over — so a tab's pages are read like the first page's. */
export function installSiteHealthOn(page) {
  if (!ON || !page) return;
  try {
    page.on("load", () => scheduleRead(page));
  } catch (e) {
    note("could not watch a page: " + String(e));
  }
}

/**
 * Install on the first page's context: the init script for every document,
 * the document-response memory, and the load listener on this page.
 * \`opts.currentAction\` reports the capture fixture's action index so a
 * settle-time read can be joined to the screenshot the last action took.
 */
export async function installSiteHealth(page, opts) {
  if (!ON || !page) return false;
  // A retry re-enters the page fixture with a fresh context; the readings of
  // the attempt before it belong to that attempt's artifact, not this one's.
  resetSiteHealthForTests();
  state.engine = engineOf(page);
  state.currentAction = opts && typeof opts.currentAction === "function" ? opts.currentAction : null;
  try {
    const context = page.context();
    await context.addInitScript(glazeSiteHealthInit);
    context.on("response", rememberResponse);
    state.installed = true;
  } catch (e) {
    note("install failed: " + String(e));
    return false;
  }
  installSiteHealthOn(page);
  return true;
}

/** One last read of every open page, then the timers go. Best-effort. */
export async function finishSiteHealth(page) {
  if (!ON) return;
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
  let pages = [];
  try {
    pages = page && page.context ? page.context().pages() : [];
  } catch (e) {
    pages = page ? [page] : [];
  }
  if (pages.length === 0 && page) pages = [page];
  for (const p of pages) {
    try {
      await readSiteHealth(p, state.currentAction ? state.currentAction() : null);
    } catch (e) {
      /* a page that is gone has already been read as far as it could be */
    }
  }
}

/** What this run measured, for the artifact and the run summary. */
export function siteHealthReport() {
  return { ms: state.ms, pages: [...state.readings.values()] };
}

/** Write the artifact into this attempt's directory. Never throws. */
export function writeSiteHealth(dir, testId, runId, attempt) {
  if (!ON || !dir) return false;
  try {
    const report = siteHealthReport();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, FILE),
      JSON.stringify({ testId, runId, attempt, ms: report.ms, pages: report.pages }, null, 2),
    );
    note(report.pages.length + " page(s) read in " + report.ms + "ms");
    return true;
  } catch (e) {
    note("write failed: " + String(e));
    return false;
  }
}

/** Test seam: forget this run's readings. */
export function resetSiteHealthForTests() {
  state.readings.clear();
  state.responses.clear();
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
  state.ms = 0;
  state.seenDocuments = 0;
  state.installed = false;
  state.engine = "unknown";
  state.currentAction = null;
}
`;
