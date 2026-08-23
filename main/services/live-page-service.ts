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

import type { Locator, RunBrowser } from "../recorder/types.js";
import { normalizeLocator } from "../recorder/types.js";
import { locatorExpr } from "./script-generator.js";
import { parseLocatorExpression } from "./spec-parser.js";
import { sendToMain } from "./app-window.js";

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

export interface LiveBrowserLike {
  newPage(): Promise<LivePageLike>;
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
   *  second open closes the first. */
  async open(url: string, browser: RunBrowser = "chromium"): Promise<LivePageStatus> {
    await this.close();
    closedReason = undefined;
    const launch = launcher ?? defaultLauncher;
    const b = await launch(browser);
    const page = await b.newPage();
    current = { browser: b, page, engine: browser };
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
