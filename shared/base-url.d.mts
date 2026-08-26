// Types for base-url.mjs.
//
// Hand-written, like the other `.d.mts` files here: the implementation is plain
// ESM so the CLI and the MCP can import it with no build step, and this file is
// what keeps `npm run type-check` a real gate over the TypeScript callers —
// `imported-config.ts`, which re-exports it, and everything downstream of that.

/** The normalized href, or null when the value is not an http(s) base URL. */
export declare function normalizeBaseUrl(value: unknown): string | null;
