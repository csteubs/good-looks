// Types for testid-attr.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so it can be embedded into the heal fixture as source text without a
// build step, and this file is what keeps `npm run type-check` a real gate
// over the TypeScript callers (the generator, the parser, the runner's heal
// key, and the renderer's three locator renderings).

/** A test-id attribute a Locator's `attr` field may name. The default
 *  (data-testid) is never stored — absent means default. */
export type TestIdAttributeOverride = "data-test-id" | "data-test";

export declare const DEFAULT_TESTID_ATTRIBUTE: "data-testid";

export declare const TESTID_ATTRIBUTE_OVERRIDES: readonly TestIdAttributeOverride[];

export declare function testIdOverride(attr: unknown): TestIdAttributeOverride | null;

export declare function testIdSelector(attr: string, value: string): string;

export declare function parseTestIdSelector(
  selector: string,
): { attr: TestIdAttributeOverride; value: string } | null;

export declare function testIdSelectorSource(): string;
