// The mailbox Worker, RUN rather than read.
//
// It lives under `workers/`, which matches neither vitest project, so a test
// beside it would be silently never run (CLAUDE.md, Testing). It is imported
// from here instead — the same argument `check:mcp-boot` makes: every other
// way of checking this file reads its source, and source-reading is what let
// the MCP server throw at module load for six months while its checks stayed
// green.
//
// Cloudflare's runtime is Web-standard for everything this Worker touches
// (Response, URL, TextDecoder, atob, crypto.randomUUID), all of which Node
// has. The KV binding is the only thing stubbed.

import { describe, expect, it } from "vitest";

import worker from "../../workers/mailbox/src/worker.mjs";

/** Enough of Cloudflare KV for this Worker: prefix list with metadata, get,
 *  put. Keys are held sorted, because the Worker's `since` filter and its
 *  "newest N" slice both assume KV's lexicographic order. */
function stubKv() {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  return {
    store,
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      store.set(key, { value, metadata: opts?.metadata });
    },
    async get(key: string, type?: string) {
      const hit = store.get(key);
      if (!hit) return null;
      return type === "json" ? JSON.parse(hit.value) : hit.value;
    },
    async list({ prefix }: { prefix: string }) {
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, v]) => ({ name, metadata: v.metadata }));
      return { keys };
    },
  };
}

const TOKEN = "test-token-0123456789";

function rawMessage(subject: string, body: string) {
  return ["From: Store <no-reply@shopify.com>", "Subject: " + subject, "", body].join("\r\n");
}

/** What Email Routing hands `email()`. */
function inbound(to: string, subject: string, body: string) {
  const raw = rawMessage(subject, body);
  return {
    to,
    from: "no-reply@shopify.com",
    rawSize: raw.length,
    raw: new TextEncoder().encode(raw),
  };
}

function get(url: string, token?: string) {
  return new Request(url, {
    headers: token === undefined ? {} : { authorization: "Bearer " + token },
  });
}

const ADDRESS = "shopper@mail.example.com";
const URL_BASE = "https://mailbox.example.workers.dev/messages";

describe("mailbox worker: fetch", () => {
  it("fails CLOSED when the token secret is missing", async () => {
    // A deploy that forgot the secret would otherwise be an unauthenticated
    // mailbox endpoint, and it would work perfectly.
    const res = await worker.fetch(get(URL_BASE + "?address=" + ADDRESS), { MAILBOX: stubKv() });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/MAILBOX_TOKEN/);
  });

  it("refuses a missing, wrong or malformed token", async () => {
    const env = { MAILBOX_TOKEN: TOKEN, MAILBOX: stubKv() };
    const url = URL_BASE + "?address=" + ADDRESS;
    expect((await worker.fetch(get(url), env)).status).toBe(401);
    expect((await worker.fetch(get(url, "wrong-token-012345678"), env)).status).toBe(401);
    expect((await worker.fetch(get(url, ""), env)).status).toBe(401);
    const bare = new Request(url, { headers: { authorization: TOKEN } });
    expect((await worker.fetch(bare, env)).status).toBe(401);
  });

  it("refuses anything but GET", async () => {
    const env = { MAILBOX_TOKEN: TOKEN, MAILBOX: stubKv() };
    const res = await worker.fetch(
      new Request(URL_BASE, { method: "POST", headers: { authorization: "Bearer " + TOKEN } }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("refuses an address that is not one", async () => {
    const env = { MAILBOX_TOKEN: TOKEN, MAILBOX: stubKv() };
    const res = await worker.fetch(get(URL_BASE + "?address=nonsense", TOKEN), env);
    expect(res.status).toBe(400);
  });

  it("returns what arrived, and only what beats `since`", async () => {
    const kv = stubKv();
    const env = { MAILBOX_TOKEN: TOKEN, MAILBOX: kv };
    await worker.email(inbound(ADDRESS, "111111 is your code", "old"), env);
    const between = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    await worker.email(inbound(ADDRESS, "222222 is your code", "new"), env);

    const all = await (await worker.fetch(get(URL_BASE + "?address=" + ADDRESS, TOKEN), env)).json();
    expect(all.messages.map((m: { subject: string }) => m.subject)).toEqual([
      "111111 is your code",
      "222222 is your code",
    ]);

    const after = await (
      await worker.fetch(get(URL_BASE + "?address=" + ADDRESS + "&since=" + between, TOKEN), env)
    ).json();
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0].subject).toBe("222222 is your code");
  });

  it("keeps one address's mail out of another's", async () => {
    const kv = stubKv();
    const env = { MAILBOX_TOKEN: TOKEN, MAILBOX: kv };
    await worker.email(inbound(ADDRESS, "111111 is your code", "x"), env);
    await worker.email(inbound("other@mail.example.com", "222222 is your code", "x"), env);
    const res = await (
      await worker.fetch(get(URL_BASE + "?address=" + ADDRESS, TOKEN), env)
    ).json();
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].subject).toBe("111111 is your code");
  });

  it("matches an address whatever case it is asked for in", async () => {
    const kv = stubKv();
    const env = { MAILBOX_TOKEN: TOKEN, MAILBOX: kv };
    await worker.email(inbound("Shopper@Mail.Example.com", "111111 is your code", "x"), env);
    const res = await (
      await worker.fetch(get(URL_BASE + "?address=SHOPPER@mail.example.COM", TOKEN), env)
    ).json();
    expect(res.messages).toHaveLength(1);
  });

  it("404s a path that is not /messages", async () => {
    const env = { MAILBOX_TOKEN: TOKEN, MAILBOX: stubKv() };
    const res = await worker.fetch(
      get("https://mailbox.example.workers.dev/dump?address=" + ADDRESS, TOKEN),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("mailbox worker: email", () => {
  it("stores the parsed message, not the raw one", async () => {
    const kv = stubKv();
    await worker.email(inbound(ADDRESS, "123456 is your code", "Body text here"), {
      MAILBOX: kv,
    });
    const [entry] = [...kv.store.values()];
    const record = JSON.parse(entry.value);
    expect(record).toMatchObject({ to: ADDRESS, subject: "123456 is your code" });
    expect(record.body).toContain("Body text here");
    expect(entry.value).not.toContain("Subject:");
  });

  it("keys on the ENVELOPE recipient, not the To: header", async () => {
    // A catch-all receives mail whose To: names something else entirely (a
    // Bcc, a mailing list). The address the test polls for is the one the
    // mail was delivered to.
    const kv = stubKv();
    const raw = [
      "From: Store <no-reply@shopify.com>",
      "To: list@example.org",
      "Subject: 123456 is your code",
      "",
      "body",
    ].join("\r\n");
    await worker.email(
      { to: ADDRESS, from: "no-reply@shopify.com", rawSize: raw.length, raw: new TextEncoder().encode(raw) },
      { MAILBOX: kv },
    );
    const record = JSON.parse([...kv.store.values()][0].value);
    expect(record.to).toBe(ADDRESS);
  });

  it("expires every entry rather than accumulating", async () => {
    const kv = stubKv();
    let ttl: number | undefined;
    const spy = {
      ...kv,
      async put(k: string, v: string, o?: { expirationTtl?: number; metadata?: unknown }) {
        ttl = o?.expirationTtl;
        return kv.put(k, v, o);
      },
    };
    await worker.email(inbound(ADDRESS, "123456 is your code", "x"), { MAILBOX: spy });
    expect(ttl).toBe(3600);
  });

  it("drops an oversized message instead of reading it", async () => {
    const kv = stubKv();
    const msg = inbound(ADDRESS, "123456 is your code", "x");
    await worker.email({ ...msg, rawSize: 5_000_000 }, { MAILBOX: kv });
    expect(kv.store.size).toBe(0);
  });

  it("never throws — a rejected handler BOUNCES the message", async () => {
    // A bounced login code is indistinguishable, from the test's side, from
    // one that was never sent.
    await expect(worker.email(inbound(ADDRESS, "x", "y"), {})).resolves.toBeUndefined();
    await expect(
      worker.email({ to: ADDRESS, raw: null } as never, { MAILBOX: stubKv() }),
    ).resolves.toBeUndefined();
  });
});
