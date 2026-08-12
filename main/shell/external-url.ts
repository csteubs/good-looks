// Which URLs this app will hand to the operating system.
//
// `shell.openExternal` is not "open a web page". It is "ask macOS to do
// whatever it does with this string", and the answer depends on the scheme:
// `file:///…` opens a Finder window or a document, and any scheme another
// installed app has registered with Launch Services (`ms-msdt:`, `zoommtg:`, an
// updater's private one) gets launched with a payload this app chose. Nothing
// upstream of the OS asks whether that was a good idea.
//
// The one place the app needs the capability is the pull-request icon in the
// branch menu, and the URL it passes came off the network — `html_url` out of a
// GitHub API response, parsed from JSON this process did not write. That is the
// same shape as every other untrusted-input boundary in this codebase, so the
// seam is an ALLOWLIST rather than a blocklist: https, on github.com, nothing
// else. Widening it is a decision someone has to make here, in one place, with
// this comment in front of them.
//
// The four traps that make a naive host check wrong — all of them rejected
// below, all of them pinned by `check:open-external`:
//
//   • `https://github.com.evil.com` — `startsWith` matches; the host is
//     evil.com and github.com is a label in someone else's domain.
//   • `https://evilgithub.com`      — `endsWith("github.com")` matches.
//   • `https://github.com@evil.com` — userinfo. The HOST is evil.com, while a
//     human reading left-to-right sees github.com and stops.
//   • `http://github.com`           — a cleartext request an on-path attacker
//     rewrites. There is no reason to accept it, so it isn't accepted.
//
// Returns the REASON rather than a boolean, matching `branchNameProblem`: the
// caller logs it, and a refusal nobody can explain is a bug report with no
// information in it.
//
// AND IT RETURNS THE URL IT APPROVED, which is the part that is easy to leave
// out. Validating a parsed URL and then opening the caller's original string
// means the thing checked and the thing opened are two different values that
// merely usually agree — the WHATWG parser strips leading whitespace, resolves
// dot segments and percent-normalises, so `"  https://github.com/…"` passes a
// host test on a string nobody examined. Handing back `parsed.href` makes the
// approved URL the only one there is to open.

/** Hosts the app will open. `github.com` itself, plus its subdomains — all of
 *  which GitHub operates. Note this is NOT `github.io`, which is user content. */
const ALLOWED_HOST = "github.com";

/** Long enough for any real pull-request URL, short enough that a megabyte of
 *  string never reaches the URL parser or the log. */
const MAX_URL_LENGTH = 2048;

export type ExternalUrlVerdict =
  /** `href` is what to open — the parser's normalisation of the input, never
   *  the input itself. */
  | { ok: true; href: string }
  | { ok: false; problem: string };

export function checkExternalUrl(url: unknown): ExternalUrlVerdict {
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, problem: "The URL is empty." };
  }
  if (url.length > MAX_URL_LENGTH) {
    return { ok: false, problem: `The URL is longer than ${MAX_URL_LENGTH} characters.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, problem: "That is not a URL this app can parse." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, problem: `Only https: URLs are opened externally, not ${parsed.protocol}` };
  }
  // Before the host test, because a URL with credentials in it is a phishing
  // shape whether or not the host passes — and there is no legitimate reason
  // for one to reach this app.
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, problem: "A URL carrying credentials is not opened externally." };
  }
  // `hostname` is already lowercased and has the userinfo and port removed by
  // the parser, which is the whole reason to go through `URL` rather than match
  // on the string. Exact, or a label boundary — never a bare suffix test.
  const host = parsed.hostname;
  if (host !== ALLOWED_HOST && !host.endsWith(`.${ALLOWED_HOST}`)) {
    return { ok: false, problem: `Only ${ALLOWED_HOST} URLs are opened externally, not ${host}` };
  }

  return { ok: true, href: parsed.href };
}

/** The reason a URL was refused, or `null` when it wasn't. For callers that
 *  only need to report — the handler uses `checkExternalUrl`, because it needs
 *  the approved href rather than the one it was handed. */
export function externalUrlProblem(url: unknown): string | null {
  const verdict = checkExternalUrl(url);
  return verdict.ok ? null : verdict.problem;
}
