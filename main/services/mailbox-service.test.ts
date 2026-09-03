// The Settings → Integrations Test button, and the three things about it that
// are not obvious from reading `probeMailbox`.
//
// It had no test at all until the probe was moved off the global `fetch` onto
// `appFetch` (2026-09-03), which is exactly the change that needed one: the
// swap is invisible in the outcome — both spellings return a `Response` — and
// what it changes is which network path the button reports on, plus two
// consequences the transport brings with it.
//
//   1. It goes through `appFetch`. Settings → Proxy reaches the app's own
//      requests only there, so a probe on the global fetch was reporting on a
//      path nothing else in the app uses.
//   2. The bound covers the WHOLE probe. `appFetch` awaits a proxy decision
//      before it touches the network, and an `AbortSignal` handed to the
//      request reaches neither the PAC evaluation nor the password decrypt.
//   3. A proxy failure says which one. undici reports every one of them as
//      `fetch failed`, and this module's whole purpose is separating causes
//      that otherwise look identical.
//
// `proxy-service` is mocked rather than driven: it needs Electron's session
// resolver, and what is being pinned here is that the probe ASKS through it.
// Its own decision logic has its own test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const appFetch = vi.fn();
const describeFetchError = vi.fn((err: unknown) =>
  err instanceof Error ? `${err.message} — described` : String(err),
);
const credentials = vi.fn();
const status = vi.fn();

vi.mock("./proxy-service.js", () => ({
  appFetch: (url: string, init?: RequestInit) => appFetch(url, init),
  describeFetchError: (err: unknown) => describeFetchError(err),
}));

vi.mock("./mailbox-store.js", () => ({
  mailboxStore: {
    credentials: () => credentials(),
    status: () => status(),
  },
}));

const ENDPOINT = "https://mailbox.example.workers.dev/messages";
const TOKEN = "GLPROBETOKEN-not-real";

let probeMailbox: typeof import("./mailbox-service.js").probeMailbox;

beforeEach(async () => {
  vi.clearAllMocks();
  credentials.mockResolvedValue({ endpoint: ENDPOINT, token: TOKEN });
  status.mockResolvedValue({ state: "configured" });
  ({ probeMailbox } = await import("./mailbox-service.js"));
});

afterEach(() => {
  vi.useRealTimers();
  // In the afterEach rather than at the end of the test that stubs it: a
  // failing assertion would otherwise leave the stub in place, and the next
  // test's "never touches the global fetch" would then be measuring this
  // one's leftovers.
  vi.unstubAllGlobals();
});

/** A `Response` with only what the probe reads. */
function answer(over: { status?: number; ok?: boolean; body?: unknown }): unknown {
  const code = over.status ?? 200;
  return {
    status: code,
    ok: over.ok ?? (code >= 200 && code < 300),
    json: async () => over.body,
  };
}

describe("the probe asks through appFetch", () => {
  it("never touches the global fetch, and carries the token as a bearer", async () => {
    // The global one is left alive and watched rather than removed: a probe
    // that reached for it would otherwise fail with a ReferenceError, which
    // reads as a broken module instead of a bypassed proxy setting.
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    appFetch.mockResolvedValue(answer({ body: [] }));

    const result = await probeMailbox();

    expect(result.ok).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(appFetch).toHaveBeenCalledTimes(1);
    const [url, init] = appFetch.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(ENDPOINT)).toBe(true);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("hands the request a signal, so an answer that never comes is still cut off", async () => {
    appFetch.mockResolvedValue(answer({ body: [] }));
    await probeMailbox();
    const [, init] = appFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });
});

describe("the bound covers the whole probe", () => {
  it("gives up on a call that never settles, whichever stage is stuck", async () => {
    // The regression this exists for: `appFetch` awaits a proxy DECISION
    // before the request — a PAC evaluation, or a safeStorage decrypt — and a
    // signal passed to the request reaches neither. A probe bounded only by
    // that signal hangs the Settings pane for as long as the decision does.
    // This `appFetch` never settles at all, which is that stage stuck.
    vi.useFakeTimers();
    appFetch.mockReturnValue(new Promise(() => {}));

    const pending = probeMailbox();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result).toEqual({ ok: false, detail: "No answer within 10s." });
  });

  it("aborts the request it started rather than leaving it running", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    appFetch.mockImplementation((_url: string, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return new Promise(() => {});
    });

    const pending = probeMailbox();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(seen?.aborted).toBe(true);
  });

  it("does not report a timeout for a call that answered in time", async () => {
    // The other direction, and the one a deadline gets wrong: a probe that
    // resolves must not be reported as timed out because a timer fired later.
    vi.useFakeTimers();
    appFetch.mockResolvedValue(answer({ body: { messages: [] } }));

    const pending = probeMailbox();
    await vi.advanceTimersByTimeAsync(30_000);

    expect((await pending).ok).toBe(true);
  });
});

describe("what each answer is reported as", () => {
  it.each([
    [401, /rejected the token/i],
    [403, /rejected the token/i],
    [503, /no token or KV binding/i],
    [404, /ends with \/messages/i],
    [500, /answered 500/i],
  ])("maps HTTP %i to something actionable", async (code, expected) => {
    appFetch.mockResolvedValue(answer({ status: code }));
    const result = await probeMailbox();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(expected);
  });

  it("accepts both shapes a message list arrives in", async () => {
    appFetch.mockResolvedValue(answer({ body: [] }));
    expect((await probeMailbox()).ok).toBe(true);
    appFetch.mockResolvedValue(answer({ body: { messages: [] } }));
    expect((await probeMailbox()).ok).toBe(true);
  });

  it("refuses a 200 that is not a message list", async () => {
    appFetch.mockResolvedValue(answer({ body: { hello: "world" } }));
    const result = await probeMailbox();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not with a message list/i);
  });

  it("says nothing is saved rather than asking the network", async () => {
    credentials.mockResolvedValue(null);
    status.mockResolvedValue({ state: "none" });
    const result = await probeMailbox();
    expect(result.detail).toMatch(/no mailbox is saved/i);
    expect(appFetch).not.toHaveBeenCalled();
  });

  it("distinguishes an unreadable token from an absent one", async () => {
    credentials.mockResolvedValue(null);
    status.mockResolvedValue({ state: "unreadable" });
    expect((await probeMailbox()).detail).toMatch(/could not be decrypted/i);
  });
});

describe("a network failure names its cause", () => {
  it("describes the error instead of printing undici's bare message", async () => {
    // "fetch failed" is what undici says for a refused CONNECT, a 407 and a
    // re-signing certificate alike. Reporting it verbatim sends someone to
    // re-paste a token that was never the problem.
    appFetch.mockRejectedValue(new Error("fetch failed"));

    const result = await probeMailbox();

    expect(result.ok).toBe(false);
    expect(describeFetchError).toHaveBeenCalledTimes(1);
    expect(result.detail).toBe("Could not reach the mailbox: fetch failed — described");
  });

  it("does not run a timeout through the describer — it already has a message", async () => {
    vi.useFakeTimers();
    appFetch.mockReturnValue(new Promise(() => {}));

    const pending = probeMailbox();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(describeFetchError).not.toHaveBeenCalled();
  });

  it("never throws — it backs a button", async () => {
    appFetch.mockRejectedValue("a string, not an Error");
    await expect(probeMailbox()).resolves.toMatchObject({ ok: false });
  });
});
