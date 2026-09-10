// Where Site Health lives in the router, spelled once.
//
// Three screens on one view: the board at `/site-health`, one domain at
// `/site-health/<host>`, and one domain's SEO or Performance tab at
// `/site-health/<host>/<category>`. The same three files that have to agree
// about Settings have to agree here — `AppStrip` builds the trail from the
// pathname, the rail marks its row selected from it, and the deep link
// `goodlooks://site-health/<host>/<category>` lands on it — so the parse is
// written once, the way `settings-route.ts` is.
//
// The parse answers with RAW SEGMENTS, decoded, and no opinion about whether
// the host is a host: that is `normalizeSiteHost`'s job at the handler, where
// a value that came in through a deep link is refused rather than queried.

import { isSiteHealthCategory, type SiteHealthCategory } from "../../shared/site-health.mjs";

/** The board. */
export const SITE_HEALTH_PATH = "/site-health";

/** `/site-health`, `/site-health/<host>`, `/site-health/<host>/<category>` —
 *  and nothing else. Anchored at both ends so `/site-healthy` is not it. */
const SITE_HEALTH_RE = /^\/site-health(?:\/([^/]+))?(?:\/([^/]+))?\/?$/;

export interface SiteHealthLocation {
  /** The host segment, decoded, or undefined on the board. */
  host?: string;
  /** The category segment when it names one; an unknown segment reads as
   *  absent, which is the board's default tab. */
  category?: SiteHealthCategory;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The Site Health screen this pathname names, or null when it names none. */
export function parseSiteHealthPath(pathname: string): SiteHealthLocation | null {
  const m = SITE_HEALTH_RE.exec(pathname);
  if (!m) return null;
  const out: SiteHealthLocation = {};
  if (m[1] !== undefined) out.host = decode(m[1]);
  if (m[2] !== undefined) {
    const category = decode(m[2]);
    if (isSiteHealthCategory(category)) out.category = category;
  }
  return out;
}

/** Are we in Site Health? The ONE spelling, for the rail and the trail. */
export function isSiteHealthPath(pathname: string): boolean {
  return parseSiteHealthPath(pathname) !== null;
}

/** The pathname for a domain (and tab), host percent-encoded the way the
 *  router expects a param — an IPv6 literal carries brackets and colons. */
export function siteHealthPath(host?: string, category?: SiteHealthCategory): string {
  if (!host) return SITE_HEALTH_PATH;
  const base = `${SITE_HEALTH_PATH}/${encodeURIComponent(host)}`;
  return category ? `${base}/${category}` : base;
}
