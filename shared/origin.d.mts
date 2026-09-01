// Types for origin.mjs. Hand-written beside the implementation, like every
// shared/ module, so `npm run type-check` stays a real gate over the
// TypeScript callers.

/** The origin of a URL (`https://host[:port]`), or null for anything that is
 *  not an absolute http(s) address. Case and default port normalised. */
export declare function originOf(text: string): string | null;

/** Whether `text` is a URL sitting on `origin` — startsWith plus a boundary
 *  check, so a host that merely shares a prefix does not match. */
export declare function isOnOrigin(text: string, origin: string): boolean;
