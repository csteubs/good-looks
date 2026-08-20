// Types for testid-attr.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so it can be embedded into the heal fixture as source text without a
// build step, and this file is what keeps `npm run type-check` a real gate
// over the TypeScript callers (the generator, the parser, the runner's heal
// key, and the renderer's three locator renderings).

/** A test-id attribute a Locator's `attr` field may name — any grammar-valid
 *  lowercase data-* attribute except the default (data-testid), which is
 *  never stored: absent means default. Widened from the fixed pair when the
 *  attribute list became configurable. */
export type TestIdAttributeOverride = string;

export declare const DEFAULT_TESTID_ATTRIBUTE: "data-testid";

/** The always-probed extras (data-test-id, data-test) — user-configured
 *  attributes extend the probe list at capture time. */
export declare const TESTID_ATTRIBUTE_OVERRIDES: readonly string[];

export declare function isTestIdAttributeName(v: unknown): v is string;

export declare function normalizeTestIdAttributes(input: unknown): string[];

export declare function testIdOverride(attr: unknown): string | null;

export declare function testIdSelector(attr: string, value: string): string;

export declare function parseTestIdSelector(
  selector: string,
): { attr: string; value: string } | null;

export declare function testIdSelectorSource(): string;
