// The ONE rule for which origin a test's basic-auth credential is scoped to.
//
// Basic auth without an origin scope is a credential leak: Playwright's
// `httpCredentials` with no `origin` answers ANY server's 401 challenge, and
// Electron's `login` event fires for every authenticating request in the page
// — including a third-party subresource or a redirect to another host. Either
// way the user's password would travel to whatever server issued the
// challenge. Scoping both halves to the TEST'S OWN origin is what stops that,
// and both halves must derive that origin identically or the run would send a
// header the trainer withholds (or the reverse) — the same drift argument as
// `shared/testid-attr.mjs`.
//
// Pure: no fs, no IPC, no process, no DOM.

/**
 * The origin (scheme://host[:port]) a credential is scoped to, or null when the
 * test's address is not an absolute URL — in which case there is nothing to
 * scope to and the caller falls back to its unscoped behaviour.
 *
 * @param {string | undefined | null} url
 * @returns {string | null}
 */
export function credentialOrigin(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether the trainer's login handler (or, conceptually, a run) should answer a
 * challenge from `requestUrl` for a test addressed at `testUrl` (falling back
 * to `baseUrl`). This is the SCOPE decision, factored out so it can be tested
 * without Electron: the credential goes only to the test's own origin, so a
 * third-party subresource or a redirect to another host is refused. When the
 * test has no absolute address there is nothing to scope to, and the answer is
 * the unscoped fallback (true) — matching the run half, which emits
 * httpCredentials without an `origin` in that same case.
 *
 * @param {string | undefined | null} testUrl
 * @param {string | undefined | null} baseUrl
 * @param {string | undefined | null} requestUrl
 * @returns {boolean}
 */
export function answersLoginFor(testUrl, baseUrl, requestUrl) {
  const scope = credentialOrigin(testUrl) ?? credentialOrigin(baseUrl);
  if (!scope) return true;
  return credentialOrigin(requestUrl) === scope;
}
