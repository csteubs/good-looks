// Parsing a `goodlooks://` URL. Pure, and the whole validation surface.
//
// A DEEP LINK IS UNTRUSTED INPUT, in exactly the sense a branch name from a
// pull request head ref is. The URL is written into a Linear issue, which
// anyone in the workspace can edit, and clicked by whoever opens that issue —
// so it is a string chosen by someone else that arrives with the authority of
// "the user clicked it".
//
// What that means concretely, and what this file enforces:
//
//   • IT SELECTS A VIEW. That is the entire contract. It never runs a test,
//     never writes, never deletes, and never carries content to display — so
//     the worst a hostile link can do is open a screen.
//   • Ids are bounded and refused if they contain a path separator or a dot
//     segment. They are used to look records up, and a lookup key that can
//     traverse is one refactor away from being a path.
//   • Anything unrecognised is REFUSED, not guessed at. There is no default
//     route: a link that does not parse opens nothing rather than opening the
//     home screen, because silently landing somewhere plausible is how a
//     malformed link gets reported as "the app ignored my click".
//
// In `shared/` because both the Electron shell (which receives the URL) and the
// renderer (which routes it) need the same answer, and they cannot share a
// `.ts` — the shell is compiled, the parse has to be identical, and a
// transcribed copy is right the day it is written and silently divergent after.

/** The scheme this app answers to. */
export const DEEP_LINK_SCHEME = "goodlooks";

/** Long enough for any id this app mints, short enough that a hostile URL
 *  cannot hand an unbounded string to a store lookup. */
const MAX_ID = 200;

/**
 * One path segment, validated as an id.
 *
 * Returns null rather than throwing: every rejection here is an ordinary
 * "this link is not for us", and the caller's job is to do nothing.
 */
function id(raw) {
  if (typeof raw !== "string") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed percent-escape. Refused rather than used raw — the two would
    // disagree about what the id IS, which is the kind of gap that hides a
    // traversal.
    return null;
  }
  const trimmed = decoded.trim();
  if (!trimmed || trimmed.length > MAX_ID) return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (trimmed === "." || trimmed === "..") return null;
  // Control characters, written as ESCAPES rather than literals: a literal
  // control character does not survive being copied through a shell or an
  // editor, and the guard then silently matches nothing.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse a deep link into the view it selects.
 *
 * Returns null for anything not understood. Recognised forms:
 *
 *   goodlooks://test/<testId>
 *   goodlooks://test/<testId>/run/<runId>
 *   goodlooks://test/<testId>/run/<runId>/step/<stepId>
 *
 * @param {string | undefined | null} url
 * @returns {{testId: string, runId: string | null, stepId: string | null} | null}
 */
export function parseDeepLink(url) {
  if (typeof url !== "string" || !url) return null;

  // ── Dot segments, checked on the RAW STRING ───────────────────────────
  //
  // This has to happen BEFORE `new URL()`, and that is not a stylistic
  // preference. The URL parser RESOLVES `..` rather than preserving it:
  //
  //   new URL("goodlooks://test/t-ok/run/..").pathname === "/t-ok/"
  //
  // So a validator that inspects the parsed segments can never see a
  // traversal — by then it has already been APPLIED, silently turning a link
  // to one target into a link to another. The same is true of `%2e%2e`, which
  // the parser decodes and then resolves.
  //
  // Rejecting rather than tolerating the rewrite: a link containing `..` is
  // not a link to the place it collapses to, and quietly honouring it is the
  // "guessing" this whole file refuses to do.
  if (/%2e/i.test(url)) return null;
  for (const segment of url.split(/[/?#]/)) {
    if (segment === "." || segment === "..") return null;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  // `goodlooks://test/x` puts "test" in the HOST and "/x" in the pathname,
  // while `goodlooks:test/x` puts it all in the pathname. Both are things a
  // person can end up pasting, so the segments are recombined rather than
  // relying on one shape — getting this wrong makes half the links silently
  // do nothing.
  const segments = [parsed.host, ...parsed.pathname.split("/")].filter(Boolean);
  if (segments.length < 2) return null;
  if (segments[0] !== "test") return null;

  const testId = id(segments[1]);
  if (!testId) return null;

  let runId = null;
  let stepId = null;

  if (segments.length >= 4 && segments[2] === "run") {
    runId = id(segments[3]);
    if (!runId) return null;
    if (segments.length >= 6 && segments[4] === "step") {
      stepId = id(segments[5]);
      if (!stepId) return null;
      // Anything past the step is a link asking for something this app does
      // not implement. Refused rather than ignored, for the same reason as
      // the branch below.
      if (segments.length > 6) return null;
    } else if (segments.length > 4) {
      // Trailing segments that are not a step. Refused rather than ignored —
      // a link meaning something we do not implement should not silently
      // resolve to a coarser view than it asked for.
      return null;
    }
  } else if (segments.length > 2) {
    return null;
  }

  return { testId, runId, stepId };
}

/**
 * Build the link that goes into an issue.
 *
 * Here rather than in the issue payload so the two halves cannot drift: a
 * builder and a parser that disagree produce links that look right and open
 * nothing.
 *
 * @param {{testId: string, runId?: string | null, stepId?: string | null}} target
 * @returns {string}
 */
export function buildDeepLink(target) {
  const parts = [`${DEEP_LINK_SCHEME}://test/${encodeURIComponent(target.testId)}`];
  if (target.runId) {
    parts.push(`run/${encodeURIComponent(target.runId)}`);
    if (target.stepId) parts.push(`step/${encodeURIComponent(target.stepId)}`);
  }
  return parts.join("/");
}
