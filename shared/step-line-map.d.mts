// Types for step-line-map.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so the app and the unattended runner read a reporter's line number back
// into a step the same way, and this file is what keeps `npm run type-check` a
// real gate over the TypeScript caller (playwright-runner.ts).

/** Spec line (1-based) → step index, for a spec this process did not generate.
 *  Null when the source has no test body, or no `await` lines inside one. */
export declare function buildStepLineMapFromSource(src: string): Map<number, number> | null;
