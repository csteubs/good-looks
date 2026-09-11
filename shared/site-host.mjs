// WHICH DOMAIN A PAGE BELONGS TO — the Site Health feature's one spelling of
// "domain" (docs/plans/site-health.md §0).
//
// The repo already had four ways of naming a site: origin (shared/origin.mjs,
// the propagation and SITE_URL rule), host with port (the rail's subtitle and
// the Shopify signature key), exact hostname (aiInstructionsByHost) and a
// registrable-host suffix match (overlay rules). None of them is what a person
// means by "how is example.com doing": for that, `www.example.com` and
// `example.com` are one property, `shop.example.com` is a different site, and
// the scheme and port are noise. So this is a FIFTH rule, deliberately, and it
// is written once here because three processes derive it — the fixture inside
// a Playwright worker (interpolated, see SITE_HOST_HELPERS), the app's rollup
// and the MCP's — and a domain spelled two ways is two rows for one site.
//
// Pure: no fs, no shell import, no process.

/** The longest hostname the DNS allows. A stored host longer than this is a
 *  page-authored string, not a domain. */
export const MAX_SITE_HOST = 253;

/**
 * The Site Health host of an absolute http(s) URL, or null.
 *
 * Lowercased hostname with a leading `www.` folded, no port, no scheme.
 *
 * SELF-CONTAINED ON PURPOSE: its source is interpolated into the site-health
 * fixture (`SITE_HOST_HELPERS`), where a closure over a module constant would
 * emit as a dangling reference. The `253` below is MAX_SITE_HOST spelled inline
 * for that reason; `site-host.test.ts` pins the two together.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function siteHostOf(text) {
  if (typeof text !== "string" || !/^https?:\/\//i.test(text)) return null;
  let host = "";
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.length > 4 && host.startsWith("www.")) host = host.slice(4);
  return host && host.length <= 253 ? host : null;
}

/**
 * The path of an absolute http(s) URL — the page's identity within its host.
 *
 * No query string and no fragment: `/products?utm=x` and `/products` are one
 * page, and a query is where a session token would sit. Also self-contained,
 * for the same interpolation reason as `siteHostOf`.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function pagePathOf(text) {
  if (typeof text !== "string" || !/^https?:\/\//i.test(text)) return null;
  try {
    const path = new URL(text).pathname || "/";
    return path.length <= 1024 ? path : null;
  } catch {
    return null;
  }
}

/**
 * Narrow an UNTRUSTED host string to a Site Health host, or null.
 *
 * A host arrives from a deep link in an issue anyone in a tracker can edit,
 * from a route parameter out of history, from an artifact a CI container
 * wrote, and from an MCP client. Each is rebuilt through this one gate: lower
 * case, `www.` folded, DNS-shaped labels or a bracketed IPv6 literal, bounded.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeSiteHost(value) {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  if (host.length > 4 && host.startsWith("www.")) host = host.slice(4);
  if (!host || host.length > MAX_SITE_HOST) return null;
  if (/^\[[0-9a-f:.]+\]$/.test(host)) return host;
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/.test(host)) {
    return null;
  }
  return host;
}

/**
 * A host that is this machine or a private name, where "served over HTTPS" is
 * not a finding: a dev server on localhost is not failing an SEO audit by
 * being on http.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * The two URL rules as source, for the site-health fixture. The fixture is a
 * string Playwright loads inside a worker and cannot import this module, and a
 * hand copy there is the drift this file exists to end.
 */
export const SITE_HOST_HELPERS = `${siteHostOf.toString()}\n${pagePathOf.toString()}`;
