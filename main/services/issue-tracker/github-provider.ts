// GitHub Issues, behind the provider-neutral interface.
//
// It inherits the three constraints `linear-provider.ts` states, for the same
// reasons, and they are not restated here: no error may carry the key, the key
// is a parameter rather than state, and remote text is bounded before it is
// displayed. What follows is only what differs.
//
// ── The container id is a PATH SEGMENT ────────────────────────────────────
// Linear's ids are opaque UUIDs that travel in a GraphQL variable. GitHub's
// container id is `owner/repo`, and it is interpolated into a REST URL — so it
// is the one id in this integration that is also a route. It arrives from a
// remote list, is written to disk as a default, comes back over IPC as a
// destination, and only then becomes a URL. `repoPath` re-validates it at the
// point of use rather than trusting any of those hops, because a value shaped
// like `a/../../orgs/x` would otherwise address a different endpoint entirely.
//
// ── There is no image upload, and that is not a TODO ──────────────────────
// GitHub's issue-attachment upload is a browser-only endpoint behind session
// auth; the REST API has no counterpart, and the documented alternatives all
// mean publishing the bytes somewhere else (a gist, a release asset, a branch).
// Every one of those turns "file an issue" into "publish a screenshot of the
// app under test to a URL anyone can fetch", which is a decision a user has to
// make deliberately and not a default this provider may take on their behalf.
// So it declares `supportsImageUpload: false`, the dialog warns BEFORE the send,
// and the issue body names what was left out. An issue that silently lost its
// evidence is worse than one that says it has none: it looks complete.
//
// ── GitHub requires a User-Agent ──────────────────────────────────────────
// Without one the API answers 403 for every request, which maps onto "your
// token is bad" and sends people off to regenerate a perfectly good token.

import { logger } from "@shell/backend";

import { appFetch } from "../proxy-service.js";

import {
  IssueProviderError,
  type CreatedIssue,
  type CreateIssueRequest,
  type IssueContainer,
  type IssueLabel,
  type IssueProvider,
  type IssueSubContainer,
  type ProviderAccount,
  type ProviderVocabulary,
  type UploadImage,
} from "./types.js";

const API_ROOT = "https://api.github.com";

/** Matches `linear-provider.ts`: long enough for a slow network, short enough
 *  that "Test connection" cannot appear to hang. */
const TIMEOUT_MS = 15_000;

/** GitHub's maximum. */
const PAGE_SIZE = 100;

/** Repository lists page, and an account can be on thousands. Bounded so a
 *  settings pane cannot spend a minute enumerating them; sorted by most
 *  recently pushed so the bound falls on repositories nobody is filing against. */
const MAX_REPO_PAGES = 5;

/** Injectable for tests. The real one is the global. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const VOCABULARY: ProviderVocabulary = {
  name: "GitHub",
  container: "Repository",
  containerPlural: "Repositories",
  subContainer: "Milestone",
  keyHelpUrl: "https://github.com/settings/tokens",
  keyPlaceholder: "ghp_… or github_pat_…",
  supportsImageUpload: false,
};

// NOTE: there is deliberately no `displayable`/`scrubKey` pair here, unlike
// `linear-provider.ts`. GitHub's error bodies carry a `message`, and none of it
// is shown: every message below is written from a status code alone. Linear
// needs the remote text because it reports authentication failures as a 200
// with an `errors` array, so the status code genuinely does not say what
// happened; GitHub's status codes do. Not displaying remote text at all is the
// stronger position, and it is available here — so it is taken.

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** GitHub numbers milestones and issues. Rebuilt as a bounded integer because
 *  it goes back out in a URL and in a JSON body. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/**
 * A container id, re-validated as the `owner/repo` it claims to be.
 *
 * Deliberately strict rather than merely escaped: the value becomes a URL path,
 * and the set of characters GitHub actually allows in an owner or repository
 * name is exactly this one. Rejecting is safe — the id came from a list this
 * provider itself produced, so anything failing here did not.
 */
function repoPath(containerId: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/.exec(
    containerId,
  );
  if (!match || match[2] === "." || match[2] === "..") {
    throw new IssueProviderError(
      "unknown",
      "That repository name is not one this app can file into. Pick a repository from the list.",
    );
  }
  return { owner: match[1], repo: match[2] };
}

/** Map a transport status onto the kinds a caller branches on. */
function errorForStatus(status: number, rateLimited: boolean): IssueProviderError {
  if (status === 401) {
    return new IssueProviderError(
      "auth",
      "GitHub rejected the token. Check that it was copied whole and has not expired.",
    );
  }
  if (status === 403) {
    // A 403 is GitHub's answer to both "rate limited" and "this token may not
    // do that", and the remaining-quota header is the only reliable way to tell
    // them apart. Reporting the wrong one sends the user to fix the wrong thing.
    return rateLimited
      ? new IssueProviderError("rate-limit", "GitHub is rate-limiting this token. Try again shortly.")
      : new IssueProviderError(
          "auth",
          "GitHub refused this token. It likely lacks the Issues write permission for that repository.",
        );
  }
  if (status === 404) {
    // Private repositories answer 404 rather than 403 to callers who cannot see
    // them, so "no such thing" and "not allowed" are indistinguishable here.
    // The message has to cover both without asserting either.
    return new IssueProviderError(
      "auth",
      "GitHub could not find that repository, or this token cannot see it. Private repositories need a token with access to them.",
    );
  }
  if (status === 429) {
    return new IssueProviderError("rate-limit", "GitHub is rate-limiting this token. Try again shortly.");
  }
  if (status >= 500) {
    return new IssueProviderError("server", `GitHub returned a server error (${status}).`);
  }
  return new IssueProviderError("unknown", `GitHub returned an unexpected response (${status}).`);
}

/**
 * The one place a request reaches GitHub's API.
 *
 * `path` is always built by a caller in this file from validated pieces; no
 * caller outside it names a route.
 */
async function request<T>(
  key: string,
  path: string,
  init: { method?: string; body?: unknown },
  fetchImpl: FetchLike,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${API_ROOT}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        // Required — see the note at the top of this file.
        "user-agent": "GoodLooks",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
  } catch (err) {
    // Deliberately does NOT forward `err`, for the reason `linear-provider.ts`
    // gives: a fetch rejection can carry the request URL.
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new IssueProviderError(
      "network",
      aborted
        ? "GitHub did not respond in time. Check your connection and try again."
        : "Could not reach GitHub. Check your connection and try again.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw errorForStatus(res.status, res.headers.get("x-ratelimit-remaining") === "0");
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new IssueProviderError("server", "GitHub returned a response this app could not read.");
  }
}

/** A remote array, rebuilt rather than trusted — anything that is not an object
 *  is dropped rather than carried into the loop that reads its fields. */
function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((n): n is Record<string, unknown> => !!n && typeof n === "object") : [];
}

/** One line, bounded, safe to put in markdown. Same helper and same reasoning as
 *  `linear-provider.ts`. */
function line(v: string): string {
  return v.replace(/\s+/g, " ").trim().slice(0, 80).replace(/[[\]()]/g, "");
}

/**
 * The note that stands in for the images GitHub will not take.
 *
 * Appended to the body rather than reported as an error: the text of a defect is
 * worth filing without its screenshots, and refusing the whole issue over an
 * attachment would make GitHub unusable for exactly the visual-difference case
 * it is most likely to be used for. What it must not do is stay quiet.
 */
function omittedImagesNote(images: UploadImage[]): string {
  if (images.length === 0) return "";
  const names = images.map((i) => `- ${line(i.label)}`).join("\n");
  return [
    "---",
    "",
    `**${images.length} screenshot${images.length === 1 ? "" : "s"} could not be attached.** GitHub's API has no image upload, so the evidence for this defect stayed on the machine that filed it:`,
    "",
    names,
    "",
    "They are in the run's artifacts in Good Looks!, and can be dragged onto this issue by hand.",
  ].join("\n");
}

function withNote(body: string, images: UploadImage[]): string {
  const note = omittedImagesNote(images);
  return note ? `${body}\n\n${note}` : body;
}

/**
 * @param fetchImpl injectable for tests. Omitted, requests go through the global
 * `fetch` — LOOKED UP PER REQUEST, for the reason `createLinearProvider`
 * documents: a default parameter would bind whatever `fetch` was when the
 * registry constructed this at module load.
 */
export function createGithubProvider(fetchImpl?: FetchLike): IssueProvider {
  // appFetch is global fetch until Settings → Proxy covers app traffic, and
  // it resolves globalThis.fetch per call — so the stubbing story above holds.
  const doFetch: FetchLike = (url, init) => (fetchImpl ? fetchImpl(url, init) : appFetch(url, init));

  return {
    id: "github",
    vocabulary: VOCABULARY,

    async verify(key: string): Promise<ProviderAccount> {
      const data = await request<{ login?: unknown; name?: unknown }>(key, "/user", {}, doFetch);
      const accountName = str(data.name) ?? str(data.login) ?? "your GitHub account";
      logger.info("issues", "Verified GitHub token", {});
      // Null rather than invented. A GitHub token is not scoped to one
      // organisation the way a Linear key is scoped to one workspace, so there
      // is no honest single answer and the UI already renders the absence.
      return { accountName, workspaceName: null };
    },

    async listContainers(key: string): Promise<IssueContainer[]> {
      const out: IssueContainer[] = [];
      for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const data = await request<unknown>(
          key,
          `/user/repos?per_page=${PAGE_SIZE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
          {},
          doFetch,
        );
        const batch = rows(data);
        for (const node of batch) {
          const fullName = str(node.full_name);
          const name = str(node.name);
          const owner = str((node.owner as Record<string, unknown> | undefined)?.login);
          // Rebuilt from `full_name` only when it agrees with the parts, so the
          // id this app stores is one `repoPath` will accept later.
          if (!fullName || !name || !owner || fullName !== `${owner}/${name}`) continue;
          // A repository the token cannot write to cannot receive an issue, and
          // one with Issues disabled has nowhere to put it. Offering either
          // produces a failure at send time, after the user has typed a report.
          const permissions = node.permissions as Record<string, unknown> | undefined;
          if (permissions && permissions.push !== true) continue;
          if (node.has_issues === false) continue;
          if (node.archived === true) continue;
          out.push({ id: fullName, name, key: owner });
        }
        if (batch.length < PAGE_SIZE) break;
      }
      return out;
    },

    async listSubContainers(key: string, containerId: string | null): Promise<IssueSubContainer[]> {
      // No repository, no answer. A milestone belongs to one, and there is no
      // cross-repository milestone list to fall back on — see the interface note.
      if (!containerId) return [];
      const { owner, repo } = repoPath(containerId);
      const data = await request<unknown>(
        key,
        `/repos/${owner}/${repo}/milestones?state=open&per_page=${PAGE_SIZE}`,
        {},
        doFetch,
      );
      const out: IssueSubContainer[] = [];
      for (const node of rows(data)) {
        const number = num(node.number);
        const title = str(node.title);
        // Attributed to the repository it was read from rather than reported as
        // unscoped: unlike a Linear project, a GitHub milestone genuinely
        // belongs to exactly one, and claiming otherwise would offer it under
        // repositories that would reject it.
        if (number && title) out.push({ id: String(number), name: title, containerId });
      }
      return out;
    },

    async listLabels(key: string, containerId: string | null): Promise<IssueLabel[]> {
      if (!containerId) return [];
      const { owner, repo } = repoPath(containerId);
      const data = await request<unknown>(
        key,
        `/repos/${owner}/${repo}/labels?per_page=${PAGE_SIZE}`,
        {},
        doFetch,
      );
      const out: IssueLabel[] = [];
      for (const node of rows(data)) {
        const name = str(node.name);
        // The NAME is the id. GitHub's create endpoint takes label names
        // directly, and resolving them to the numeric ids it also mints would
        // be a round trip that buys nothing — see the interface note on
        // `listLabels`.
        if (name) out.push({ id: name, name, color: str(node.color) ? `#${str(node.color)}` : null });
      }
      return out;
    },

    async createIssue(key: string, req: CreateIssueRequest): Promise<CreatedIssue> {
      const { owner, repo } = repoPath(req.containerId);
      const milestone = req.subContainerId ? Number(req.subContainerId) : null;

      const body: Record<string, unknown> = {
        title: req.title,
        body: withNote(req.body, req.images),
      };
      // Rebuilt through `num` rather than passed through: the value round-trips
      // via disk and IPC as a string, and GitHub rejects the whole request if it
      // is not an integer.
      if (milestone !== null && num(milestone)) body.milestone = milestone;
      if (req.labelIds.length) body.labels = req.labelIds;

      const data = await request<{ number?: unknown; html_url?: unknown }>(
        key,
        `/repos/${owner}/${repo}/issues`,
        { method: "POST", body },
        doFetch,
      );

      const number = num(data.number);
      const url = str(data.html_url);
      if (!number || !url) {
        throw new IssueProviderError("server", "GitHub accepted the request but did not return an issue.");
      }

      // The id carries the ROUTE, not just the number: `addComment` is handed
      // only this string later, and `#42` on its own does not say which
      // repository it is the forty-second issue of.
      const identifier = `${owner}/${repo}#${number}`;
      logger.info("issues", "Filed a GitHub issue", { identifier });
      return { id: identifier, identifier, url };
    },

    async addComment(key: string, issueId: string, body: string, images: UploadImage[]): Promise<void> {
      const hash = issueId.lastIndexOf("#");
      const number = hash === -1 ? null : num(Number(issueId.slice(hash + 1)));
      if (hash === -1 || !number) {
        throw new IssueProviderError("unknown", "That issue reference is not one this app can comment on.");
      }
      const { owner, repo } = repoPath(issueId.slice(0, hash));
      await request<unknown>(
        key,
        `/repos/${owner}/${repo}/issues/${number}/comments`,
        { method: "POST", body: { body: withNote(body, images) } },
        doFetch,
      );
    },
  };
}
