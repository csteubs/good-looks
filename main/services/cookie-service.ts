// Live cookie management for the training browser.
//
// Goes through the Glaze session cookie API (`webContents.session.cookies`)
// rather than injecting `document.cookie` into the page. That matters: an
// httpOnly cookie — which is exactly the kind you want to paste in to skip a
// login while recording — is invisible to page JavaScript by definition, and
// document.cookie also can't set the Domain/Secure/SameSite attributes
// faithfully. The same reason means cookie STEPS can't be replayed through the
// injected-script path either; see applyCookieStep, which the recorder's replay
// paths call directly.
//
// The URL derivation below is the fiddly part: `cookies.set`/`cookies.remove`
// both require a URL, but the app stores cookies the way Chromium reports them
// (domain + path), so a URL has to be reconstructed.

import { logger } from "@shell/backend";
import type { Cookie, CookiesSetDetails } from "@shell/backend";

import type { CookieSpec, Step } from "../recorder/types.js";

/** Minimal shape of the webContents we need, so this is unit-testable. */
export interface CookieHost {
  session: {
    cookies: {
      get(filter: { url?: string; name?: string }): Promise<Cookie[]>;
      set(details: CookiesSetDetails): Promise<void>;
      remove(url: string, name: string): Promise<void>;
    };
  };
}

/**
 * Reconstruct the URL a cookie belongs to.
 *
 * Chromium reports a domain cookie with a LEADING DOT (".example.com") meaning
 * "this host and subdomains". That dot is not part of a hostname, so it has to
 * be stripped or the resulting URL is invalid and `cookies.set` silently
 * targets nothing. `secure` decides the scheme, since a Secure cookie can't be
 * set over http.
 *
 * Returns null when there isn't enough to build one — the caller then falls
 * back to the page's current URL.
 */
export function cookieUrlFor(spec: Pick<CookieSpec, "domain" | "path" | "secure" | "url">): string | null {
  if (spec.url) return spec.url;
  if (!spec.domain) return null;
  const host = spec.domain.replace(/^\./, "");
  if (!host) return null;
  const scheme = spec.secure ? "https" : "http";
  const path = spec.path && spec.path.startsWith("/") ? spec.path : "/";
  return `${scheme}://${host}${path}`;
}

/**
 * Turn a stored CookieSpec into the details `cookies.set` expects.
 *
 * `fallbackUrl` (the training page's current URL) is used when the spec has no
 * url and no domain — the common case when a user types just a name and value
 * into the panel and means "on this site".
 */
export function specToSetDetails(
  spec: CookieSpec,
  fallbackUrl: string,
): CookiesSetDetails | null {
  const url = cookieUrlFor(spec) ?? fallbackUrl;
  if (!url || !spec.name) return null;
  return {
    url,
    name: spec.name,
    value: spec.value ?? "",
    ...(spec.domain ? { domain: spec.domain } : {}),
    ...(spec.path ? { path: spec.path } : {}),
    ...(spec.secure !== undefined ? { secure: spec.secure } : {}),
    ...(spec.httpOnly !== undefined ? { httpOnly: spec.httpOnly } : {}),
    ...(spec.sameSite ? { sameSite: spec.sameSite } : {}),
    ...(typeof spec.expirationDate === "number"
      ? { expirationDate: spec.expirationDate }
      : {}),
  };
}

/** Chromium's Cookie → the app's CookieSpec (plus the read-only extras the
 *  panel shows). Keeps the renderer working in one vocabulary. */
export function cookieToSpec(c: Cookie): CookieSpec & { hostOnly?: boolean; session?: boolean } {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    ...(typeof c.expirationDate === "number" ? { expirationDate: c.expirationDate } : {}),
    hostOnly: c.hostOnly,
    session: c.session,
  };
}

/** Cookies visible to the given URL (what the page itself would send), newest
 *  API semantics: an empty filter returns the whole store, which is noise in
 *  the panel — so a URL is always passed. */
export async function listCookies(
  wc: CookieHost,
  url: string,
): Promise<(CookieSpec & { hostOnly?: boolean; session?: boolean })[]> {
  const cookies = await wc.session.cookies.get({ url });
  return cookies.map(cookieToSpec).sort((a, b) => a.name.localeCompare(b.name));
}

export async function setCookie(wc: CookieHost, spec: CookieSpec, fallbackUrl: string): Promise<void> {
  const details = specToSetDetails(spec, fallbackUrl);
  if (!details) throw new Error("A cookie needs at least a name, and a site to belong to.");
  await wc.session.cookies.set(details);
}

export async function deleteCookie(
  wc: CookieHost,
  spec: CookieSpec,
  fallbackUrl: string,
): Promise<void> {
  const url = cookieUrlFor(spec) ?? fallbackUrl;
  if (!url || !spec.name) throw new Error("Need a cookie name to delete.");
  await wc.session.cookies.remove(url, spec.name);
}

/** Remove every cookie visible to `url`. Mirrors Playwright's
 *  `context.clearCookies()` as closely as the session API allows: each cookie
 *  is removed by its OWN reconstructed URL, not the page URL, so domain
 *  cookies and host cookies are both actually removed rather than silently
 *  surviving. */
export async function clearCookies(wc: CookieHost, url: string): Promise<number> {
  const cookies = await wc.session.cookies.get({ url });
  let removed = 0;
  for (const c of cookies) {
    const target = cookieUrlFor({ domain: c.domain, path: c.path, secure: c.secure }) ?? url;
    try {
      await wc.session.cookies.remove(target, c.name);
      removed++;
    } catch (err) {
      // One stubborn cookie shouldn't abort clearing the rest.
      logger.warn("cookies", "Failed to remove cookie", { name: c.name, err: String(err) });
    }
  }
  return removed;
}

/**
 * Apply a `cookie` step during trainer replay.
 *
 * Separate from the injected-script replayer on purpose (see the file header).
 * Returns the same `{ok, error?, logs}` shape the injected replayer returns so
 * the replay paths can treat it uniformly.
 */
export async function applyCookieStep(
  wc: CookieHost,
  step: Step,
  pageUrl: string,
): Promise<{ ok: boolean; error?: string; logs: { i: number; t: number; level: "info" | "warn" | "error"; m: string }[] }> {
  const logs: { i: number; t: number; level: "info" | "warn" | "error"; m: string }[] = [];
  const log = (level: "info" | "warn" | "error", m: string) =>
    logs.push({ i: logs.length, t: Date.now(), level, m });

  try {
    switch (step.cookieAction) {
      case "clearAll": {
        const removed = await clearCookies(wc, pageUrl);
        log("info", `Cleared ${removed} cookie${removed === 1 ? "" : "s"} for ${pageUrl}`);
        return { ok: true, logs };
      }
      case "delete": {
        if (!step.cookie?.name) {
          log("error", "Delete step has no cookie name.");
          return { ok: false, error: "Delete step has no cookie name.", logs };
        }
        await deleteCookie(wc, step.cookie, pageUrl);
        log("info", `Deleted cookie ${step.cookie.name}`);
        return { ok: true, logs };
      }
      case "set":
      default: {
        if (!step.cookie?.name) {
          log("error", "Cookie step has no name.");
          return { ok: false, error: "Cookie step has no name.", logs };
        }
        const details = specToSetDetails(step.cookie, pageUrl);
        if (!details) {
          const msg = "Cookie step has no site to apply to.";
          log("error", msg);
          return { ok: false, error: msg, logs };
        }
        log("info", `Setting cookie ${details.name} on ${details.url}`);
        await setCookie(wc, step.cookie, pageUrl);
        log("info", "Cookie set.");
        return { ok: true, logs };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", msg);
    return { ok: false, error: msg, logs };
  }
}
