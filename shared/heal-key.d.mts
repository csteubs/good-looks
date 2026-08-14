// Types for heal-key.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so it can be embedded into the heal fixture as source text without a
// build step, and this file is what keeps `npm run type-check` a real gate over
// the TypeScript caller (`healKeyFor` in playwright-runner.ts).

export declare function healKeyWithin(containerKey: string, targetKey: string): string;

export declare function healKeyHasText(containerKey: string, text: string): string;

export declare function healKeyAnd(baseKey: string, predicateKey: string): string;

export declare function healKeyOperatorSource(): string;
