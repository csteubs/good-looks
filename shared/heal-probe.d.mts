// Types for heal-probe.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so both the compiled app and the plain-.mjs MCP can build a probe, and
// this file is what keeps `npm run type-check` a real gate over the TypeScript
// callers (auto-heal.ts and the heal-map builder).

/**
 * The injected probe for one step: walks the page, ranks candidate locators for
 * the element the step meant, and returns the best few.
 *
 * `pastHints` is a compact summary of what this step's locator resolved to in
 * past runs, used to boost candidates matching a previously-successful target.
 * An unattended run has no debug history to draw them from and passes `[]`,
 * which is the same probe with one scoring input absent.
 */
export declare function buildHealProbeScript(step: unknown, pastHints: string[]): string;
