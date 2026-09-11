// Standalone check for the Site Health fixture's WORKER half, executed from
// the SHIPPED STRING against a stubbed page and context.
//
// The fixture is written beside the specs at run time and loaded by
// Playwright's own transform, so nothing imports it in the ordinary way and a
// test that re-implemented it would verify something that never runs. This
// writes `siteHealthFixtureSource` to a temp directory, imports THAT, and
// drives it the way the capture fixture does: install on the first page's
// context, read after an action, read after a load settles, finish, write.
//
// What it pins, in order: the install shape (one init script on the CONTEXT,
// one document-response subscription, one load listener per page); the
// document-response join (an engine that cannot read `responseStatus` from
// inside the page gets the status and the X-Robots-Tag from the response the
// fixture remembered); latest-reading-wins per document (LCP grows and CLS
// accumulates, so the last read of a document is the one kept); the cold
// flag on the first document only; a stalled or throwing evaluate costing
// the read and never the run; the artifact landing in the attempt directory
// under the ONE filename shared/site-health.mjs spells, in a shape the app's
// normaliser accepts; and the whole thing doing nothing with the switch off.
//
// The in-page half — the init script and the reader — has a DOM test of its
// own (main/services/site-health-fixture.dom.test.ts). The two meet a real
// browser in e2e/site-health.spec.ts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { captureFixtureSource } from "../../../shared/capture-fixture-source.mjs";
import {
  SITE_HEALTH_FIXTURE_FILE,
  SITE_HEALTH_READ_TIMEOUT_MS,
  SITE_HEALTH_SETTLE_MS,
  siteHealthFixtureSource,
} from "../../../shared/site-health-fixture-source.mjs";
import {
  SITE_HEALTH_ENV,
  SITE_HEALTH_FILE,
  normalizeSiteHealthArtifact,
  summariseSiteHealth,
} from "../../../shared/site-health.mjs";
import { CAPABILITY_FIXTURES } from "../../../shared/run-fixtures.mjs";

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

type Listener = (...args: unknown[]) => void;
type Raw = Record<string, unknown>;

class FakeContext {
  initScripts: unknown[] = [];
  listeners = new Map<string, Listener[]>();
  pagesList: FakePage[] = [];
  engine = "chromium";
  pages(): FakePage[] {
    return this.pagesList.filter((p) => !p.closed);
  }
  browser() {
    return { browserType: () => ({ name: () => this.engine }) };
  }
  async addInitScript(src: unknown): Promise<void> {
    this.initScripts.push(src);
  }
  on(event: string, cb: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  /** What Playwright hands a response listener, reduced to what is read. */
  respond(url: string, status: number, resourceType = "document", headers: Record<string, string> = {}): void {
    this.emit("response", {
      url: () => url,
      status: () => status,
      headers: () => headers,
      request: () => ({ resourceType: () => resourceType }),
    });
  }
}

class FakePage {
  closed = false;
  listeners = new Map<string, Listener[]>();
  evaluations = 0;
  /** What the next evaluate returns — the raw reading the in-page reader
   *  would have produced. A function is CALLED, so a stall can be modelled. */
  raw: Raw | null | (() => Promise<Raw | null>) = null;
  lastFn: unknown = null;
  lastArg: unknown = null;
  constructor(public ctx: FakeContext) {
    ctx.pagesList.push(this);
  }
  context(): FakeContext {
    return this.ctx;
  }
  isClosed(): boolean {
    return this.closed;
  }
  on(event: string, cb: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string): void {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }
  async evaluate(fn: unknown, arg: unknown): Promise<unknown> {
    this.evaluations++;
    this.lastFn = fn;
    this.lastArg = arg;
    if (typeof this.raw === "function") return this.raw();
    return this.raw;
  }
}

function rawReading(over: Partial<Raw> = {}): Raw {
  return {
    id: "doc-a",
    href: "https://www.shop.example.com/products/x?utm=1",
    url: "https://www.shop.example.com/products/x",
    title: "Blue Shoe",
    navType: "navigate",
    status: null,
    facts: {
      titleLength: 9,
      descriptionLength: 80,
      lang: "en",
      viewport: true,
      canonical: ["https://www.shop.example.com/products/x"],
      robots: [],
      h1Count: 1,
      imagesTotal: 2,
      imagesMissingAlt: 0,
      links: { total: 2, generic: 0, uncrawlable: 0 },
      hreflang: [],
      jsonLd: { blocks: 0, invalid: 0, types: [] },
      og: { title: true, description: true, image: true },
      twitterCard: true,
      protocol: "https:",
      insecureResources: 0,
    },
    metrics: { ttfb: 200, fcp: 900, lcp: 1800, cls: 0.02, tbt: 40, inp: null, dcl: 1200, load: 2000, requests: 12, transferBytes: 400000 },
    ...over,
  };
}

interface Fixture {
  installSiteHealth(page: unknown, opts: { currentAction?: () => number | null }): Promise<boolean>;
  installSiteHealthOn(page: unknown): void;
  readSiteHealth(page: unknown, action: number | null): Promise<Raw | null>;
  finishSiteHealth(page: unknown): Promise<void>;
  siteHealthReport(): { ms: number; pages: Raw[] };
  writeSiteHealth(dir: string, testId: string, runId: string, attempt: number): boolean;
  resetSiteHealthForTests(): void;
}

async function load(on: boolean): Promise<{ fixture: Fixture; dir: string }> {
  process.env[SITE_HEALTH_ENV] = on ? "1" : "0";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `glaze-site-health-${on ? "on" : "off"}-`));
  const file = path.join(dir, SITE_HEALTH_FIXTURE_FILE);
  fs.writeFileSync(file, siteHealthFixtureSource);
  const fixture = (await import(pathToFileURL(file).href)) as Fixture;
  return { fixture, dir };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stderr: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown) => {
  stderr.push(String(chunk));
  return true;
}) as typeof process.stderr.write;

async function main(): Promise<void> {
  // ── 0. The file ships with the capability set, under the one name ──────
  assert(
    CAPABILITY_FIXTURES.some((f) => f.file === SITE_HEALTH_FIXTURE_FILE && f.source === siteHealthFixtureSource),
    "the fixture is in CAPABILITY_FIXTURES under its own filename",
  );
  assert(
    captureFixtureSource.includes(`from "./${SITE_HEALTH_FIXTURE_FILE}"`),
    "the capture fixture imports it by that filename",
  );
  for (const call of ["installSiteHealth(page, {", "installSiteHealthOn(p)", "readSiteHealth(page, index)", "finishSiteHealth(page)", "writeSiteHealth(ctx.dir, TEST_ID, RUN_ID, attemptNo)"]) {
    assert(captureFixtureSource.includes(call), `the capture fixture calls ${call.split("(")[0]} at its site`);
  }
  assert(
    /\(\(ON \|\| A11Y_ON \|\| LOGS_ON \|\| SITE_HEALTH_ON\) && DIR\)/.test(captureFixtureSource),
    "a site-health-only run extends the page fixture (the switch is in the gate)",
  );
  assert(
    /\(!ON && !A11Y_ON && !LOGS_ON && !SITE_HEALTH_ON\) \|\| !DIR/.test(captureFixtureSource),
    "…and takes the artifact branch, where the write happens",
  );
  assert(
    siteHealthFixtureSource.includes(`process.env.${SITE_HEALTH_ENV} === "1"`),
    `the fixture's switch is ${SITE_HEALTH_ENV}`,
  );

  // ── 0b. The app runner arms it from the ONE setting, and reads it back ──
  //
  // Source-level, like check:auto-heal-wiring: the runner is only reachable
  // through a real Electron process. Each of these is a place the feature can
  // be present and inert — the switch set but the env not passed, the artifact
  // written but never read, the summary derived but never persisted.
  const appRunner = fs.readFileSync(path.join(process.cwd(), "main/services/playwright-runner.ts"), "utf8");
  assert(
    /const siteHealth = healSettings\.siteHealthChecks && !rec\.sourceDir;/.test(appRunner),
    "app runner: the gate is the global setting, never an imported spec — no per-test layer",
  );
  assert(
    /\[SITE_HEALTH_ENV\]: siteHealth \? "1" : "0",/.test(appRunner),
    "app runner: the fixture's switch travels through the shared env name",
  );
  assert(
    /const artifactRun = captureArtifacts \|\| healing \|\| a11y \|\| recordLogs \|\| siteHealth;/.test(appRunner),
    "app runner: a site-health-only run gets an artifact directory (the fixture writes into it)",
  );
  assert(
    /artifactStore\.readSiteHealth\(rec\.id, recordId\)/.test(appRunner) && /summariseSiteHealth\(/.test(appRunner),
    "app runner: the artifact is read back and summarised through the shared rule",
  );
  assert(
    /describeSiteHealthOutcome\(siteHealthSummary\)/.test(appRunner),
    "app runner: the Output panel says what the check found — or that it read nothing",
  );
  assert(
    /siteHealth: siteHealthSummary,/.test(appRunner),
    "app runner: the summary reaches the run record (what metrics.db rolls up from)",
  );
  assert(
    /"Checking Site Health for this run\.\\n"/.test(appRunner),
    "app runner: the check is announced like accessibility is",
  );
  const runHistory = fs.readFileSync(path.join(process.cwd(), "main/services/run-history-store.ts"), "utf8");
  assert(
    /siteHealth\?: SiteHealthSummary;/.test(runHistory) && /run\.siteHealth \? \{ siteHealth: run\.siteHealth \}/.test(runHistory),
    "run history: append declares AND spreads the field (a field it does not name is dropped silently)",
  );

  const { fixture, dir: onDir } = await load(true);
  const ctx = new FakeContext();
  const page = new FakePage(ctx);
  let action: number | null = null;

  // ── 1. Install shape ───────────────────────────────────────────────────
  const installed = await fixture.installSiteHealth(page, { currentAction: () => action });
  assert(installed === true, "install reports success with the switch on");
  assert(ctx.initScripts.length === 1 && typeof ctx.initScripts[0] === "function", "one init script, on the CONTEXT, as a function Playwright serializes");
  assert(
    String(ctx.initScripts[0]).includes("__glSH") && String(ctx.initScripts[0]).includes("PerformanceObserver"),
    "…and it is the vitals collector",
  );
  assert((ctx.listeners.get("response") ?? []).length === 1, "one response subscription, on the CONTEXT");
  assert((page.listeners.get("load") ?? []).length === 1, "one load listener on the first page");
  assert(fixture.siteHealthReport().pages.length === 0, "nothing read yet");

  // ── 2. A read after an action ──────────────────────────────────────────
  page.raw = rawReading();
  const first = await fixture.readSiteHealth(page, 3);
  assert(first !== null, "a reading comes back");
  assert(typeof page.lastFn === "function" && String(page.lastFn).includes("readSiteHealthInPage"), "the evaluate is the shipped reader");
  assert(
    typeof page.lastArg === "object" && page.lastArg !== null && "generic" in (page.lastArg as object),
    "the caps travel as the evaluate ARGUMENT, not a closure",
  );
  assert(first?.host === "shop.example.com" && first?.path === "/products/x", "host folds www. and the path is the pathname");
  assert(first?.url === "https://www.shop.example.com/products/x", "url carries no query");
  assert(first?.action === 3 && first?.engine === "chromium" && first?.tab === 0 && first?.cold === true, "action, engine, tab and cold are stamped");
  assert(first?.source === "lab", "the reading says where it came from");

  // ── 3. The document-response join ─────────────────────────────────────
  ctx.respond("https://www.shop.example.com/products/x?utm=1", 404, "document", { "x-robots-tag": "noindex" });
  ctx.respond("https://www.shop.example.com/a.js", 500, "script");
  const joined = await fixture.readSiteHealth(page, 4);
  assert(joined?.status === 404 && joined?.xRobotsTag === "noindex", "status and X-Robots-Tag come from the remembered document response");
  page.raw = rawReading({ status: 200 });
  const inPage = await fixture.readSiteHealth(page, 5);
  assert(inPage?.status === 200, "…unless the page could read its own responseStatus, which wins");
  ctx.respond("https://www.shop.example.com/products/y", 301);
  page.raw = rawReading({ id: "doc-hash", href: "https://www.shop.example.com/products/y#top", url: "https://www.shop.example.com/products/y" });
  const hashed = await fixture.readSiteHealth(page, 6);
  assert(hashed?.status === 301, "a fragment on the href still finds the response");

  // ── 4. Latest reading wins per document ───────────────────────────────
  page.raw = rawReading({ metrics: { ...(rawReading().metrics as Raw), lcp: 2600, cls: 0.11 } });
  await fixture.readSiteHealth(page, null);
  const pages = fixture.siteHealthReport().pages;
  const docA = pages.find((p) => p.id === "doc-a");
  assert(pages.length === 2, "two documents, two readings — a re-read replaces, never appends");
  assert((docA?.metrics as Raw)?.lcp === 2600 && (docA?.metrics as Raw)?.cls === 0.11, "the LAST read's vitals are kept");
  assert(docA?.action === 5, "a read with no action keeps the last action's index");
  assert(docA?.cold === true && pages.find((p) => p.id === "doc-hash")?.cold === false, "cold marks the first document only, and survives a re-read");

  // ── 5. Reads that cannot complete ─────────────────────────────────────
  page.raw = () => Promise.reject(new Error("Execution context was destroyed"));
  assert((await fixture.readSiteHealth(page, 7)) === null, "a throwing evaluate returns null");
  page.raw = () => new Promise(() => undefined);
  const t0 = Date.now();
  const stalled = await fixture.readSiteHealth(page, 8);
  const took = Date.now() - t0;
  assert(stalled === null && took >= SITE_HEALTH_READ_TIMEOUT_MS - 50 && took < SITE_HEALTH_READ_TIMEOUT_MS + 1500, `a stalled evaluate returns null at the cap (${took}ms)`);
  page.raw = rawReading({ url: "about:blank", href: "about:blank", id: "blank" });
  assert((await fixture.readSiteHealth(page, 9)) === null, "a document with no http host is not a reading");
  page.raw = rawReading({ url: "https://localhost:3000/", href: "https://localhost:3000/", id: "local" });
  assert((await fixture.readSiteHealth(page, 9))?.host === "localhost", "…but a loopback host is (the scorer marks https/mixed-content n/a there)");
  assert(fixture.siteHealthReport().pages.length === 3, "the failed reads left nothing behind");
  const closedPage = new FakePage(ctx);
  closedPage.closed = true;
  closedPage.raw = rawReading({ id: "closed" });
  assert((await fixture.readSiteHealth(closedPage, 1)) === null && closedPage.evaluations === 0, "a closed page is not evaluated");
  closedPage.closed = false;
  ctx.pagesList.pop();

  // ── 6. A load settles into a read ─────────────────────────────────────
  const second = new FakePage(ctx);
  fixture.installSiteHealthOn(second);
  second.raw = rawReading({ id: "doc-b", url: "https://www.shop.example.com/cart", href: "https://www.shop.example.com/cart" });
  action = 11;
  second.emit("load");
  assert(second.evaluations === 0, "the load read waits for the settle");
  await sleep(SITE_HEALTH_SETTLE_MS + 200);
  const cart = fixture.siteHealthReport().pages.find((p) => p.id === "doc-b");
  assert(second.evaluations === 1 && cart?.action === 11, "…then reads once, keyed to the current action");

  // ── 7. finish reads every open page, then the artifact ────────────────
  page.raw = rawReading({ metrics: { ...(rawReading().metrics as Raw), lcp: 3100 } });
  second.raw = rawReading({ id: "doc-b", url: "https://www.shop.example.com/cart", href: "https://www.shop.example.com/cart", title: "Cart (1)" });
  const third = new FakePage(ctx);
  fixture.installSiteHealthOn(third);
  third.raw = rawReading({ id: "doc-c", url: "https://www.shop.example.com/checkout", href: "https://www.shop.example.com/checkout" });
  third.emit("load");
  await fixture.finishSiteHealth(page);
  const after = fixture.siteHealthReport();
  assert(after.pages.length === 5, `every open page of the context was read (${after.pages.length} readings)`);
  assert((after.pages.find((p) => p.id === "doc-a")?.metrics as Raw)?.lcp === 3100, "the finish read is the reading kept");
  assert(after.pages.find((p) => p.id === "doc-b")?.title === "Cart (1)", "…on every page, not only the first");
  const readsBefore = third.evaluations;
  await sleep(SITE_HEALTH_SETTLE_MS + 200);
  assert(third.evaluations === readsBefore, "a pending settle timer is cancelled by finish");
  assert(after.ms >= SITE_HEALTH_READ_TIMEOUT_MS, "the reported ms includes the stalled read's cost");

  const attemptDir = path.join(onDir, "artifacts", "attempt-1");
  assert(fixture.writeSiteHealth(attemptDir, "t-1", "r-1", 1) === true, "the artifact is written (creating the attempt directory)");
  const file = path.join(attemptDir, SITE_HEALTH_FILE);
  assert(fs.existsSync(file), `…as ${SITE_HEALTH_FILE}, the name shared/site-health.mjs spells`);
  const artifact = normalizeSiteHealthArtifact(JSON.parse(fs.readFileSync(file, "utf8")));
  assert(artifact !== null && artifact.testId === "t-1" && artifact.runId === "r-1" && artifact.attempt === 1, "the app's normaliser accepts what the fixture wrote");
  assert(artifact !== null && artifact.pages.length === 5, "…with every reading");
  const summary = summariseSiteHealth(artifact!);
  assert(summary.hosts.length === 2 && summary.hosts.some((h) => h.host === "shop.example.com" && h.pages === 4), "…and the summary groups them by host");
  assert(stderr.some((l) => l.includes("[glaze-site-health] 5 page(s) read")), "the write is noted on stderr, never stdout");

  // ── 8. A retry starts clean ───────────────────────────────────────────
  const retryCtx = new FakeContext();
  const retryPage = new FakePage(retryCtx);
  await fixture.installSiteHealth(retryPage, {});
  assert(fixture.siteHealthReport().pages.length === 0, "a re-install (a retry's fresh context) forgets the previous attempt's readings");
  assert(retryCtx.initScripts.length === 1 && (retryCtx.listeners.get("response") ?? []).length === 1, "…and installs on the new context");

  // ── 9. Off is off ─────────────────────────────────────────────────────
  const off = await load(false);
  const offCtx = new FakeContext();
  const offPage = new FakePage(offCtx);
  offPage.raw = rawReading();
  assert((await off.fixture.installSiteHealth(offPage, {})) === false, "with the switch off, install declines");
  assert(offCtx.initScripts.length === 0 && offCtx.listeners.size === 0 && offPage.listeners.size === 0, "…and touches nothing");
  assert((await off.fixture.readSiteHealth(offPage, 1)) === null && offPage.evaluations === 0, "…reads nothing");
  const offDir = path.join(off.dir, "artifacts");
  assert(off.fixture.writeSiteHealth(offDir, "t", "r", 0) === false && !fs.existsSync(path.join(offDir, SITE_HEALTH_FILE)), "…and writes nothing");

  fs.rmSync(onDir, { recursive: true, force: true });
  fs.rmSync(off.dir, { recursive: true, force: true });
}

main()
  .catch((err) => {
    failures++;
    realWrite(`FAIL check threw: ${String(err && (err as Error).stack) || String(err)}\n`);
  })
  .finally(() => {
    process.stderr.write = realWrite as typeof process.stderr.write;
    if (failures > 0) {
      console.error(`\ncheck:site-health — ${failures} failure(s)`);
      process.exitCode = 1;
    } else {
      console.log("\ncheck:site-health — all assertions passed");
    }
  });
