// WHERE a run came from — the commit, the branch, the repository and the job.
//
// ── Why this file exists ───────────────────────────────────────────────────
// `RunRecord` says what a run did and, since R33, who started it. It cannot say
// WHAT WAS UNDER TEST. On a laptop that is tolerable, because the answer is "the
// checkout on this machine, in whatever state it was in". On a runner it is the
// whole question: a suite that goes red on one pipeline run and green on the
// next has told you nothing until you can say the two ran different commits.
//
// Like `trigger`, THE FIELD CANNOT BE BACKFILLED. The environment that would
// have answered it is gone with the container, so every run recorded before this
// exists is unattributable forever — which is the argument for adding it ahead
// of the surfaces that will read it (docs/plans/test-runner-improvements.md, R6),
// and the reason R12's ingest is blocked on it: ingesting foreign runs into the
// local library before the library can say they are foreign writes rows nothing
// can ever classify.
//
// It lives in shared/ for the reason every module here does — there are already
// two writers in two processes and a third coming. Pure: `URL` is a global, and
// the environment is handed IN rather than read from `process`.
//
// ── Every field is UNTRUSTED TEXT ──────────────────────────────────────────
// Not a formality. `GITHUB_HEAD_REF` on a pull request from a fork is the name
// the contributor chose, and a fork's branch name is exactly as attacker-chosen
// as the branch switcher's head ref (see shared/branch-paths.mjs, which guards
// the same input for a different use). Here the values are stored and rendered
// rather than executed, so the exposures are different ones:
//
//   - LENGTH. run-history.json is read whole on every run; a megabyte "branch
//     name" is a store that degrades every future write.
//   - CONTROL CHARACTERS. These land in a JSON store, in log lines and in a
//     report; a newline inside a "revision" is a fabricated second line.
//   - URL SCHEME. `repositoryUrl` and `jobUrl` exist to be followed. A
//     `javascript:` or `file:` value is a link the app should never render.
//
// ── Reject, never truncate ─────────────────────────────────────────────────
// The load-bearing rule, and it is not the obvious one. Capping a too-long
// value by cutting it produces A SHORTER VALUE OF THE RIGHT SHAPE: a truncated
// commit sha is still a plausible commit sha, naming a different commit or none
// at all, and whatever reads this next will compare it against real ones. A
// field that is absent says "unknown", which is true. A field that is truncated
// says something false in a format nothing can detect. So an over-long field is
// DROPPED — and dropping one never drops the others, because a hostile branch
// name must not cost the run its revision.

import { normalizeBaseUrl } from "./base-url.mjs";

/**
 * The most a plain-text provenance field may be, in characters.
 *
 * A full commit sha is 40 and a git ref is bounded only by the filesystem, so
 * this admits every real branch name and refuses a payload. Exported because
 * the tests assert the boundary rather than restating the number.
 */
export const PROVENANCE_MAX_TEXT = 200;

/**
 * The most a provenance URL may be. Well above any real job URL — GitHub's run
 * far under 200 characters — and far below a size that would matter to the
 * store.
 */
export const PROVENANCE_MAX_URL = 2048;

/** Control characters, which no legitimate ref, sha or URL contains.
 *
 * `no-control-regex` is disabled here rather than worked around: matching a
 * control character IS the intent, and every alternative spelling (a character
 * class built at runtime, a codePointAt loop) hides the rule from a reader
 * without changing what it does. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The first value that is a non-empty string, or undefined.
 *
 * `??` WOULD BE WRONG HERE, and the reason is a real GitHub Actions behaviour
 * rather than a hypothetical: `GITHUB_HEAD_REF` is DEFINED AND EMPTY on a push
 * run, not absent. `a ?? b` only skips null and undefined, so it would choose
 * the empty string and every push build would record no branch at all — while
 * pull-request builds, the ones a developer tests this on, worked perfectly.
 *
 * @param {...unknown} values
 * @returns {string | undefined}
 */
function first(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * One plain-text field, or undefined.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Length is measured AFTER trimming, so trailing whitespace an environment
  // added cannot cost a legitimate value its place.
  if (trimmed.length > PROVENANCE_MAX_TEXT) return undefined;
  if (CONTROL_CHARS.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * One URL field, or undefined.
 *
 * Through `normalizeBaseUrl` deliberately: "is this an http(s) URL this
 * application will accept" is a question already answered once in this
 * directory, and the direction a second copy fails is this one accepting what
 * the other refuses. The length check is here rather than there because the cap
 * is this store's concern and not that gate's.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function url(value) {
  if (typeof value !== "string") return undefined;
  if (value.length > PROVENANCE_MAX_URL) return undefined;
  return normalizeBaseUrl(value) ?? undefined;
}

/**
 * Narrow an unknown value to the provenance this application will store.
 *
 * THE ONE GATE. Both ways in go through it — `readRunProvenance` hands its
 * assembled candidate here rather than trusting what it just built, and the run
 * history store calls it on write — so a value that reached the store can only
 * be one this function returned.
 *
 * Field by field, because the fields fail independently: a run whose branch name
 * is hostile still has a real revision, and dropping the record's whole
 * provenance would be this guard costing the user the evidence it exists to
 * protect.
 *
 * Returns `undefined` rather than `{}` when nothing survives, so "no provenance"
 * has one spelling and no caller can write an empty object that renders as a
 * provenance the run does not have.
 *
 * @param {unknown} value
 * @returns {{revision?: string, branch?: string, repositoryUrl?: string, jobUrl?: string} | undefined}
 */
export function normalizeRunProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = /** @type {Record<string, unknown>} */ (value);
  /** @type {{revision?: string, branch?: string, repositoryUrl?: string, jobUrl?: string}} */
  const out = {};
  const revision = text(raw.revision);
  if (revision) out.revision = revision;
  const branch = text(raw.branch);
  if (branch) out.branch = branch;
  const repositoryUrl = url(raw.repositoryUrl);
  if (repositoryUrl) out.repositoryUrl = repositoryUrl;
  const jobUrl = url(raw.jobUrl);
  if (jobUrl) out.jobUrl = jobUrl;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read provenance out of an environment, or `undefined` when it says nothing.
 *
 * ── Two sources, per field ─────────────────────────────────────────────────
 * `GOOD_LOOKS_*` is the explicit answer and wins — the same precedence `--var`
 * has over a dataset row and `--speed` over a test's pin: explicit beats
 * derived. It applies per FIELD rather than all-or-nothing, so a pipeline whose
 * branch GitHub reports uselessly can correct that one value without having to
 * restate the other three.
 *
 * GitHub Actions is the derived source, because it is the runner this product
 * ships an action for. Any other CI sets the four `GOOD_LOOKS_*` variables;
 * that is the documented contract rather than a gap, and it is why this reads
 * one generic set of names instead of growing a table of every provider's
 * spelling — a table whose wrong rows would be silent everywhere but the one
 * provider its author used.
 *
 * ── Why `GITHUB_HEAD_REF` is preferred ─────────────────────────────────────
 * On a pull request `GITHUB_REF_NAME` is `42/merge` — the synthetic merge ref,
 * which names no branch anyone can check out. `GITHUB_HEAD_REF` is the branch
 * the pull request came FROM, which is the honest answer and, on a fork, the
 * attacker-chosen one. Preferring it is what makes the normalizer above load
 * bearing rather than decorative.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{revision?: string, branch?: string, repositoryUrl?: string, jobUrl?: string} | undefined}
 */
export function readRunProvenance(env) {
  const e = env ?? {};
  const repository = first(e.GITHUB_REPOSITORY)?.trim();
  const server = first(e.GITHUB_SERVER_URL)?.trim();
  const runId = first(e.GITHUB_RUN_ID)?.trim();

  // Built as a plain string and validated below like anything else. `encodeURI`
  // is deliberately NOT used: a repository or run id carrying something that
  // needs escaping is not a value to repair into a working URL, it is one the
  // gate should drop.
  const repositoryUrl = server && repository ? `${server}/${repository}` : undefined;
  const jobUrl = repositoryUrl && runId ? `${repositoryUrl}/actions/runs/${runId}` : undefined;

  return normalizeRunProvenance({
    revision: first(e.GOOD_LOOKS_REVISION, e.GITHUB_SHA),
    branch: first(e.GOOD_LOOKS_BRANCH, e.GITHUB_HEAD_REF, e.GITHUB_REF_NAME),
    repositoryUrl: first(e.GOOD_LOOKS_REPOSITORY_URL, repositoryUrl),
    jobUrl: first(e.GOOD_LOOKS_JOB_URL, jobUrl),
  });
}
