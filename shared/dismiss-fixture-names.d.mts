/** The filename the overlay-dismissal fixture is written under, beside the
 *  specs. Interpolated into the capture fixture's import rather than retyped. */
export declare const DISMISS_FIXTURE_FILE: string;

/** Environment variable carrying how many rules were armed for this run. */
export declare const DISMISS_COUNT_ENV: string;

/** Prefix for the per-rule variables. */
export declare const DISMISS_ENV_PREFIX: string;

/** The env names carrying one rule — one variable per field rather than a JSON
 *  blob, for the reason `variableEnv` gives about secrets. */
export declare function dismissEnvNames(index: number): { label: string; target: string };

/** The environment one run's armed rules travel in, count included. Written by
 *  the app's runner and by the MCP/CLI runner; read back by the fixture inside a
 *  Playwright worker. */
export declare function dismissEnv(
  rules: readonly { label?: string; host?: string; target?: unknown }[],
): Record<string, string>;
