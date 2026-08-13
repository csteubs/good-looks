// The Linear provider's read half.
//
// The assertions that matter are not "it parses JSON". They are:
//
//   • THE KEY NEVER APPEARS IN AN ERROR. Every failure path is checked against
//     the key it was called with, because the way this leaks is not a
//     deliberate `${key}` — it is someone forwarding a caught error whose
//     message happens to carry the request, months from now.
//   • A 200 carrying a GraphQL `errors` array is an AUTH failure, not a parse
//     failure. Linear reports a bad key that way, and a status-code check alone
//     reads it as "unexpected response" — which sends someone off to debug
//     their network instead of their key.
//   • Remote lists are rebuilt, so a malformed row cannot reach a picker.

import { describe, it, expect, vi } from "vitest";

import { createLinearProvider, type FetchLike } from "./linear-provider.js";
import { IssueProviderError } from "./types.js";

const KEY = "lin_api_SUPERSECRETVALUE";

/** A fetch that answers once with the given body and status. */
function respondWith(body: unknown, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as FetchLike;
}

/** Run `fn` and return the error it threw. Fails loudly when it resolves —
 *  otherwise a provider that stopped throwing would pass every leak assertion
 *  below by never producing a message to check. */
async function errorFrom(fn: () => Promise<unknown>): Promise<IssueProviderError> {
  try {
    await fn();
  } catch (err) {
    return err as IssueProviderError;
  }
  throw new Error("expected a rejection, got a resolved value");
}

describe("verify", () => {
  it("reports the account and workspace", async () => {
    const provider = createLinearProvider(
      respondWith({ data: { viewer: { name: "Sam Rivera" }, organization: { name: "Northwind" } } }),
    );
    expect(await provider.verify(KEY)).toEqual({
      accountName: "Sam Rivera",
      workspaceName: "Northwind",
    });
  });

  it("sends the key raw, with no Bearer prefix", async () => {
    // Personal API keys go in `Authorization` unprefixed; OAuth tokens use
    // Bearer. Getting it wrong produces a 400 with an authentication message,
    // which reads as "your key is bad" and sends people off to regenerate a
    // perfectly good one.
    const fetchImpl = respondWith({ data: { viewer: { name: "Sam" }, organization: null } });
    await createLinearProvider(fetchImpl).verify(KEY);
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0][1];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(KEY);
    expect(headers.authorization).not.toMatch(/bearer/i);
  });

  it("falls back to a usable name rather than rendering undefined", async () => {
    const provider = createLinearProvider(respondWith({ data: { viewer: {}, organization: {} } }));
    const account = await provider.verify(KEY);
    expect(account.accountName).toBe("your Linear account");
    expect(account.workspaceName).toBeNull();
  });
});

describe("failures are readable, and never carry the key", () => {
  it("treats a 401 as an auth failure", async () => {
    const err = await errorFrom(() => createLinearProvider(respondWith({}, 401)).verify(KEY));
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/rejected the API key/i);
  });

  it("treats a 200 with a GraphQL auth error as an auth failure", async () => {
    // Linear's actual behaviour for a bad key, and the case a status-code check
    // alone gets wrong.
    const err = await errorFrom(() =>
      createLinearProvider(
        respondWith({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }),
      ).verify(KEY),
    );
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/rejected the API key/i);
  });

  it("separates rate limiting from a bad key", async () => {
    // Telling someone their key is wrong when they are merely being throttled
    // makes them revoke a working key. The message may still say "this key" —
    // it is the throttled thing — but it must not call it rejected or invalid.
    const err = await errorFrom(() => createLinearProvider(respondWith({}, 429)).verify(KEY));
    expect(err.kind).toBe("rate-limit");
    expect(err.message).toMatch(/rate-limiting/i);
    expect(err.message).not.toMatch(/rejected|invalid|revoked/i);
  });

  it("separates a server error from a bad key", async () => {
    const err = await errorFrom(() => createLinearProvider(respondWith({}, 503)).verify(KEY));
    expect(err.kind).toBe("server");
  });

  it("reports an unreachable network without forwarding the thrown error", async () => {
    // The thrown value is deliberately NOT forwarded: a fetch rejection can
    // carry the request, and the request carries the Authorization header.
    const hostile: FetchLike = async () => {
      throw new Error(`connect ECONNREFUSED while sending authorization: ${KEY}`);
    };
    const err = await errorFrom(() => createLinearProvider(hostile).verify(KEY));
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(KEY);
    expect(err.message).toMatch(/could not reach linear/i);
  });

  it("keeps the key out of EVERY failure path", async () => {
    // The blanket assertion. A new branch in the provider that interpolates
    // something it was handed fails here rather than in production.
    const cases: FetchLike[] = [
      respondWith({}, 401),
      respondWith({}, 429),
      respondWith({}, 503),
      respondWith({}, 418),
      respondWith({ errors: [{ message: `bad key ${KEY}` }] }),
      respondWith({ data: null }),
      // A body that is not JSON at all.
      (() =>
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error(`unexpected token, body was authorization: ${KEY}`);
          },
        })) as unknown as FetchLike)(),
      async () => {
        throw new Error(KEY);
      },
    ];
    for (const fetchImpl of cases) {
      const err = await errorFrom(() => createLinearProvider(fetchImpl).verify(KEY));
      expect(err.message).not.toContain(KEY);
      expect(err.message).not.toContain("lin_api_");
    }
  });

  it("bounds a remote-authored message rather than displaying it whole", async () => {
    const err = await errorFrom(() =>
      createLinearProvider(respondWith({ errors: [{ message: "x".repeat(5000) }] })).verify(KEY),
    );
    expect(err.message.length).toBeLessThan(400);
  });

  it("flattens a multi-line remote message onto one line", async () => {
    // A multi-line message in a toast pushes the rest of the interface around.
    const err = await errorFrom(() =>
      createLinearProvider(respondWith({ errors: [{ message: "line one\nline two" }] })).verify(KEY),
    );
    expect(err.message).not.toContain("\n");
  });
});

describe("remote lists are rebuilt, not trusted", () => {
  it("returns teams with their short key", async () => {
    const provider = createLinearProvider(
      respondWith({ data: { teams: { nodes: [{ id: "t1", name: "Engineering", key: "ENG" }] } } }),
    );
    expect(await provider.listContainers(KEY)).toEqual([
      { id: "t1", name: "Engineering", key: "ENG" },
    ]);
  });

  it("drops a team with no id or no name", async () => {
    // An id-less row would be sent back as `undefined` on the next create; a
    // nameless one is unselectable in a picker.
    const provider = createLinearProvider(
      respondWith({
        data: {
          teams: {
            nodes: [
              { id: "t1", name: "Engineering", key: "ENG" },
              { id: "", name: "No id", key: "X" },
              { id: "t3", name: "   ", key: "Y" },
              null,
              "not an object",
            ],
          },
        },
      }),
    );
    expect(await provider.listContainers(KEY)).toEqual([
      { id: "t1", name: "Engineering", key: "ENG" },
    ]);
  });

  it("reports a missing team key as null rather than inventing one", async () => {
    const provider = createLinearProvider(
      respondWith({ data: { teams: { nodes: [{ id: "t1", name: "Engineering" }] } } }),
    );
    expect((await provider.listContainers(KEY))[0].key).toBeNull();
  });

  it("survives a response with no list at all", async () => {
    const provider = createLinearProvider(respondWith({ data: {} }));
    expect(await provider.listContainers(KEY)).toEqual([]);
  });

  it("attributes a project to its team only when it belongs to exactly one", async () => {
    // A Linear project can span teams. Attributing a multi-team project to the
    // first one would hide it from every other team's picker.
    const provider = createLinearProvider(
      respondWith({
        data: {
          projects: {
            nodes: [
              { id: "p1", name: "One team", teams: { nodes: [{ id: "t1" }] } },
              { id: "p2", name: "Two teams", teams: { nodes: [{ id: "t1" }, { id: "t2" }] } },
              { id: "p3", name: "No teams", teams: { nodes: [] } },
            ],
          },
        },
      }),
    );
    expect(await provider.listSubContainers(KEY)).toEqual([
      { id: "p1", name: "One team", containerId: "t1" },
      { id: "p2", name: "Two teams", containerId: null },
      { id: "p3", name: "No teams", containerId: null },
    ]);
  });
});
