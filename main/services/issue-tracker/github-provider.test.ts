// The GitHub provider.
//
// It inherits `linear-provider.test.ts`'s central assertion — THE KEY NEVER
// APPEARS IN AN ERROR — and adds the three things that are specific to filing
// issues over REST rather than GraphQL:
//
//   • THE CONTAINER ID IS A URL PATH SEGMENT. Linear's ids are opaque and
//     travel in a GraphQL variable; here `owner/repo` is interpolated into the
//     route. It arrives from a remote list, is written to disk as a default and
//     comes back over IPC, so it is re-validated at the point of use — and that
//     validation is tested against values shaped to escape the path, because
//     this is the one place in the integration where a bad id addresses a
//     different endpoint rather than merely failing.
//   • A 403 IS TWO DIFFERENT ANSWERS. GitHub uses it for "rate limited" and for
//     "this token may not do that", and only the remaining-quota header
//     separates them. Reporting the wrong one sends the user to fix the wrong
//     thing — regenerating a working token because they were actually throttled.
//   • IMAGES ARE NOT SILENTLY DROPPED. GitHub has no upload API, so the body has
//     to say what did not come with it. An issue that quietly lost its evidence
//     looks complete, which is worse than one that says it has none.

import { describe, it, expect, vi } from "vitest";

import { createGithubProvider, type FetchLike } from "./github-provider.js";
import { IssueProviderError, type UploadImage } from "./types.js";

const KEY = "ghp_SUPERSECRETVALUE_LONG_ENOUGH";

/** A fetch that answers with the given body, status and headers. */
function respondWith(body: unknown, status = 200, headers: Record<string, string> = {}): FetchLike {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
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

function callsOf(fetchImpl: FetchLike): [string, RequestInit][] {
  return (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
}

function image(label: string): UploadImage {
  return {
    label,
    filename: `${label}.png`,
    bytes: Buffer.from([1, 2, 3]),
    contentType: "image/png",
  };
}

describe("verify", () => {
  it("reports the account, and no workspace", async () => {
    // Null rather than invented: a GitHub token is not scoped to one
    // organisation the way a Linear key is scoped to one workspace, and a
    // plausible-looking name here would be a claim the API never made.
    const provider = createGithubProvider(respondWith({ login: "srivera", name: "Sam Rivera" }));
    expect(await provider.verify(KEY)).toEqual({
      accountName: "Sam Rivera",
      workspaceName: null,
    });
  });

  it("falls back to the login, then to a usable phrase", async () => {
    expect((await createGithubProvider(respondWith({ login: "srivera" })).verify(KEY)).accountName).toBe(
      "srivera",
    );
    expect((await createGithubProvider(respondWith({})).verify(KEY)).accountName).toBe(
      "your GitHub account",
    );
  });

  it("sends a User-Agent", async () => {
    // GitHub answers 403 to every request without one, which maps onto "your
    // token is bad" and sends people off to regenerate a perfectly good token.
    const fetchImpl = respondWith({ login: "srivera" });
    await createGithubProvider(fetchImpl).verify(KEY);
    const headers = callsOf(fetchImpl)[0][1].headers as Record<string, string>;
    expect(headers["user-agent"]).toBeTruthy();
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("the container id is a path segment", () => {
  // Each of these would address something other than the repository it names.
  const hostile = [
    "acme/../../orgs/evil",
    "../etc/passwd",
    "acme/repo/../../user/repos",
    "acme",
    "acme/repo?x=1",
    "acme/repo#frag",
    "/acme/repo",
    "acme//repo",
    "acme/re po",
  ];

  for (const containerId of hostile) {
    it(`refuses ${JSON.stringify(containerId)} without making a request`, async () => {
      const fetchImpl = respondWith([]);
      const provider = createGithubProvider(fetchImpl);
      // Refused BEFORE the network, which is the property that matters: a
      // validator that rejected the response instead would already have sent
      // the token to whatever endpoint the traversal reached.
      await expect(provider.listLabels(KEY, containerId)).rejects.toBeInstanceOf(IssueProviderError);
      expect(callsOf(fetchImpl)).toHaveLength(0);
    });
  }

  it("accepts the shapes GitHub actually mints", async () => {
    const fetchImpl = respondWith([]);
    const provider = createGithubProvider(fetchImpl);
    await provider.listLabels(KEY, "csteubs/good-looks");
    await provider.listLabels(KEY, "acme/checkout-api");
    await provider.listLabels(KEY, "a-b/x.y_z-1");
    expect(callsOf(fetchImpl)).toHaveLength(3);
    expect(callsOf(fetchImpl)[0][0]).toContain("/repos/csteubs/good-looks/labels");
  });
});

describe("listing", () => {
  it("drops repositories that cannot receive an issue", async () => {
    // Each of these fails at SEND time otherwise — after someone has written a
    // report — which is the whole reason they are filtered at list time.
    const provider = createGithubProvider(
      respondWith([
        { full_name: "acme/ok", name: "ok", owner: { login: "acme" }, permissions: { push: true } },
        {
          full_name: "acme/readonly",
          name: "readonly",
          owner: { login: "acme" },
          permissions: { push: false },
        },
        {
          full_name: "acme/no-issues",
          name: "no-issues",
          owner: { login: "acme" },
          permissions: { push: true },
          has_issues: false,
        },
        {
          full_name: "acme/archived",
          name: "archived",
          owner: { login: "acme" },
          permissions: { push: true },
          archived: true,
        },
        // Disagrees with its own parts — not an id `repoPath` would accept back.
        { full_name: "evil/../x", name: "x", owner: { login: "acme" }, permissions: { push: true } },
        { name: "nameless-owner", owner: {}, permissions: { push: true } },
      ]),
    );
    expect(await provider.listContainers(KEY)).toEqual([
      { id: "acme/ok", name: "ok", key: "acme" },
    ]);
  });

  it("answers nothing for milestones and labels when no repository is chosen", async () => {
    // Not an error: "nothing selected yet" is a legitimate state the dialog
    // opens in. There is simply no cross-repository list to return.
    const fetchImpl = respondWith([]);
    const provider = createGithubProvider(fetchImpl);
    expect(await provider.listSubContainers(KEY, null)).toEqual([]);
    expect(await provider.listLabels(KEY, null)).toEqual([]);
    expect(callsOf(fetchImpl)).toHaveLength(0);
  });

  it("attributes a milestone to the repository it was read from", async () => {
    const provider = createGithubProvider(
      respondWith([
        { number: 1, title: "v2.0" },
        { number: 2, title: "Bug bash" },
        { title: "no number" },
        { number: 3 },
      ]),
    );
    // Never null, unlike a Linear project: a milestone belongs to exactly one
    // repository, and reporting it as unscoped would offer it under
    // repositories that would reject it.
    expect(await provider.listSubContainers(KEY, "acme/storefront")).toEqual([
      { id: "1", name: "v2.0", containerId: "acme/storefront" },
      { id: "2", name: "Bug bash", containerId: "acme/storefront" },
    ]);
  });

  it("uses the label NAME as its id", async () => {
    // GitHub's create endpoint takes names directly. Resolving them to the
    // numeric ids it also mints would be a round trip that buys nothing.
    const provider = createGithubProvider(
      respondWith([
        { id: 900, name: "bug", color: "d73a4a" },
        { id: 901, name: "a11y" },
        { id: 902 },
      ]),
    );
    expect(await provider.listLabels(KEY, "acme/storefront")).toEqual([
      { id: "bug", name: "bug", color: "#d73a4a" },
      { id: "a11y", name: "a11y", color: null },
    ]);
  });
});

describe("errors", () => {
  it("never carries the key", async () => {
    // The way this leaks is not a deliberate interpolation — it is someone
    // forwarding a caught error whose message happens to carry the request.
    for (const status of [401, 403, 404, 429, 500, 418]) {
      const err = await errorFrom(() =>
        createGithubProvider(respondWith({ message: KEY }, status)).verify(KEY),
      );
      expect(err.message).not.toContain(KEY);
    }
    const thrown = await errorFrom(() =>
      createGithubProvider(
        vi.fn(async () => {
          throw new Error(`connect ECONNREFUSED https://x@${KEY}.example.com`);
        }) as unknown as FetchLike,
      ).verify(KEY),
    );
    expect(thrown.message).not.toContain(KEY);
    expect(thrown.kind).toBe("network");
  });

  it("separates a throttled 403 from a forbidden one", async () => {
    // The two need opposite actions from the user, and only the header says
    // which is which.
    const throttled = await errorFrom(() =>
      createGithubProvider(respondWith({}, 403, { "x-ratelimit-remaining": "0" })).verify(KEY),
    );
    expect(throttled.kind).toBe("rate-limit");

    const forbidden = await errorFrom(() =>
      createGithubProvider(respondWith({}, 403, { "x-ratelimit-remaining": "4999" })).verify(KEY),
    );
    expect(forbidden.kind).toBe("auth");
    expect(forbidden.message).toMatch(/permission/i);
  });

  it("reports a 404 as something the token may not see", async () => {
    // Private repositories answer 404 rather than 403, so "no such thing" and
    // "not allowed" are indistinguishable — and the message must not assert
    // either one.
    const err = await errorFrom(() => createGithubProvider(respondWith({}, 404)).listContainers(KEY));
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/private/i);
  });
});

describe("creating", () => {
  const request = {
    title: "Step 4 looks different",
    body: "The button moved.",
    containerId: "acme/storefront",
    subContainerId: "7",
    labelIds: ["bug", "visual"],
    images: [] as UploadImage[],
  };

  it("sends names for labels and a number for the milestone", async () => {
    const fetchImpl = respondWith({ number: 101, html_url: "https://github.com/acme/storefront/issues/101" });
    await createGithubProvider(fetchImpl).createIssue(KEY, request);
    const [url, init] = callsOf(fetchImpl)[0];
    expect(url).toContain("/repos/acme/storefront/issues");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    // The milestone round-trips through disk and IPC as a string, and GitHub
    // rejects the whole request if it arrives as one.
    expect(sent.milestone).toBe(7);
    expect(sent.labels).toEqual(["bug", "visual"]);
  });

  it("drops a milestone that is not a number rather than failing the send", async () => {
    const fetchImpl = respondWith({ number: 101, html_url: "https://github.com/acme/storefront/issues/101" });
    await createGithubProvider(fetchImpl).createIssue(KEY, { ...request, subContainerId: "not-a-number" });
    const sent = JSON.parse(callsOf(fetchImpl)[0][1].body as string) as Record<string, unknown>;
    expect(sent.milestone).toBeUndefined();
  });

  it("returns an identifier that says WHICH repository", async () => {
    // `addComment` is later handed only this string, and `#42` on its own does
    // not say which repository it is the forty-second issue of.
    const provider = createGithubProvider(
      respondWith({ number: 101, html_url: "https://github.com/acme/storefront/issues/101" }),
    );
    expect(await provider.createIssue(KEY, request)).toEqual({
      id: "acme/storefront#101",
      identifier: "acme/storefront#101",
      url: "https://github.com/acme/storefront/issues/101",
    });
  });

  it("refuses a response with no issue in it", async () => {
    // Returning a half-built object would give the UI a link that goes nowhere.
    const err = await errorFrom(() =>
      createGithubProvider(respondWith({ number: 101 })).createIssue(KEY, request),
    );
    expect(err.kind).toBe("server");
  });

  it("says in the body which screenshots did not come with it", async () => {
    const fetchImpl = respondWith({ number: 101, html_url: "https://github.com/acme/storefront/issues/101" });
    await createGithubProvider(fetchImpl).createIssue(KEY, {
      ...request,
      images: [image("Baseline"), image("This run")],
    });
    const sent = JSON.parse(callsOf(fetchImpl)[0][1].body as string) as { body: string };
    expect(sent.body).toContain(request.body);
    expect(sent.body).toMatch(/could not be attached/i);
    expect(sent.body).toContain("Baseline");
    expect(sent.body).toContain("This run");
  });

  it("adds no note when there were no images", async () => {
    // The note is a warning, and a warning that appears on every issue is one
    // nobody reads on the issues it matters for.
    const fetchImpl = respondWith({ number: 101, html_url: "https://github.com/acme/storefront/issues/101" });
    await createGithubProvider(fetchImpl).createIssue(KEY, request);
    const sent = JSON.parse(callsOf(fetchImpl)[0][1].body as string) as { body: string };
    expect(sent.body).toBe(request.body);
  });

  it("never sends image bytes, since there is nowhere for them to go", async () => {
    const fetchImpl = respondWith({ number: 101, html_url: "https://github.com/acme/storefront/issues/101" });
    await createGithubProvider(fetchImpl).createIssue(KEY, { ...request, images: [image("Baseline")] });
    // One request, and no PUT to a storage host — the Linear shape would have
    // uploaded first. This is the assertion that would catch someone "fixing"
    // the gap by publishing screenshots to a gist without saying so.
    expect(callsOf(fetchImpl)).toHaveLength(1);
    expect(callsOf(fetchImpl)[0][1].body as string).not.toContain("AQID");
  });
});

describe("commenting", () => {
  it("routes by the repository carried in the id", async () => {
    const fetchImpl = respondWith({ id: 1 });
    await createGithubProvider(fetchImpl).addComment(KEY, "acme/storefront#101", "Seen again.", []);
    const [url, init] = callsOf(fetchImpl)[0];
    expect(url).toContain("/repos/acme/storefront/issues/101/comments");
    expect(JSON.parse(init.body as string)).toEqual({ body: "Seen again." });
  });

  it("names the screenshots it could not carry", async () => {
    const fetchImpl = respondWith({ id: 1 });
    await createGithubProvider(fetchImpl).addComment(KEY, "acme/storefront#101", "Seen again.", [
      image("This run"),
    ]);
    const sent = JSON.parse(callsOf(fetchImpl)[0][1].body as string) as { body: string };
    expect(sent.body).toMatch(/could not be attached/i);
  });

  for (const bad of ["101", "acme/storefront", "acme/storefront#abc", "acme/../x#1", "#1"]) {
    it(`refuses ${JSON.stringify(bad)} without making a request`, async () => {
      const fetchImpl = respondWith({ id: 1 });
      await expect(
        createGithubProvider(fetchImpl).addComment(KEY, bad, "Seen again.", []),
      ).rejects.toBeInstanceOf(IssueProviderError);
      expect(callsOf(fetchImpl)).toHaveLength(0);
    });
  }
});
