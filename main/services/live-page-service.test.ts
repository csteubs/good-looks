// The live page's contract against a fake browser: what opens, what the
// counts and picks answer, how it goes away. The real engine is driven by
// check:live-page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { livePageService, type LiveBrowserLike, type LivePageLike } from "./live-page-service.js";

type Handler = (...args: unknown[]) => void;

function fakeBrowser(opts: { counts?: Record<string, number>; pick?: string; gotoFails?: boolean } = {}) {
  const pageHandlers = new Map<string, Handler[]>();
  const browserHandlers = new Map<string, Handler[]>();
  const highlighted: string[] = [];
  const built: string[] = [];
  let url = "about:blank";
  let cancelled = false;
  const page: LivePageLike & { _fire(ev: string, ...a: unknown[]): void } = {
    async goto(u) {
      if (opts.gotoFails) throw new Error("net::ERR_NAME_NOT_RESOLVED");
      url = u;
    },
    url: () => url,
    title: async () => "Fake page",
    on(ev, h) {
      pageHandlers.set(ev, [...(pageHandlers.get(ev) ?? []), h]);
    },
    mainFrame: () => "MAIN",
    async pickLocator() {
      if (cancelled) throw new Error("cancelled");
      return { toString: () => opts.pick ?? "getByRole('button', { name: 'Sign in' })" };
    },
    async cancelPickLocator() {
      cancelled = true;
    },
    locator(sel) {
      built.push(sel);
      return { async highlight() { highlighted.push(sel); } };
    },
    async close() {},
    _fire(ev, ...a) {
      for (const h of pageHandlers.get(ev) ?? []) h(...a);
    },
  };
  // What the generated `page.getByTestId("x")` etc. resolve to on this fake.
  const bySelector = (key: string) => ({
    async count() {
      return opts.counts?.[key] ?? 1;
    },
    async highlight() {
      highlighted.push(key);
    },
    first: () => bySelector(key + ".first()"),
    nth: (n: number) => bySelector(key + `.nth(${n})`),
    filter: () => bySelector(key + ".filter()"),
  });
  Object.assign(page, {
    getByTestId: (v: string) => bySelector(`testid:${v}`),
    getByRole: (role: string, o?: { name?: string }) => bySelector(`role:${role}:${o?.name ?? ""}`),
    getByText: (v: string) => bySelector(`text:${v}`),
    getByLabel: (v: string) => bySelector(`label:${v}`),
  });
  const browser: LiveBrowserLike & { closed: boolean; _fire(ev: string): void } = {
    closed: false,
    async newPage() {
      return page;
    },
    async close() {
      this.closed = true;
    },
    on(ev, h) {
      browserHandlers.set(ev, [...(browserHandlers.get(ev) ?? []), h]);
    },
    _fire(ev) {
      for (const h of browserHandlers.get(ev) ?? []) h();
    },
  };
  return { browser, page, highlighted, built };
}

describe("livePageService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    await livePageService.close();
    livePageService.useLauncher(null);
  });

  it("opens at the address, reports the status, and closes the browser on close", async () => {
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    const st = await livePageService.open("https://example.com");
    expect(st).toMatchObject({ open: true, url: "https://example.com", browser: "chromium", title: "Fake page" });
    expect(livePageService.status().open).toBe(true);
    await livePageService.close();
    expect(f.browser.closed).toBe(true);
    expect(livePageService.status().open).toBe(false);
  });

  it("counts through the generator's own spelling of each locator model", async () => {
    const f = fakeBrowser({ counts: { "testid:go": 1, "role:button:": 3, "text:Gone": 0 } });
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://example.com");
    const counts = await livePageService.countMany([
      { k: "testid", v: "go" },
      { k: "role", role: "button" },
      { k: "text", v: "Gone" },
      { k: "nonsense" },
    ]);
    expect(counts).toEqual([{ count: 1 }, { count: 3 }, { count: 0 }, { count: null, error: "This locator could not be built." }]);
  });

  it("answers 'no live page' rather than throwing when nothing is open", async () => {
    const counts = await livePageService.countMany([{ k: "testid", v: "go" }]);
    expect(counts).toEqual([{ count: null, error: "No live page." }]);
    await expect(livePageService.pick()).rejects.toThrow(/No live page/);
  });

  it("highlights a model's matches, and clears with null", async () => {
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://example.com");
    await livePageService.highlight({ k: "testid", v: "go" });
    await livePageService.highlight(null);
    expect(f.highlighted[0]).toBe("testid:go");
    expect(f.built.some((s) => s.includes("data-gl-none"))).toBe(true);
  });

  it("hands back a pick as Playwright spells it AND as the app models it", async () => {
    const f = fakeBrowser({ pick: "getByRole('button', { name: 'Sign in' })" });
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://example.com");
    const picked = await livePageService.pick();
    expect(picked).toEqual({
      expr: "getByRole('button', { name: 'Sign in' })",
      locator: { k: "role", role: "button", name: "Sign in" },
    });
    expect(livePageService.status().picking).toBe(false);
  });

  it("keeps a pick the parser cannot read, with no model", async () => {
    const f = fakeBrowser({ pick: "locator('div').filter({ has: page.locator('x') })" });
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://example.com");
    const picked = await livePageService.pick();
    expect(picked?.expr).toContain("filter({ has:");
    expect(picked?.locator).toBeNull();
  });

  it("reports a browser the user closed, with the reason", async () => {
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://example.com");
    f.browser._fire("disconnected");
    expect(livePageService.status()).toEqual({ open: false, closedReason: "The browser was closed." });
  });

  it("stays open when the first navigation fails — the user can type another address", async () => {
    const f = fakeBrowser({ gotoFails: true });
    livePageService.useLauncher(async () => f.browser);
    const st = await livePageService.open("https://nowhere.invalid");
    expect(st.open).toBe(true);
  });
});
