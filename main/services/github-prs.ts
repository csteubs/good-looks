// Open pull requests for the repository this app was built from.
//
// ── Egress ────────────────────────────────────────────────────────────────
// This is the app's second outbound host, after the opt-in alert webhook, and
// the first it reaches without being told a URL. What it sends: a GET to
// api.github.com for `origin`'s owner/repo, with the stored token when there is
// one. What it does NOT send: anything about the test library. It runs only
// while the branch-switcher view is open, only in the main process (the
// renderer contacts nobody — see `check:renderer-egress`), and only when the
// running app is a git checkout of a GitHub remote, which is to say never in a
// packaged build. See docs/DECISIONS.md.
//
// ── Why the shape is deliberately thin ────────────────────────────────────
// The API answers with a large object per PR, most of it about people. Only the
// six fields below cross into the app; nothing else is stored, cached to disk,
// or handed to the renderer. `head.ref` in particular is the ONLY field that
// goes on to do anything — it becomes a git argument and a directory name — and
// it is validated before it is offered, not when it is used.

import { logger } from "@shell/backend";

import { branchNameProblem, type RepoRef } from "../../shared/branch-paths.mjs";
import type { PullRequestSummary } from "../../renderer/lib/branch-types.js";
import { githubTokenStore } from "./github-token-store.js";

export type { PullRequestSummary };

const API_ROOT = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PRS = 50;

/** The subset of the API's response this module reads. Everything optional —
 *  a field that stopped being sent must degrade, not throw. */
interface ApiPull {
  number?: number;
  title?: string;
  draft?: boolean;
  updated_at?: string;
  html_url?: string;
  user?: { login?: string } | null;
  head?: { ref?: string; repo?: { full_name?: string } | null } | null;
  base?: { repo?: { full_name?: string } | null } | null;
}

function describeHttpFailure(status: number, hasToken: boolean): string {
  if (status === 404) {
    return hasToken
      ? "GitHub answered 404. The token may not have access to this repository — a fine-grained token needs read access to its pull requests."
      : "GitHub answered 404. If this repository is private, save a token below — GitHub answers 404 rather than 403 for repositories a request can't see.";
  }
  if (status === 401) return "GitHub rejected the saved token (401). Replace it below.";
  if (status === 403) {
    return hasToken
      ? "GitHub answered 403 — the token is valid but not permitted to read this repository's pull requests."
      : "GitHub answered 403, most likely the unauthenticated rate limit (60 requests an hour, shared across this machine). Saving a token raises it.";
  }
  return `GitHub answered ${status}.`;
}

/**
 * Open pull requests, newest-updated first.
 *
 * Throws with a sentence worth showing rather than returning an empty list: an
 * empty list means "no open PRs", and a rate-limited request that reads as that
 * is precisely the silent-wrong-answer failure this codebase keeps getting bitten
 * by.
 */
export async function listOpenPullRequests(repo: RepoRef): Promise<PullRequestSummary[]> {
  const token = await githubTokenStore.getToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub requires a User-Agent and answers 403 without one.
    "User-Agent": "good-looks-branch-switcher",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${API_ROOT}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(
    repo.name,
  )}/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_PRS}`;

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach api.github.com: ${message}`);
  }

  if (!response.ok) throw new Error(describeHttpFailure(response.status, Boolean(token)));

  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("GitHub answered with something that wasn't a list of pull requests.");

  const origin = `${repo.owner}/${repo.name}`.toLowerCase();
  const summaries: PullRequestSummary[] = [];
  for (const raw of body as ApiPull[]) {
    const branch = raw?.head?.ref ?? "";
    // A ref this app would refuse to build is not offered. Dropping it silently
    // would leave a PR missing from the list with no explanation, so it is
    // logged — but it must not reach the UI as a switchable row, because the
    // row's whole purpose is to hand that string to git.
    const problem = branchNameProblem(branch);
    if (problem) {
      logger.warn("branches", "Skipped a pull request whose head ref this app won't build", {
        number: raw?.number,
        problem,
      });
      continue;
    }
    summaries.push({
      number: Number(raw?.number ?? 0),
      title: String(raw?.title ?? "(untitled)"),
      branch,
      author: String(raw?.user?.login ?? "unknown"),
      draft: raw?.draft === true,
      updatedAt: String(raw?.updated_at ?? ""),
      url: String(raw?.html_url ?? ""),
      fork: (raw?.head?.repo?.full_name ?? "").toLowerCase() !== origin,
    });
  }
  logger.info("branches", "Listed open pull requests", { repo: origin, count: summaries.length });
  return summaries;
}
