// Types for playwright-config.mjs.
//
// The MCP server is plain ESM JavaScript on purpose — it runs standalone via
// `node mcp/server.mjs`, with no build step and without the app. This
// declaration exists so check:runner-config can import the MCP's copy of the
// generated Playwright config and compare it against the app's with types
// instead of `any`.

/** The exact contents of the generated `playwright.config.ts`. Must equal
 *  PLAYWRIGHT_CONFIG_SOURCE in main/services/playwright-config-source.ts —
 *  both processes write the same path. Pinned by check:runner-config. */
export declare const PLAYWRIGHT_CONFIG_SOURCE: string;
