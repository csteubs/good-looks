export declare const DEEP_LINK_SCHEME: string;

import type { SiteHealthCategory } from "./site-health.mjs";

export interface DeepLinkTestTarget {
  kind: "test";
  testId: string;
  runId: string | null;
  stepId: string | null;
}

export interface DeepLinkSiteHealthTarget {
  kind: "site-health";
  host: string;
  category: SiteHealthCategory | null;
}

export type DeepLinkTarget = DeepLinkTestTarget | DeepLinkSiteHealthTarget;

/** Parse a `goodlooks://` URL into the view it selects. Null for anything not
 *  understood — there is deliberately no default route. */
export declare function parseDeepLink(url: string | undefined | null): DeepLinkTarget | null;

/** Build the link that goes into an issue. Paired with `parseDeepLink` here so
 *  the two cannot drift into producing links that open nothing. */
export declare function buildDeepLink(target: {
  testId: string;
  runId?: string | null;
  stepId?: string | null;
}): string;

/** The link into a domain's Site Health screen. Paired with `parseDeepLink`
 *  for the same reason `buildDeepLink` is. */
export declare function buildSiteHealthDeepLink(target: {
  host: string;
  category?: SiteHealthCategory | null;
}): string;
