// Types for site-health-fixture-source.mjs. The fixture itself is a string;
// what TypeScript callers import are its filename, its caps and its source.

export declare const SITE_HEALTH_FIXTURE_FILE: string;
export declare const SITE_HEALTH_SETTLE_MS: number;
export declare const SITE_HEALTH_READ_TIMEOUT_MS: number;
export declare const SITE_HEALTH_RESPONSE_CAP: number;
export declare const SITE_HEALTH_CAPS: {
  title: number;
  nodes: number;
  canonical: number;
  robots: number;
  hreflang: number;
  types: number;
  href: number;
  lang: number;
  resources: number;
  generic: readonly string[];
};
/** The init script and the reader as source, for the dom test. */
export declare const SITE_HEALTH_PAGE_SOURCE: string;
/** The fixture module as source, written beside the specs. */
export declare const siteHealthFixtureSource: string;
