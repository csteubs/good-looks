// Types for heal-map.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so the app and the plain-.mjs MCP build the same map, and this file is
// what keeps `npm run type-check` a real gate over the TypeScript caller
// (playwright-runner.ts).

/**
 * Canonical locator key → the step it belongs to, plus a pre-built probe. The
 * heal fixture rethrows untouched for a key it cannot find, so this IS the
 * feature: without it healing is off however loudly the environment says
 * otherwise.
 *
 * `describeStep` supplies the human phrase in a heal artifact. Omitted, entries
 * carry an empty label and the fixture falls back to the step id — which is what
 * an unattended run does, because `describeStep` is still app-side.
 *
 * `seedsByKey` is cross-test propagation's half: pending proposals' locators
 * per key, tried by the fixture BEFORE the probe when the key actually fails.
 * Capped at MAX_MAP_SEEDS per key on the way in.
 */
export declare const MAX_MAP_SEEDS: number;

export declare function buildHealMap(
  steps: readonly unknown[],
  options?: {
    describeStep?: (step: never) => string;
    seedsByKey?: Record<string, readonly object[]>;
  },
): Record<string, unknown>;
