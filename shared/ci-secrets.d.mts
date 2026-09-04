import type { TestRecord } from "../main/recorder/types.js";

/** Prefix for the per-test, per-name variables a CI operator sets. */
export declare const CI_SECRET_PREFIX: string;

/** How the GENERATED SPEC references a secret — one spelling, because the
 *  generator emits it and the resolver resolves it. */
export declare function specSecretEnvName(name: string): string;

/** The variable a CI operator sets for one test's one secret. Carries the test
 *  id, because two tests can each declare `PASSWORD` and mean different
 *  credentials — and handing one test's staging password to another test's
 *  production login fails with no error at all. */
export declare function ciSecretEnvName(testId: string, name: string): string;

export interface ResolvedCiSecrets {
  /** What the child process gets. */
  env: Record<string, string>;
  /** What must be redacted out of everything the run produces. Returned
   *  separately rather than derived from `env`, so one place knows that a
   *  supplied secret is also a redacted one. */
  values: string[];
  /** Declared names with no value here — refuse by name rather than run. */
  missing: string[];
}

export declare function resolveCiSecrets(
  test: Pick<TestRecord, "id" | "name" | "variables">,
  options?: { env?: Record<string, string | undefined>; fileValues?: Record<string, string> },
): ResolvedCiSecrets;

/** Credentials handed to this process by the ENVIRONMENT rather than declared
 *  as a test's secret variable, and therefore invisible to `resolveCiSecrets`.
 *  Today that is the test-mailbox bearer token, which the `emailCode` step
 *  reads straight from `GLAZE_MAILBOX_TOKEN`. To redact, never to inject — the
 *  endpoint is deliberately excluded, since it is not a credential and a run
 *  that cannot name the host it polled is one nobody can debug. */
export declare function ambientCiSecretValues(
  env?: Record<string, string | undefined>,
): string[];

/** The sentence a refusal prints — names the variables to set, because the
 *  operator's next question is always "what do I call them". */
export declare function describeMissingSecrets(
  test: Pick<TestRecord, "id" | "name">,
  missing: readonly string[],
): string;
