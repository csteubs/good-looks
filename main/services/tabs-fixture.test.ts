// The tab-following fixture, executed from the SHIPPED STRING against a fake
// context — the laptop-speed half of e2e/tab-follow.spec.ts.
//
// What real Playwright alone can prove (that its page matchers bind once,
// that a `_blank` anchor's page arrives after the click resolves) lives in
// the e2e spec. What can be proved here in a second is the fixture's own
// bookkeeping, which is where the spike's bugs were: which page is active
// after an open and a close, that a recipe materializes on the page that is
// active WHEN IT ACTS, that an assertion resolves its receiver at call time
// and announces its own step, that the intent signal makes the next step
// wait, and that a page closing underneath a step costs one retry and not the
// run.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import {
  FOLLOW_TABS_ENV,
  TAB_INTENT_BINDING,
  TAB_OPENED_LINE,
  tabsFixtureSource,
} from "../../shared/tabs-fixture-source.mjs";
import { splitStepMarkers } from "../../shared/step-marker.mjs";

type Listener = (...args: unknown[]) => void;

/** Enough of a BrowserContext: pages, events, the binding and the init script. */
class FakeContext {
  pagesList: FakePage[] = [];
  listeners = new Map<string, Set<Listener>>();
  bindings = new Map<string, Listener>();
  initScripts: string[] = [];
  pages(): FakePage[] {
    return this.pagesList.filter((p) => !p.closed);
  }
  on(event: string, cb: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  async exposeBinding(name: string, cb: Listener): Promise<void> {
    this.bindings.set(name, cb);
  }
  async addInitScript(src: string): Promise<void> {
    this.initScripts.push(src);
  }
  waitForEvent(event: string, opts: { timeout: number }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), opts.timeout);
      const cb: Listener = (...args) => {
        clearTimeout(timer);
        this.listeners.get(event)!.delete(cb);
        resolve(args[0]);
      };
      this.on(event, cb);
    });
  }
  /** The page's side of the signal: what the init script does on a click. */
  signalIntent(): void {
    this.bindings.get(TAB_INTENT_BINDING)?.();
  }
  open(name: string): FakePage {
    const p = new FakePage(this, name);
    this.pagesList.push(p);
    this.emit("page", p);
    return p;
  }
}

/** A real object graph with a shared locator PROTOTYPE, like Playwright's. */
class FakeLocator {
  constructor(
    public owner: FakePage,
    public chain: string,
  ) {}
  page(): FakePage {
    return this.owner;
  }
  filter(o: { hasText?: string; has?: FakeLocator }): FakeLocator {
    return new FakeLocator(this.owner, `${this.chain}.filter(${o.hasText ?? (o.has ? "has:" + o.has.chain : "")})`);
  }
  nth(n: number): FakeLocator {
    return new FakeLocator(this.owner, `${this.chain}.nth(${n})`);
  }
  and(other: FakeLocator): FakeLocator {
    return new FakeLocator(this.owner, `${this.chain}&${other.chain}`);
  }
  async click(): Promise<string> {
    // A page told to close on its next action does so mid-call and fails the
    // way Playwright fails, which is the shape the retry exists for.
    if (this.owner.closeOnNextAction) {
      this.owner.closeOnNextAction = false;
      this.owner.close();
    }
    if (this.owner.closed) throw new Error("Target page, context or browser has been closed");
    this.owner.performed.push(`click ${this.chain}`);
    return `${this.owner.name}:${this.chain}`;
  }
  toString(): string {
    return this.chain;
  }
}

class FakePage {
  closed = false;
  closeOnNextAction = false;
  performed: string[] = [];
  listeners = new Map<string, Set<Listener>>();
  loadResolved = true;
  constructor(
    public ctx: FakeContext,
    public name: string,
  ) {}
  context(): FakeContext {
    return this.ctx;
  }
  isClosed(): boolean {
    return this.closed;
  }
  url(): string {
    return `http://x/${this.name}`;
  }
  on(event: string, cb: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }
  close(): void {
    this.closed = true;
    for (const cb of this.listeners.get("close") ?? []) cb();
  }
  async waitForLoadState(): Promise<void> {
    /* immediate; the e2e spec covers a real load */
  }
  getByRole(role: string, o?: { name?: string }): FakeLocator {
    return new FakeLocator(this, `${role}[${o?.name ?? ""}]`);
  }
  locator(sel: string): FakeLocator {
    return new FakeLocator(this, sel);
  }
  async goto(u: string): Promise<string> {
    if (this.closed) throw new Error("Target page, context or browser has been closed");
    this.performed.push(`goto ${u}`);
    return `${this.name}:goto`;
  }
  async title(): Promise<string> {
    return `title of ${this.name}`;
  }
  keyboard = {
    press: async (k: string): Promise<string> => {
      this.performed.push(`press ${k}`);
      return `${this.name}:press`;
    },
  };
}

interface Fixture {
  installTabFollowing(page: unknown, opts: unknown): Promise<unknown>;
  followingExpect(base: unknown): unknown;
  settleTabs(): Promise<void>;
  activePage(): unknown;
  tabsOpened(): number;
}

let dir: string;
let fixture: Fixture;
let stdout: string[];
let stderr: string[];

beforeAll(async () => {
  process.env[FOLLOW_TABS_ENV] = "1";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-tabs-fixture-"));
  const file = path.join(dir, "glaze-tabs.mjs");
  fs.writeFileSync(file, tabsFixtureSource);
  fixture = (await import(pathToFileURL(file).href)) as Fixture;
});

afterAll(() => {
  delete process.env[FOLLOW_TABS_ENV];
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

async function setup(perPage?: (p: FakePage) => void) {
  const ctx = new FakeContext();
  const first = new FakePage(ctx, "first");
  ctx.pagesList.push(first);
  const announced: string[] = [];
  const announce = {
    begin: (title: string) => {
      announced.push(`begin:${title}`);
      return { line: 7, title };
    },
    end: (a: { title: string }, ok: boolean) => {
      announced.push(`end:${a.title}:${ok}`);
    },
  };
  const page = (await fixture.installTabFollowing(first, { perPage, attempt: 0, announce })) as FakePage;
  return { ctx, first, page, announced };
}

const tabMarkers = () => splitStepMarkers("", stdout.join("")).tabs;

describe("which page is active", () => {
  it("starts on the first page and installs the intent signal on the context", async () => {
    const { ctx, first, page } = await setup();
    expect(fixture.activePage()).toBe(first);
    expect(page.url()).toBe("http://x/first");
    expect(ctx.bindings.has(TAB_INTENT_BINDING)).toBe(true);
    expect(ctx.initScripts).toHaveLength(1);
    expect(ctx.initScripts[0]).toContain("window.open");
  });

  it("follows a page the context opens, announces it, and runs the per-page install", async () => {
    const installed: string[] = [];
    const { ctx, page } = await setup((p) => installed.push(p.name));
    const second = ctx.open("second");
    expect(fixture.activePage()).toBe(second);
    expect(page.url()).toBe("http://x/second");
    expect(installed).toEqual(["second"]);
    // The marker the runner turns into the Step details row, with the count
    // of open tabs; and the line the log shows.
    expect(tabMarkers()).toEqual([{ event: "tab", count: 2, attempt: 0 }]);
    expect(stderr.join("")).toContain(`${TAB_OPENED_LINE} (#2)`);
    expect(fixture.tabsOpened()).toBe(1);
    // Later pages carry their index, which the capture fixture writes into
    // a manifest entry; the first carries 0 and is written as nothing.
    expect((second as unknown as { __glTabIndex: number }).__glTabIndex).toBe(1);
  });

  it("falls back to the previous open page when the active one closes", async () => {
    const { ctx, first, page } = await setup();
    const second = ctx.open("second");
    const third = ctx.open("third");
    expect(fixture.activePage()).toBe(third);
    third.close();
    expect(fixture.activePage()).toBe(second);
    second.close();
    expect(fixture.activePage()).toBe(first);
    expect(page.url()).toBe("http://x/first");
    // A close is a log line only — the requirement names one row.
    expect(tabMarkers().map((t) => t.count)).toEqual([2, 3]);
  });

  it("closing a page that is not active changes nothing", async () => {
    const { ctx } = await setup();
    const second = ctx.open("second");
    const third = ctx.open("third");
    second.close();
    expect(fixture.activePage()).toBe(third);
  });
});

describe("locators materialize when they act", () => {
  it("builds the recipe on the page that is active at ACTION time, not at creation", async () => {
    const { ctx, first, page } = await setup();
    const loc = page.getByRole("button", { name: "OK" });
    // Built while the first page was active…
    const second = ctx.open("second");
    // …and acting after the tab opened runs on the second.
    expect(await (loc as unknown as FakeLocator).click()).toBe("second:button[OK]");
    expect(second.performed).toEqual(["click button[OK]"]);
    expect(first.performed).toEqual([]);
  });

  it("keeps a chain of refiners and materializes nested locators on the same page", async () => {
    const { ctx, page } = await setup();
    ctx.open("second");
    const loc = page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "x" }) })
      .nth(2)
      .and(page.locator("#y"));
    expect(await (loc as unknown as FakeLocator).click()).toBe("second:row[].filter(has:cell[x]).nth(2)&#y");
  });

  it("is not a thenable, so awaiting a locator does not hang", async () => {
    const { page } = await setup();
    const loc = page.getByRole("button");
    expect((loc as unknown as { then: unknown }).then).toBeUndefined();
    const same = await loc;
    expect(String(same)).toBe("button[]");
  });

  it("retries once on the page that replaced one that closed underneath the action", async () => {
    const { ctx, first, page } = await setup();
    const popup = ctx.open("popup");
    const loc = page.getByRole("button", { name: "Back" });
    // The popup closes while the click is bound to it: the fake throws the
    // way Playwright does, and the retry lands on the opener.
    popup.closeOnNextAction = true;
    expect(await (loc as unknown as FakeLocator).click()).toBe("first:button[Back]");
    expect(popup.performed).toEqual([]);
    expect(first.performed).toEqual(["click button[Back]"]);
  });

  it("does NOT retry a failure on a page that is still open", async () => {
    const { ctx, page } = await setup();
    const p = ctx.open("second");
    p.performed = [];
    const bad = page.locator("#missing") as unknown as FakeLocator;
    const proto = FakeLocator.prototype as unknown as { click: () => Promise<unknown> };
    const original = proto.click;
    proto.click = async function (this: FakeLocator) {
      throw new Error("Timeout 30000ms exceeded waiting for locator");
    };
    try {
      await expect(bad.click()).rejects.toThrow(/Timeout/);
    } finally {
      proto.click = original;
    }
  });
});

describe("page methods", () => {
  it("gate on the active page and bind the rest as-is", async () => {
    const { ctx, page } = await setup();
    const second = ctx.open("second");
    expect(await page.goto("http://x/next")).toBe("second:goto");
    expect(second.performed).toEqual(["goto http://x/next"]);
    expect(await page.keyboard.press("Enter")).toBe("second:press");
    expect(second.performed).toContain("press Enter");
    expect(page.context()).toBe(ctx);
    expect(page.isClosed()).toBe(false);
  });
});

describe("the intent signal", () => {
  it("makes the next action wait for the tab the page said is coming", async () => {
    const { ctx, page } = await setup();
    // The page reported a click on a _blank link; the browser has not created
    // the tab yet (an anchor's arrives after the click resolves).
    ctx.signalIntent();
    const loc = page.getByRole("heading");
    let resolved = false;
    const clicking = (loc as unknown as FakeLocator).click().then((r) => {
      resolved = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    const second = ctx.open("second");
    expect(await clicking).toBe("second:heading[]");
    expect(second.performed).toEqual(["click heading[]"]);
  });

  it("gives up waiting after the arrival timeout rather than hanging the run", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, page } = await setup();
      ctx.signalIntent();
      const clicking = (page.getByRole("heading") as unknown as FakeLocator).click();
      await vi.advanceTimersByTimeAsync(6000);
      expect(await clicking).toBe("first:heading[]");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("expect", () => {
  interface Call {
    receiver: unknown;
    matcher: string;
    args: unknown[];
    mods: string[];
  }
  function fakeExpect() {
    const calls: Call[] = [];
    const chain = (receiver: unknown, mods: string[]): Record<string, unknown> =>
      new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "not") return chain(receiver, [...mods, "not"]);
            return async (...args: unknown[]) => {
              calls.push({ receiver, matcher: prop, args, mods });
              const r = receiver as FakePage | FakeLocator;
              const pg = (r as FakeLocator).owner ?? (r as FakePage);
              if (pg.closeOnNextAction) {
                pg.closeOnNextAction = false;
                pg.close();
              }
              if (pg.closed) throw new Error("Target page, context or browser has been closed");
              return "ok";
            };
          },
        },
      );
    const base = ((receiver: unknown) => chain(receiver, [])) as unknown as {
      (r: unknown): unknown;
      soft: (r: unknown) => unknown;
      poll: (fn: unknown) => unknown;
    };
    base.soft = (r: unknown) => chain(r, ["soft"]);
    base.poll = () => "poll";
    return { base, calls };
  }

  it("resolves the page proxy to the ACTIVE page at call time, and announces the step", async () => {
    const { ctx, page, announced } = await setup();
    const { base, calls } = fakeExpect();
    const wrapped = fixture.followingExpect(base) as (r: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>;
    const second = ctx.open("second");
    await wrapped(page).toHaveURL(/help/);
    expect(calls).toHaveLength(1);
    expect(calls[0].receiver).toBe(second);
    expect(calls[0].matcher).toBe("toHaveURL");
    expect(announced).toEqual(["begin:toHaveURL", "end:toHaveURL:true"]);
  });

  it("materializes a locator receiver on the active page, carrying .not and .soft", async () => {
    const { ctx, page } = await setup();
    const { base, calls } = fakeExpect();
    const wrapped = fixture.followingExpect(base) as {
      (r: unknown): Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>;
      soft: (r: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>;
      poll: (fn: unknown) => unknown;
    };
    const second = ctx.open("second");
    await wrapped(page.getByRole("heading")).not.toHaveText("Home");
    await wrapped.soft(page.locator("#x")).toBeVisible();
    expect(calls.map((c) => `${(c.receiver as FakeLocator).owner.name}:${c.matcher}:${c.mods.join("+")}`)).toEqual([
      "second:toHaveText:not",
      "second:toBeVisible:soft",
    ]);
    expect((calls[0].receiver as FakeLocator).owner).toBe(second);
    // Everything else on the function is Playwright's own.
    expect(wrapped.poll(() => 1)).toBe("poll");
  });

  it("leaves a receiver that is not one of its proxies to Playwright untouched", async () => {
    await setup();
    const { base, calls } = fakeExpect();
    const wrapped = fixture.followingExpect(base) as (r: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>;
    await wrapped(42).toBe(42);
    expect(calls[0].receiver).toBe(42);
  });

  it("retries once on the new active page when the bound page closed, and reports a real failure as failed", async () => {
    const { ctx, first, page, announced } = await setup();
    const { base, calls } = fakeExpect();
    const wrapped = fixture.followingExpect(base) as (r: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>;
    const popup = ctx.open("popup");
    popup.closeOnNextAction = true;
    expect(await wrapped(page).toHaveTitle("Home")).toBe("ok");
    expect(calls.map((c) => (c.receiver as FakePage).name)).toEqual(["popup", "first"]);
    expect(fixture.activePage()).toBe(first);
    expect(announced).toEqual(["begin:toHaveTitle", "end:toHaveTitle:true"]);

    // A failure with the page still open is the test's own, and the step is
    // announced as failed before it is rethrown.
    announced.length = 0;
    const failing = fixture.followingExpect((() => ({
      toHaveTitle: async () => {
        throw new Error("expected Home, received Help");
      },
    })) as unknown) as (r: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(failing(page).toHaveTitle("Home")).rejects.toThrow(/received Help/);
    expect(announced).toEqual(["begin:toHaveTitle", "end:toHaveTitle:false"]);
  });
});
