// The fixture's console/network recording, driven as the SHIPPED STRING.
//
// The `runAxe` idiom next door (`capture-fixture-a11y.dom.test.ts`), for the
// same reason: this code exists only as text written beside the specs, so a
// test that re-implemented it would verify something that never runs. What is
// worth executing here is not the helpers — `check:log-capture` already
// evaluates those — but the LISTENERS: which events they subscribe to, what
// one event produces, and what they do when a page cannot be named.
//
// The property that made this necessary is the one this file exists next to:
// recording is subscribed ONCE on the CONTEXT rather than per page, because a
// per-page subscription is not in force until after the page has already
// spoken (DECISIONS 2026-09-03). `check:log-capture` pins that shape by
// reading the source; `e2e/tab-follow.spec.ts` proves the behaviour against
// real Playwright. Neither of them can say what happens when `msg.page()`
// returns null, or when a `WebError` refuses to hand over its error — the
// cases the fixture wraps in `try`/`catch` precisely because they must never
// reach a run.

import { describe, expect, it } from "vitest";

import { captureFixtureSource } from "../../shared/capture-fixture-source.mjs";
import {
  LOG_CAPTURE_HELPERS,
  MAX_CONSOLE_HEAD,
  MAX_CONSOLE_TAIL,
  MAX_NETWORK_HEAD,
  MAX_NETWORK_TAIL,
} from "../../shared/log-capture-source.mjs";

/** Pull one top-level function out of the fixture source by name. Top-level
 *  declarations there close with a `}` in column 0, which is what bounds it. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} not found in the fixture source`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  expect(end, `${name} has no top-level close`).toBeGreaterThan(start);
  return src.slice(start, end + 2);
}

interface Entry {
  step: number;
  type?: string;
  text?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  failure?: string;
  method?: string;
  page?: number;
}
interface Store {
  head: Entry[];
  tail: Entry[];
  dropped: number;
}
interface Logs {
  console: Store;
  network: Store;
}
type Handler = (arg: unknown) => void;

/** A BrowserContext that only remembers what was subscribed to it. */
function fakeContext(): { on: (e: string, h: Handler) => void; fire: (e: string, arg: unknown) => void; events: string[] } {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return undefined as unknown as void;
    },
    fire(event, arg) {
      for (const h of handlers.get(event) ?? []) h(arg);
    },
    get events() {
      return [...handlers.keys()];
    },
  };
}

/** Compile the shipped installer with the fixture's module scope around it. */
function install(logs: Logs, step: number): ReturnType<typeof fakeContext> {
  const body = [
    LOG_CAPTURE_HELPERS,
    extractFunction(captureFixtureSource, "tabIndexOf"),
    extractFunction(captureFixtureSource, "onTab"),
    extractFunction(captureFixtureSource, "installLogCapture"),
    "return installLogCapture;",
  ].join("\n");
  const fn = new Function(
    "ctx",
    "ALL_HEADERS",
    "MAX_CONSOLE_HEAD",
    "MAX_CONSOLE_TAIL",
    "MAX_NETWORK_HEAD",
    "MAX_NETWORK_TAIL",
    body,
  )(
    { index: step },
    false,
    MAX_CONSOLE_HEAD,
    MAX_CONSOLE_TAIL,
    MAX_NETWORK_HEAD,
    MAX_NETWORK_TAIL,
  ) as (context: unknown, logs: Logs) => void;
  const context = fakeContext();
  fn(context, logs);
  return context;
}

function emptyLogs(): Logs {
  return {
    console: { head: [], tail: [], dropped: 0 },
    network: { head: [], tail: [], dropped: 0 },
  };
}

const consoleEntries = (logs: Logs): Entry[] => logs.console.head.concat(logs.console.tail);
const networkEntries = (logs: Logs): Entry[] => logs.network.head.concat(logs.network.tail);

/** A Playwright `Page` as the fixture reads one: a tab index and nothing else. */
const tab = (index?: number): object => (index === undefined ? {} : { __glTabIndex: index });

const consoleMessage = (text: string, page: object | null): object => ({
  type: () => "log",
  text: () => text,
  location: () => ({ url: "https://example.test/a.js?token=abc", lineNumber: 7 }),
  page: () => page,
});

const request = (url: string, page: object | null, throws = false): object => ({
  method: () => "GET",
  url: () => url,
  resourceType: () => "document",
  headers: () => ({ "content-type": "text/html" }),
  failure: () => ({ errorText: "net::ERR_FAILED" }),
  frame: () => {
    if (throws) throw new Error("Frame for this navigation request is not available");
    return page === null ? null : { page: () => page };
  },
});

const response = (req: object, status = 200): object => ({
  request: () => req,
  status: () => status,
  ok: () => status < 400,
  headers: () => ({ "cache-control": "no-store" }),
});

describe("the capture fixture's log listeners", () => {
  it("subscribes every event on the context and nothing per page", () => {
    const logs = emptyLogs();
    const context = install(logs, 0);
    expect(context.events.sort()).toEqual(
      ["console", "request", "requestfailed", "response", "weberror"].sort(),
    );
  });

  it("records one console entry per message, tagged with the tab that logged it", () => {
    const logs = emptyLogs();
    const context = install(logs, 3);
    context.fire("console", consoleMessage("hello", tab(1)));

    const entries = consoleEntries(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("hello");
    expect(entries[0].type).toBe("log");
    expect(entries[0].step, "the action index current at the time").toBe(3);
    expect(entries[0].page, "the tab it was logged from").toBe(1);
    // The URL goes through the same scrubbing every other recorded URL does.
    expect(entries[0].url).toContain("token=<omitted>");
  });

  it("records a message whose page cannot be named, without a tab and without throwing", () => {
    // A service worker's console message has no page. Recording it under the
    // first tab would be a claim; recording it untagged is the same "absent
    // means the tab the test started on" a pre-tabs log file has.
    const logs = emptyLogs();
    const context = install(logs, 0);
    expect(() => context.fire("console", consoleMessage("from a worker", null))).not.toThrow();
    const entries = consoleEntries(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0].page).toBeUndefined();
  });

  it("records an uncaught page error as type 'pageerror', which is what readers match on", () => {
    const logs = emptyLogs();
    const context = install(logs, 2);
    context.fire("weberror", {
      error: () => ({ stack: "Error: boom\n    at x" }),
      page: () => tab(2),
    });

    const entries = consoleEntries(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("pageerror");
    expect(entries[0].text).toContain("Error: boom");
    expect(entries[0].page).toBe(2);
  });

  it("swallows a page error it cannot read rather than failing the run", () => {
    const logs = emptyLogs();
    const context = install(logs, 0);
    expect(() =>
      context.fire("weberror", {
        error: () => {
          throw new Error("gone");
        },
        page: () => null,
      }),
    ).not.toThrow();
    expect(consoleEntries(logs)).toHaveLength(0);
  });

  it("records a response under the tab whose frame issued it", () => {
    const logs = emptyLogs();
    const context = install(logs, 1);
    const req = request("https://example.test/data?key=secret", tab(1));
    context.fire("request", req);
    context.fire("response", response(req));

    const entries = networkEntries(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(200);
    expect(entries[0].ok).toBe(true);
    expect(entries[0].method).toBe("GET");
    expect(entries[0].page).toBe(1);
    expect(entries[0].url).toContain("key=<omitted>");
  });

  it("does NOT record a request whose page cannot be named", () => {
    // A tab's own navigation request is issued before its frame exists, so
    // `frame()` throws. Filing it under the opener would say the second tab's
    // document was fetched by the first.
    const logs = emptyLogs();
    const context = install(logs, 0);
    const req = request("https://example.test/popup", null, true);
    context.fire("request", req);
    context.fire("response", response(req));
    expect(networkEntries(logs)).toHaveLength(0);
  });

  it("records a request that never got a response with no status at all", () => {
    const logs = emptyLogs();
    const context = install(logs, 0);
    const req = request("https://example.test/blocked", tab(0));
    context.fire("request", req);
    context.fire("requestfailed", req);

    const entries = networkEntries(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(0);
    expect(entries[0].ok).toBe(false);
    expect(entries[0].failure).toContain("ERR_FAILED");
    expect(entries[0].page, "the first tab carries no tab field").toBeUndefined();
  });
});
