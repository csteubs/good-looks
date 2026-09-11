// Types for site-host.mjs. Hand-written beside the implementation, like every
// shared/ module, so `npm run type-check` stays a real gate over the TypeScript
// callers (the runner, the handlers, the renderer, the issue tracker).

/** The longest hostname the DNS allows. */
export declare const MAX_SITE_HOST: number;

/** The Site Health host of an absolute http(s) URL — lowercased hostname with a
 *  leading `www.` folded, no port — or null for anything else. */
export declare function siteHostOf(text: unknown): string | null;

/** The path of an absolute http(s) URL, without query or fragment, or null. */
export declare function pagePathOf(text: unknown): string | null;

/** Narrow an untrusted host string (deep link, route param, artifact, MCP
 *  argument) to a Site Health host, or null. */
export declare function normalizeSiteHost(value: unknown): string | null;

/** localhost, 127.x, ::1, `.local` and `.localhost` names. */
export declare function isLoopbackHost(host: string): boolean;

/** `siteHostOf` and `pagePathOf` as source, for interpolation into the
 *  site-health fixture. */
export declare const SITE_HOST_HELPERS: string;
