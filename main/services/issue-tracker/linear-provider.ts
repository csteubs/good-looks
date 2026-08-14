// Linear, behind the provider-neutral interface.
//
// Three constraints shape everything here:
//
//   • NO ERROR MAY CARRY THE KEY. A raw fetch rejection can carry the request
//     URL, and a URL is one refactor away from a query string; a raw response
//     body is written by a remote server. So every throw is an
//     `IssueProviderError` built from a status code and, at most, a truncated
//     GraphQL message — never an object this module was handed.
//   • The key is a PARAMETER, not state. It is decrypted by the caller
//     immediately before use and never stored here, so a long-lived provider
//     instance holds nothing worth stealing.
//   • THE UPLOAD PUT CARRIES NO AUTHORIZATION HEADER. It is the one request in
//     this file whose destination is not the hardcoded endpoint — Linear names
//     a storage host — and the signed URL is itself the credential for it.
//     Attaching the API key would hand it to a third party.
//
// Linear's personal API keys go in `Authorization` RAW — no `Bearer` prefix,
// which OAuth tokens do use. Getting that wrong produces a 400 with an
// authentication message, which reads as "your key is bad" and sends people off
// to regenerate a perfectly good key.

import { logger } from "@shell/backend";

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

const ENDPOINT = "https://api.linear.app/graphql";

/** A settings pane the user is sitting in front of. Long enough to survive a
 *  slow network, short enough that "Test connection" cannot appear to hang. */
const TIMEOUT_MS = 15_000;

/** Linear pages at 250. Both lists are workspace-scoped and a workspace with
 *  more than 250 teams is not a case worth paging for before anyone has one. */
const PAGE_SIZE = 250;

/** Remote text is displayed, so it is bounded here rather than trusted. */
const MAX_MESSAGE_LEN = 300;

/** An image PUT to a storage host, which is slower than a GraphQL round trip
 *  and is the one request here whose size the user controls. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** Injectable for tests. The real one is the global. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message?: unknown; extensions?: { code?: unknown } }[];
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_LEN ? `${text.slice(0, MAX_MESSAGE_LEN)}…` : text;
}

/** A remote-authored string, made safe to display: collapsed to one line and
 *  bounded. Newlines matter because a multi-line message in a toast pushes the
 *  rest of the interface around. */
function displayable(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const flat = v.replace(/\s+/g, " ").trim();
  return flat ? truncate(flat) : null;
}

/**
 * Remove the credential from a string that is about to be displayed.
 *
 * Guards the one path where remote-authored text reaches a user. Short keys are
 * skipped for the same reason `secret-redaction.ts` skips them: a two-character
 * needle matches constantly and turns the message into noise, which costs more
 * than it protects.
 */
function scrubKey(text: string | null, key: string): string | null {
  if (!text || key.length < 8) return text;
  return text.split(key).join("[redacted]");
}

/** Map a transport status onto the kinds a caller branches on. */
function errorForStatus(status: number): IssueProviderError {
  if (status === 401 || status === 403) {
    return new IssueProviderError(
      "auth",
      "Linear rejected the API key. Check that it was copied whole and has not been revoked.",
    );
  }
  if (status === 429) {
    return new IssueProviderError("rate-limit", "Linear is rate-limiting this key. Try again shortly.");
  }
  if (status >= 500) {
    return new IssueProviderError("server", `Linear returned a server error (${status}).`);
  }
  return new IssueProviderError("unknown", `Linear returned an unexpected response (${status}).`);
}

/**
 * Linear reports authentication failures as a 200 with an `errors` array, not
 * only as a 401 — so a status-code check alone would report a bad key as a
 * parse failure. The extension code is the reliable signal; the message text is
 * a fallback for the cases that omit it.
 */
function errorForGraphQL(
  errors: NonNullable<GraphQLResponse<unknown>["errors"]>,
  key: string,
): IssueProviderError {
  const first = errors[0] ?? {};
  const code = typeof first.extensions?.code === "string" ? first.extensions.code : "";
  // Scrubbed before it can be displayed. The key travels in a header and never
  // in the body, so Linear has nothing to echo — but this message is the ONE
  // piece of remote-authored text this module shows verbatim, and the promise
  // at the top of the file is only true if something enforces it. One line here
  // is cheaper than depending on that reasoning staying correct.
  const message = scrubKey(displayable(first.message), key);
  const looksAuth =
    code === "AUTHENTICATION_ERROR" ||
    code === "FORBIDDEN" ||
    /authentica|unauthor|invalid api key/i.test(message ?? "");
  if (looksAuth) {
    return new IssueProviderError(
      "auth",
      "Linear rejected the API key. Check that it was copied whole and has not been revoked.",
    );
  }
  return new IssueProviderError("unknown", message ?? "Linear rejected the request.");
}

async function query<T>(key: string, doc: string, fetchImpl: FetchLike): Promise<T> {
  return request<T>(key, { query: doc }, fetchImpl);
}

/** The one place a request reaches Linear's API. Both `query` and `mutate` go
 *  through it, so the header contract and the error mapping have one home. */
async function request<T>(
  key: string,
  payload: Record<string, unknown>,
  fetchImpl: FetchLike,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        // Raw, not `Bearer` — see the header note at the top of this file.
        authorization: key,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // Deliberately does NOT forward `err`. An abort and a DNS failure are the
    // same story to a user, and the alternative is interpolating an object this
    // module was handed into a string it will display.
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new IssueProviderError(
      "network",
      aborted
        ? "Linear did not respond in time. Check your connection and try again."
        : "Could not reach Linear. Check your connection and try again.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw errorForStatus(res.status);

  let body: GraphQLResponse<T>;
  try {
    body = (await res.json()) as GraphQLResponse<T>;
  } catch {
    throw new IssueProviderError("server", "Linear returned a response this app could not read.");
  }

  if (body.errors && body.errors.length > 0) throw errorForGraphQL(body.errors, key);
  if (!body.data) throw new IssueProviderError("server", "Linear returned an empty response.");
  return body.data;
}

/** A query carrying variables. Split from `query` only because a mutation is
 *  worth being able to find by name when reading this file. */
async function mutate<T>(
  key: string,
  doc: string,
  variables: Record<string, unknown>,
  fetchImpl: FetchLike,
): Promise<T> {
  return request<T>(key, { query: doc, variables }, fetchImpl);
}

/**
 * Upload every image and return the markdown that references them.
 *
 * Linear's upload is two steps: ask for a signed URL, then PUT the bytes at it.
 * The PUT goes to whatever host Linear names, which is the one request in this
 * file whose destination is not the hardcoded endpoint — so it carries NO
 * Authorization header. The signed URL is the credential for that request, and
 * attaching the API key would send it to a third-party storage host.
 *
 * A failed upload throws rather than filing an issue without its evidence: a
 * visual-difference issue whose images silently did not arrive is worse than no
 * issue, because it looks complete.
 */
async function uploadAll(
  key: string,
  images: UploadImage[],
  fetchImpl: FetchLike,
): Promise<string> {
  if (images.length === 0) return "";
  const parts: string[] = [];
  for (const image of images) {
    const data = await mutate<{
      fileUpload?: { success?: unknown; uploadFile?: { uploadUrl?: unknown; assetUrl?: unknown; headers?: unknown } };
    }>(
      key,
      `mutation Upload($contentType: String!, $filename: String!, $size: Int!) {
         fileUpload(contentType: $contentType, filename: $filename, size: $size) {
           success
           uploadFile {
             uploadUrl
             assetUrl
             headers { key value }
           }
         }
       }`,
      { contentType: image.contentType, filename: image.filename, size: image.bytes.byteLength },
      fetchImpl,
    );

    const file = data.fileUpload?.uploadFile;
    const uploadUrl = str(file?.uploadUrl);
    const assetUrl = str(file?.assetUrl);
    if (!data.fileUpload?.success || !uploadUrl || !assetUrl) {
      throw new IssueProviderError("server", "Linear would not accept an image upload.");
    }

    // Headers Linear tells us the storage host requires. Rebuilt from the
    // response rather than spread, and the key is deliberately not among them.
    const headers: Record<string, string> = { "content-type": image.contentType };
    for (const h of Array.isArray(file?.headers) ? (file?.headers as unknown[]) : []) {
      if (!h || typeof h !== "object") continue;
      const name = str((h as Record<string, unknown>).key);
      const value = str((h as Record<string, unknown>).value);
      if (name && value) headers[name] = value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetchImpl(uploadUrl, {
        method: "PUT",
        headers,
        body: new Uint8Array(image.bytes),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new IssueProviderError("server", `Uploading an image failed (${res.status}).`);
      }
    } catch (err) {
      if (err instanceof IssueProviderError) throw err;
      throw new IssueProviderError("network", "Could not upload an image. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
    }

    parts.push(`**${line(image.label)}**\n\n![${line(image.label)}](${assetUrl})`);
  }
  return parts.join("\n\n");
}

/** One line, bounded, safe to put in markdown. Labels are ours, but this is the
 *  boundary and a label that grew a newline would break the block around it. */
function line(v: string): string {
  return v.replace(/\s+/g, " ").trim().slice(0, 80).replace(/[[\]()]/g, "");
}

/** A remote list, rebuilt rather than trusted: anything without a usable id and
 *  name is dropped, because a nameless row in a picker is unselectable and an
 *  id-less one would be sent back as `undefined`. */
function nodesOf(v: unknown): Record<string, unknown>[] {
  if (!v || typeof v !== "object") return [];
  const nodes = (v as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.filter((n): n is Record<string, unknown> => !!n && typeof n === "object") : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const VOCABULARY: ProviderVocabulary = {
  name: "Linear",
  container: "Team",
  containerPlural: "Teams",
  subContainer: "Project",
  keyHelpUrl: "https://linear.app/settings/api",
  keyPlaceholder: "lin_api_…",
  supportsImageUpload: true,
};

/**
 * @param fetchImpl injectable for tests. Omitted, requests go through the
 * global `fetch` — LOOKED UP PER REQUEST, not captured here. A default
 * parameter would bind whatever `fetch` was when the registry constructed this
 * provider at module load, which makes it unstubbable from any test that
 * imports the registry and quietly pins the binding for the process.
 */
export function createLinearProvider(fetchImpl?: FetchLike): IssueProvider {
  const doFetch: FetchLike = (url, init) =>
    fetchImpl ? fetchImpl(url, init) : fetch(url, init);
  return {
    id: "linear",
    vocabulary: VOCABULARY,

    async verify(key: string): Promise<ProviderAccount> {
      const data = await query<{
        viewer?: { name?: unknown; displayName?: unknown };
        organization?: { name?: unknown };
      }>(key, `query { viewer { name displayName } organization { name } }`, doFetch);

      const accountName =
        str(data.viewer?.name) ?? str(data.viewer?.displayName) ?? "your Linear account";
      const workspaceName = str(data.organization?.name);
      logger.info("issues", "Verified Linear key", { hasWorkspace: !!workspaceName });
      return { accountName, workspaceName };
    },

    async listContainers(key: string): Promise<IssueContainer[]> {
      const data = await query<{ teams?: unknown }>(
        key,
        `query { teams(first: ${PAGE_SIZE}) { nodes { id name key } } }`,
        doFetch,
      );
      const out: IssueContainer[] = [];
      for (const node of nodesOf(data.teams)) {
        const id = str(node.id);
        const name = str(node.name);
        if (id && name) out.push({ id, name, key: str(node.key) });
      }
      return out;
    },

    /** `containerId` is ignored: Linear's labels are workspace-wide, so
     *  narrowing to a team would hide labels that are legitimately available.
     *  See the interface note on why the parameter exists at all. */
    async listLabels(key: string, _containerId: string | null): Promise<IssueLabel[]> {
      const data = await query<{ issueLabels?: unknown }>(
        key,
        `query { issueLabels(first: ${PAGE_SIZE}) { nodes { id name color } } }`,
        doFetch,
      );
      const out: IssueLabel[] = [];
      for (const node of nodesOf(data.issueLabels)) {
        const id = str(node.id);
        const name = str(node.name);
        if (id && name) out.push({ id, name, color: str(node.color) });
      }
      return out;
    },

    async createIssue(key: string, request: CreateIssueRequest): Promise<CreatedIssue> {
      // Images first, so their markdown can be part of the body the issue is
      // created with. Creating and then editing would leave a visible flicker
      // in Linear's activity feed, and a failed second call would leave an
      // issue whose evidence never arrived.
      const markdown = await uploadAll(key, request.images, doFetch);
      const body = markdown ? `${request.body}\n\n${markdown}` : request.body;

      const input: Record<string, unknown> = {
        title: request.title,
        description: body,
        teamId: request.containerId,
      };
      if (request.subContainerId) input.projectId = request.subContainerId;
      if (request.labelIds.length) input.labelIds = request.labelIds;

      const data = await mutate<{
        issueCreate?: { success?: unknown; issue?: { id?: unknown; identifier?: unknown; url?: unknown } };
      }>(
        key,
        `mutation Create($input: IssueCreateInput!) {
           issueCreate(input: $input) {
             success
             issue { id identifier url }
           }
         }`,
        { input },
        doFetch,
      );

      const issue = data.issueCreate?.issue;
      const id = str(issue?.id);
      const identifier = str(issue?.identifier);
      const url = str(issue?.url);
      if (!data.issueCreate?.success || !id || !identifier || !url) {
        // A mutation that reports failure without an `errors` array. Rare, but
        // returning a half-built object here would give the UI an issue link
        // that goes nowhere.
        throw new IssueProviderError("server", "Linear accepted the request but did not return an issue.");
      }
      logger.info("issues", "Filed a Linear issue", { identifier });
      return { id, identifier, url };
    },

    async addComment(
      key: string,
      issueId: string,
      body: string,
      images: UploadImage[],
    ): Promise<void> {
      const markdown = await uploadAll(key, images, doFetch);
      const data = await mutate<{ commentCreate?: { success?: unknown } }>(
        key,
        `mutation Comment($input: CommentCreateInput!) {
           commentCreate(input: $input) { success }
         }`,
        { input: { issueId, body: markdown ? `${body}\n\n${markdown}` : body } },
        doFetch,
      );
      if (!data.commentCreate?.success) {
        throw new IssueProviderError("server", "Linear did not accept the comment.");
      }
    },

    /** `containerId` is ignored: Linear answers workspace-wide and attributes
     *  each project to a team below, which the caller filters on. Narrowing the
     *  query would drop the cross-team projects that report null. */
    async listSubContainers(key: string, _containerId: string | null): Promise<IssueSubContainer[]> {
      const data = await query<{ projects?: unknown }>(
        key,
        `query { projects(first: ${PAGE_SIZE}) { nodes { id name teams { nodes { id } } } } }`,
        doFetch,
      );
      const out: IssueSubContainer[] = [];
      for (const node of nodesOf(data.projects)) {
        const id = str(node.id);
        const name = str(node.name);
        if (!id || !name) continue;
        // A Linear project can span teams. Only a project belonging to exactly
        // one is attributed — anything else reports null, meaning "offer it
        // everywhere", which is the honest answer and the safe default.
        const teamIds = nodesOf(node.teams)
          .map((t) => str(t.id))
          .filter((t): t is string => !!t);
        out.push({ id, name, containerId: teamIds.length === 1 ? teamIds[0] : null });
      }
      return out;
    },
  };
}
