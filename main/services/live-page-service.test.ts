// The live page's contract against a fake browser: what opens, what the
// counts and picks answer, how it goes away. The real engine is driven by
// check:live-page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  livePageService,
  type LiveBrowserLike,
  type LiveContextLike,
  type LiveContextOptions,
  type LivePageLike,
  type LiveRouteLike,
} from "./live-page-service.js";

// The three stores the service now reads to decide what this page may present.
// Mocked rather than driven off disk: what is under test is the DECISION (arm
// or not, scope or not), and a real store would make each case a filesystem
// setup instead of one line.
const signatureEntries: {
  id: string;
  host: string;
  signatureInput: string;
  signature: string;
  signatureAgent: string;
  expiresAt: number | null;
}[] = [];
let testRecord: Record<string, unknown> | null = null;
let testSecrets: Record<string, string> = {};

vi.mock("./shopify-signature-store.js", () => ({
  shopifySignatureStore: { entries: async () => signatureEntries },
}));
vi.mock("./test-store.js", () => ({
  testStore: { get: () => testRecord },
}));
vi.mock("./test-secrets-store.js", () => ({
  testSecretsStore: { valuesFor: async () => testSecrets },
}));

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
  // The context the service now creates. It records what it was OPENED with
  // (the basic-auth credential) and what was ROUTED on it (the signature), so a
  // test can assert on both without a real browser — the two things the live
  // page presents are exactly the two things this fake remembers.
  const routes: { predicate: (url: URL) => boolean; handler: (route: LiveRouteLike) => Promise<void> | void }[] = [];
  let contextOptions: LiveContextOptions | undefined;
  const context: LiveContextLike = {
    async newPage() {
      return page;
    },
    async route(predicate, handler) {
      routes.push({ predicate, handler });
    },
  };
  const browser: LiveBrowserLike & { closed: boolean; _fire(ev: string): void } = {
    closed: false,
    async newContext(options) {
      contextOptions = options;
      return context;
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

  /**
   * Drive one request through whatever route the service installed, and answer
   * with the headers it would have gone out with.
   *
   * Returns null when NO route matched — which is a different answer from "it
   * matched and added nothing", and the difference is the whole arm rule.
   */
  async function request(url: string, initial: Record<string, string> = { accept: "*/*" }) {
    let sent: Record<string, string> | null = null;
    let continued = false;
    const route: LiveRouteLike = {
      request: () => ({ url: () => url, allHeaders: async () => initial }),
      async continue(options) {
        continued = true;
        sent = options?.headers ?? initial;
      },
    };
    for (const r of routes) {
      if (!r.predicate(new URL(url))) continue;
      await r.handler(route);
      // Every path through the handler must continue the request, or the real
      // browser would hang it until the page timed out.
      if (!continued) throw new Error("the route handler did not continue the request");
      return sent;
    }
    return null;
  }

  return {
    browser,
    page,
    highlighted,
    built,
    request,
    routeCount: () => routes.length,
    contextOptions: () => contextOptions,
  };
}

describe("livePageService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    signatureEntries.length = 0;
    testRecord = null;
    testSecrets = {};
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
  // ── The credentials this page may present ──────────────────────────
  //
  // The live page is the app's THIRD surface that loads a customer's site (the
  // trainer and the run are the other two) and, until this change, the only one
  // that presented neither credential — so a password-protected Shopify
  // storefront served it the "Enter password" page and a basic-auth wall stopped
  // it at the door, while the same test's runs sailed through. Every assertion
  // below is about which requests carry what, because that is the only place
  // the difference is observable.

  const SIG = {
    id: "s1",
    host: "shop.example",
    signatureInput: 'sig1=("@authority");created=1;expires=4102444799;keyid="k";alg="ed25519"',
    signature: "sig1=:AAAA:",
    signatureAgent: '"https://shopify.com"',
    expiresAt: 4102444799,
  };

  it("signs requests to the registered host it opened at", async () => {
    signatureEntries.push(SIG);
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://shop.example/");

    const sent = await f.request("https://shop.example/collections");
    expect(sent, "the route matched and continued the request").not.toBeNull();
    expect(sent).toMatchObject({
      "signature-input": SIG.signatureInput,
      signature: SIG.signature,
      "signature-agent": SIG.signatureAgent,
    });
    // allHeaders() merged, not replaced: `continue({headers})` REPLACES the
    // header set, so a header the browser was already sending must survive.
    expect(sent).toMatchObject({ accept: "*/*" });
  });

  it("never offers the signature to another authority the page loads from", async () => {
    // The property the exact-host rule exists for. A storefront pulls from its
    // CDN, its analytics and whatever apps the merchant installed; a signature
    // presented at an authority it was not issued for is an INVALID signature
    // shown to a verifier whose job is spotting bot spoofing.
    signatureEntries.push(SIG);
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://shop.example/");

    // NULL, not "matched and added nothing": the predicate is the host test, so
    // a request to another authority is never intercepted at all — it goes
    // straight to the network with the browser's own headers. That is a
    // stronger guarantee than a handler that decides to add nothing, and it is
    // the same shape the run fixture's predicate has.
    expect(await f.request("https://cdn.shopify.com/asset.js")).toBeNull();
    // …while the registered host still is.
    expect(await f.request("https://shop.example/x")).toMatchObject({
      "signature-input": SIG.signatureInput,
    });
  });

  it("does not arm routing at all for an address with no signature", async () => {
    // The ARM rule, and it is not fussiness: routing disables the context's
    // HTTP cache, so a machine with any signature registered would otherwise
    // pay that on every unrelated live page it ever opens.
    signatureEntries.push(SIG);
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://unrelated.example/");
    expect(f.routeCount()).toBe(0);
    expect(await f.request("https://shop.example/")).toBeNull();
  });

  it("signs a SECOND registered store once armed", async () => {
    // Two rules, deliberately, matching the run: arming is decided by the
    // address opened at, but what is installed covers every registered host —
    // so typing another registered store into the address bar signs it too.
    signatureEntries.push(SIG, { ...SIG, id: "s2", host: "other.example" });
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://shop.example/");
    const sent = await f.request("https://other.example/x");
    expect(sent).toMatchObject({ "signature-input": SIG.signatureInput });
  });

  it("answers the test's basic-auth wall, scoped to the test's own origin", async () => {
    testRecord = {
      id: "t1",
      url: "https://walled.example/start",
      basicAuth: { username: "admin", passwordVar: "wallPw" },
    };
    testSecrets = { wallPw: "s3cret" };
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://walled.example/start", "chromium", "t1");

    expect(f.contextOptions()?.httpCredentials).toEqual({
      username: "admin",
      password: "s3cret",
      // The scope is the whole point: without an origin Playwright answers ANY
      // server's 401, so a third-party subresource would receive the password.
      origin: "https://walled.example",
    });
  });

  it("presents no credential when the page is opened without a test", async () => {
    // check:live-page opens one this way, and so would any future caller — a
    // page with no test behind it has no credentials to present.
    testRecord = { id: "t1", url: "https://walled.example/", basicAuth: { username: "a", passwordVar: "p" } };
    testSecrets = { p: "x" };
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://walled.example/");
    expect(f.contextOptions()?.httpCredentials).toBeUndefined();
  });

  it("presents no credential for a test that has no basic auth", async () => {
    testRecord = { id: "t1", url: "https://plain.example/" };
    const f = fakeBrowser();
    livePageService.useLauncher(async () => f.browser);
    await livePageService.open("https://plain.example/", "chromium", "t1");
    expect(f.contextOptions()?.httpCredentials).toBeUndefined();
  });
});
