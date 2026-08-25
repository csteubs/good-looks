// Types for dismiss-fixture-source.mjs.
//
// Hand-written, like the other .d.mts files here. The four names it re-exports
// come from dismiss-fixture-names.mjs and are declared there; this file
// declares them again because a caller importing them from HERE — which the
// module deliberately allows, so it stays the one import site — needs types for
// them too.

/** `glaze-dismiss.mjs`. Not a capability from the loader's point of view: the
 *  capture fixture imports it unconditionally, so it is a dependency. */
export declare const DISMISS_FIXTURE_FILE: string;

/** How many rules this run was given. */
export declare const DISMISS_COUNT_ENV: string;

/** Prefix for the per-rule variables. */
export declare const DISMISS_ENV_PREFIX: string;

/** The two variable names carrying rule `index`. */
export declare function dismissEnvNames(index: number): { label: string; target: string };

/** The environment one run's armed rules travel in, count included. */
export declare function dismissEnv(
  rules: readonly { label?: string; host?: string; target?: unknown }[],
): Record<string, string>;

/** The fixture, as source text written beside the specs. */
export declare const dismissFixtureSource: string;
