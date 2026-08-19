/** Hand-written types for url-assert.mjs — see CLAUDE.md on why `shared/` is
 *  `.mjs` with a `.d.mts` beside it rather than TypeScript. */

/** The four assert kinds this helper knows how to seed. */
export type UrlAssertKind = "url" | "urlEndsWith" | "urlIs" | "urlPathIs";

/**
 * The value to pre-fill a URL assertion's "Expected" field with.
 *
 * Returns "" when there is nothing useful to suggest (unparseable URL, a
 * non-http scheme, or a kind this helper does not seed), which callers should
 * treat as "leave the field empty" rather than as an error.
 */
export function urlAssertPrefill(kind: string, url: string): string;
