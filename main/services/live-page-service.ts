// The Script IDE's live page: a Playwright browser the EDITOR owns.
//
// The trainer cannot be the editor's page — the detail view, and the Script
// tab with it, is unmounted for the whole of a recording session — and its
// oracle (`matchesFor`) is a model of Playwright's resolution rather than
// Playwright. This service launches the real engine from the main process,
// headed, at the test's site address, and answers the three questions the
// editor asks of a page with Playwright's own answers: how many elements a
// locator matches, which element that is (`locator.highlight()`), and which
// locator the user means (`page.pickLocator()`, 1.59+). No recording happens
// here; the trainer stays the recorder.
//
// `playwright` is imported DYNAMICALLY and is external to the main bundle
// (scripts/build-main.mjs): it is the library the bundled CLI ships with, it
// spawns browser binaries, and a static import would make the main process
// pay for it at boot whether or not a live page is ever opened. The browsers
// directory is the app's own (`PLAYWRIGHT_BROWSERS_PATH`, set before the
// import — the registry reads it once, at module load).
//
// A LOCATOR IS EVALUATED, NOT INTERPOLATED. The renderer hands over a Locator
// MODEL; it is rebuilt by `normalizeLocator` (the capture-boundary rule) and
// spelled by the generator's own `locatorExpr`, so the expression handed to
// `new Function` is one the generator would have put in a spec — the same
// trust a run extends to the same text, with `q()` already between every
// user value and the source.

import { logger } from "@shell/backend";

import { credentialOrigin } from "../../shared/basic-auth.mjs";
import { normalizeSignatureHost, signatureForUrl } from "../../shared/shopify-signature.mjs";
import type { Locator, RunBrowser } from "../recorder/types.js";
import { normalizeLocator } from "../recorder/types.js";
import { locatorExpr } from "./script-generator.js";
import { parseLocatorExpression } from "./spec-parser.js";
import { sendToMain } from "./app-window.js";
import { shopifySignatureStore } from "./shopify-signature-store.js";
import type { ShopifySignatureEntry } from "./shopify-signature-store.js";
import { testStore } from "./test-store.js";
import { testSecretsStore } from "./test-secrets-store.js";

export interface LivePageStatus {
  open: boolean;
  url?: string;
  title?: string;
  browser?: RunBrowser;
  /** A `pickLocator` is waiting for a click in the browser. */
  picking?: boolean;
  /** Why the page is closed, when it closed on its own (the window was shut,
   *  the browser crashed). */
  closedReason?: string;
}

export interface LivePageCount {
  /** Matches on the live page, or null when the locator could not be built
   *  or the page is gone. */
  count: number | null;
  error?: string;
}

export interface LivePagePick {
  /** Playwright's own spelling of what was picked — `getByRole('button', …)`. */
  expr: string;
  /** The app's model of it, when the parser reads that spelling; null for a
   *  shape the parser does not know (the editor then inserts `expr`
   *  verbatim and the coverage gutter says so). */
  locator: Locator | null;
}

/** The slice of Playwright this service uses, so a test can hand in a fake. */
export interface LivePageLike {
  goto(url: string): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  on(event: "close" | "framenavigated", handler: (...args: unknown[]) => void): unknown;
  mainFrame(): unknown;
  pickLocator(): Promise<{ toString(): string }>;
  cancelPickLocator(): Promise<void>;
  locator(selector: string): { highlight(): Promise<void> };
  close(): Promise<void>;
}

/** The slice of Playwright's `Route` the signature handler uses.
 *
 *  `allHeaders()` rather than `headers()`, and this is not a preference:
 *  `continue({ headers })` REPLACES the header set, so anything missing from
 *  what we pass is dropped from the request. Same reason
 *  `signature-fixture-source.ts` states for the run. */
export interface LiveRouteLike {
  request(): { url(): string; allHeaders(): Promise<Record<string, string>> };
  continue(options?: { headers?: Record<string, string> }): Promise<void>;
}

/** The slice of Playwright's `BrowserContext` this service uses.
 *
 *  A context, not a bare `newPage()`, because `httpCredentials` is a CONTEXT
 *  option in Playwright — there is no per-page or per-request way to answer a
 *  401 — and because routing belongs on the context so a popup the user opens
 *  from the live page is covered by the same rule as the page itself. */
export interface LiveContextLike {
  newPage(): Promise<LivePageLike>;
  route(
    predicate: (url: URL) => boolean,
    handler: (route: LiveRouteLike) => Promise<void> | void,
  ): Promise<void>;
}

export interface LiveContextOptions {
  /** Scoped to the test's own ORIGIN, always — see `shared/basic-auth.mjs`.
   *  Unscoped credentials answer any server's challenge. */
  httpCredentials?: { username: string; password: string; origin?: string };
}

export interface LiveBrowserLike {
  newContext(options?: LiveContextOptions): Promise<LiveContextLike>;
  close(): Promise<void>;
  on(event: "disconnected", handler: () => void): unknown;
}

export type LiveLauncher = (browser: RunBrowser) => Promise<LiveBrowserLike>;

/** How long a locator may take to count or highlight. A live page is a
 *  page the user can see; a count that hangs is worse than "unknown". */
const LOCATOR_TIMEOUT_MS = 3_000;

let launcher: LiveLauncher | null = null;
let current: { browser: LiveBrowserLike; page: LivePageLike; engine: RunBrowser } | null = null;
let picking = false;
let closedReason: string | undefined;

/**
 * The Shopify crawler signature for THIS live page: which hosts it was armed
 * for, and how many requests it actually signed for each.
 *
 * The same pair the trainer keeps, for the same reason — a live page that
 * arms a signature and signs nothing is indistinguishable, from inside the
 * app, from one that signed everything, because the visible result of an
 * unsigned request to a protected storefront is a perfectly good 200 serving
 * the password page. Logged when the page closes.
 */
let signatureArmed: string[] = [];
let signedRequests = new Map<string, number>();

/**
 * The basic-auth credential this live page should present, or null.
 *
 * Scoped to the test's own origin through `credentialOrigin`, which is the
 * SAME function the generated spec's `test.use({ httpCredentials })` and the
 * trainer's `login` handler derive their scope from. Three surfaces, one rule:
 * an unscoped credential answers any server's 401, so a third-party
 * subresource or a redirect to another host would receive the password.
 *
 * A declared password with no stored value still produces a credential, with
 * an empty string — matching the run (`process.env.GLAZE_SECRET_x ?? ""`) and
 * the trainer. The wall then holds, which is a legible failure at the place it
 * happened; silently not answering at all would present as the native
 * credential dialog instead, which is the state this feature exists to remove.
 */
async function liveCredentials(
  testId: string | undefined,
): Promise<LiveContextOptions["httpCredentials"] | null> {
  if (!testId) return null;
  const rec = testStore.get(testId);
  const basicAuth = rec?.basicAuth;
  if (!basicAuth || !basicAuth.passwordVar) return null;
  let password = "";
  try {
    password = (await testSecretsStore.valuesFor(testId))[basicAuth.passwordVar] ?? "";
  } catch (err) {
    // A secret store that cannot be read is not a reason to refuse the page.
    logger.warn("live-page", "Could not read the basic-auth secret", { err: String(err) });
  }
  const origin = credentialOrigin(rec?.url) ?? credentialOrigin(rec?.baseUrl);
  return { username: basicAuth.username || "", password, ...(origin ? { origin } : {}) };
}

/**
 * Attach the Shopify signature headers to requests bound for a registered host.
 *
 * A ROUTE with a predicate, never `newContext({ extraHTTPHeaders })`, and the
 * argument is `signature-fixture-source.ts`'s verbatim: context-wide headers
 * would hand the credential to `cdn.shopify.com`, `monorail-edge.shopifysvc.com`,
 * whatever analytics the merchant installed, and every other authority the
 * storefront loads from. The signature covers `@authority`, so presenting it at
 * a host it was not issued for is an INVALID signature offered to a verifier
 * whose job is spotting bot spoofing — not merely a useless one.
 *
 * The handler must call `continue()` on EVERY path including a throw: an
 * un-continued route hangs its request until the page's own timeout, which
 * presents as a live page that never finishes loading.
 */
async function installSignatureRoute(
  context: LiveContextLike,
  entries: readonly ShopifySignatureEntry[],
): Promise<void> {
  await context.route(
    (url) => {
      try {
        return signatureForUrl(entries, url.toString(), Date.now()) !== null;
      } catch {
        return false;
      }
    },
    async (route) => {
      let entry: ShopifySignatureEntry | null = null;
      try {
        // Re-resolved here rather than trusted from the predicate: a redirect
        // is its own route event, and expiry is re-read so a signature that
        // lapses while the page is open stops being sent.
        entry = signatureForUrl(entries, route.request().url(), Date.now());
      } catch {
        entry = null;
      }
      if (!entry) {
        try {
          await route.continue();
        } catch {
          /* the page moved on; the request is already gone */
        }
        return;
      }
      try {
        const current = await route.request().allHeaders();
        await route.continue({
          headers: {
            ...current,
            "signature-input": entry.signatureInput,
            signature: entry.signature,
            "signature-agent": entry.signatureAgent,
          },
        });
        signedRequests.set(entry.host, (signedRequests.get(entry.host) ?? 0) + 1);
      } catch (err) {
        // Logged by NAME AND MESSAGE only. A stringified route or request could
        // carry the header values straight into the app log.
        logger.warn("live-page", "Could not sign a live-page request", {
          err: err instanceof Error ? `${err.name}: ${err.message}` : "Error",
        });
        try {
          await route.continue();
        } catch {
          /* already gone */
        }
      }
    },
  );
}

/** Say what the signature did for the page that is closing, and reset.
 *
 *  Armed-with-nothing-signed is the case worth seeing, and it is why both
 *  halves are logged rather than only the total. */
function reportSignatures(): void {
  if (signatureArmed.length > 0) {
    logger.info("live-page", "Shopify crawler signature for this live page", {
      armed: signatureArmed,
      signed: Object.fromEntries(signedRequests),
      signedTotal: [...signedRequests.values()].reduce((a, b) => a + b, 0),
    });
  }
  signatureArmed = [];
  signedRequests = new Map();
}

/** The production launcher: the real library, the app's browsers directory. */
async function defaultLauncher(browser: RunBrowser): Promise<LiveBrowserLike> {
  const { browsersPath, ensureBrowserInstalled } = await import("./playwright-runner.js");
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath();
  await ensureBrowserInstalled(browser);
  const pw = (await import("playwright")) as unknown as Record<RunBrowser, { launch(o: { headless: boolean }): Promise<LiveBrowserLike> }>;
  const type = pw[browser];
  if (!type) throw new Error("Unknown browser engine: " + browser);
  return type.launch({ headless: false });
}

function status(): LivePageStatus {
  if (!current) return { open: false, ...(closedReason ? { closedReason } : {}) };
  return { open: true, url: current.page.url(), browser: current.engine, picking };
}

function broadcast(extra: Partial<LivePageStatus> = {}): void {
  sendToMain("livePage:changed", { ...status(), ...extra });
}

/** Build Playwright's Locator for a model, through the generator's own
 *  spelling. Returns null when the model does not normalize. */
function locatorFor(page: LivePageLike, raw: unknown): { locator: { count(): Promise<number>; highlight(): Promise<void> }; expr: string } | null {
  const model = normalizeLocator(raw);
  if (!model) return null;
  const expr = "page." + locatorExpr(model);
  try {
    const built = new Function("page", "return " + expr + ";")(page) as {
      count(): Promise<number>;
      highlight(): Promise<void>;
    };
    return { locator: built, expr };
  } catch (err) {
    logger.warn("live-page", "Could not build a locator from the model", { expr, err: String(err) });
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(what + " took longer than " + ms + "ms")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const livePageService = {
  /** Test hook. */
  useLauncher(custom: LiveLauncher | null): void {
    launcher = custom;
  },

  status,

  /** Open (or re-point) the live page at `url`. One live page per app: a
   *  second open closes the first.
   *
   *  `testId` is what lets this page present the test's CREDENTIALS — the
   *  basic-auth answer and the Shopify crawler signature. It is optional
   *  because `check:live-page` opens a page with no test behind it, and
   *  because a live page without credentials is still a live page: a site that
   *  needs neither is unaffected either way. */
  async open(
    url: string,
    browser: RunBrowser = "chromium",
    testId?: string,
  ): Promise<LivePageStatus> {
    await this.close();
    closedReason = undefined;
    const launch = launcher ?? defaultLauncher;

    // ── The two credentials, resolved BEFORE the browser exists ──────
    //
    // `httpCredentials` is a context option, so it has to be known at creation;
    // resolving both here keeps the "what may this page present" decision in
    // one place rather than split across the launch.
    const httpCredentials = await liveCredentials(testId);

    // ── The Shopify crawler signature ────────────────────────────────
    //
    // TWO rules, the run's, deliberately (playwright-runner.ts makes the same
    // split for the same reason). Whether to ARM is narrow — only when the
    // address this page is opening at is itself registered — because enabling
    // routing disables the context's HTTP cache, and a machine with a signature
    // registered must not pay that on every unrelated live page. What gets
    // INSTALLED once armed is complete: every registered host, each scoped to
    // its own, so typing a second registered store into the browser's address
    // bar signs that too.
    //
    // Unlike the run, this is NOT gated on an imported test: the live page is
    // a browser the editor drives, not a spec the app rewrote, so the fixture's
    // "we cannot reach an imported spec" limit does not apply here.
    let entries: ShopifySignatureEntry[] = [];
    try {
      entries = await shopifySignatureStore.entries();
    } catch (err) {
      // A store that will not open is not a reason to refuse the page.
      logger.warn("live-page", "Could not read the Shopify signatures", { err: String(err) });
    }
    const openHost = normalizeSignatureHost(url);
    const signing = entries.some((entry) => entry.host === openHost);

    const b = await launch(browser);
    const context = await b.newContext(httpCredentials ? { httpCredentials } : {});
    if (signing) {
      signatureArmed = entries.map((entry) => entry.host);
      await installSignatureRoute(context, entries);
    }
    const page = await context.newPage();
    current = { browser: b, page, engine: browser };
    logger.info("live-page", "Credentials for this live page", {
      // Never a value: which credentials are ARMED, not what they are.
      basicAuth: !!httpCredentials,
      signatureArmed: signing ? signatureArmed : [],
      registeredHosts: entries.map((entry) => entry.host),
      openHost,
    });
    const onGone = (reason: string) => {
      if (!current || current.page !== page) return;
      current = null;
      picking = false;
      closedReason = reason;
      broadcast();
    };
    b.on("disconnected", () => onGone("The browser was closed."));
    page.on("close", () => onGone("The page was closed."));
    page.on("framenavigated", (frame) => {
      if (current && frame === page.mainFrame()) broadcast();
    });
    try {
      await page.goto(url);
    } catch (err) {
      // A page that would not load is still a live page — the user can type
      // another address in the browser. Said in the status, not thrown.
      logger.warn("live-page", "Initial navigation failed", { url, err: String(err) });
      broadcast({ closedReason: undefined });
      return { ...status(), title: "" };
    }
    let title = "";
    try {
      title = await page.title();
    } catch {
      title = "";
    }
    logger.info("live-page", "Opened", { url, browser });
    broadcast({ title });
    return { ...status(), title };
  },

  async close(): Promise<void> {
    const c = current;
    current = null;
    picking = false;
    // Before the early return, so a close with no page still clears a tally an
    // aborted open may have armed.
    reportSignatures();
    if (!c) return;
    try {
      await c.browser.close();
    } catch {
      /* already gone */
    }
    closedReason = undefined;
    broadcast();
  },

  /** How many elements each locator matches on the live page right now. */
  async countMany(locators: unknown[]): Promise<LivePageCount[]> {
    const c = current;
    if (!c) return locators.map(() => ({ count: null, error: "No live page." }));
    const out: LivePageCount[] = [];
    for (const raw of locators) {
      const built = locatorFor(c.page, raw);
      if (!built) {
        out.push({ count: null, error: "This locator could not be built." });
        continue;
      }
      try {
        out.push({ count: await withTimeout(built.locator.count(), LOCATOR_TIMEOUT_MS, "count") });
      } catch (err) {
        out.push({ count: null, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  },

  /** Outline the locator's matches in the live page; a model that builds
   *  nothing clears the outline. */
  async highlight(raw: unknown): Promise<void> {
    const c = current;
    if (!c) return;
    const built = raw ? locatorFor(c.page, raw) : null;
    try {
      if (built) await withTimeout(built.locator.highlight(), LOCATOR_TIMEOUT_MS, "highlight");
      else await withTimeout(c.page.locator("internal:attr=[data-gl-none=\"1\"]").highlight(), LOCATOR_TIMEOUT_MS, "clear");
    } catch (err) {
      logger.warn("live-page", "highlight failed", { err: String(err) });
    }
  },

  /** Wait for the user to click an element in the live page and answer with
   *  Playwright's locator for it. Resolves null when cancelled. */
  async pick(): Promise<LivePagePick | null> {
    const c = current;
    if (!c) throw new Error("No live page is open.");
    if (picking) throw new Error("Already picking — click an element in the live page, or cancel.");
    picking = true;
    broadcast();
    try {
      const picked = await c.page.pickLocator();
      const expr = String(picked);
      return { expr, locator: parseLocatorExpression(expr) };
    } catch (err) {
      // Cancelled, or the page went away mid-pick: either way nothing was
      // picked, and the editor is told so rather than handed an error box.
      logger.info("live-page", "pick ended without a locator", { err: String(err) });
      return null;
    } finally {
      picking = false;
      if (current === c) broadcast();
    }
  },

  async cancelPick(): Promise<void> {
    const c = current;
    if (!c || !picking) return;
    try {
      await c.page.cancelPickLocator();
    } catch {
      /* nothing to cancel */
    }
  },
};
