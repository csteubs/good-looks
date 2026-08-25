// Types for locator-engine.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so both the compiled app and the plain-.mjs MCP can embed these strings,
// and this file is what keeps `npm run type-check` a real gate over the
// TypeScript callers (capture-script.ts, step-replayer.ts, auto-heal.ts,
// dismiss-fixture-source.ts).

/** How many elements the uniqueness scan walks before answering "assume
 *  ambiguous". A cap, because this runs on the click path. */
export declare const MAX_UNIQUENESS_SCAN: number;

/** The cap raised out of the way, for the paths that are NOT on the click path
 *  — the replayer, the heal probe, the dismissal watcher. */
export declare const UNCAPPED_SCAN: number;

/** How many shadow roots a scan will open. */
export declare const MAX_SHADOW_ROOTS: number;

/** `ctxFilter(list, ctx)` — narrow a match set by the user's pinned element
 *  context. Source text, for embedding. */
export declare const CONTEXT_HELPERS: string;

/** `matchesFor(loc, root)` — the elements a recorded locator would resolve to,
 *  under Playwright's strict mode. Source text; embeds `CONTEXT_HELPERS` and
 *  the shared testid grammar. */
export declare const UNIQUENESS_HELPERS: string;

/** What an element IS — `roleOf`, `accName`, `txt`, `cssEscape`, the shadow
 *  walk. Source text, and the base every other body here is built on. */
export declare const DOM_HELPERS: string;
