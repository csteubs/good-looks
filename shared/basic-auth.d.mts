// Types for basic-auth.mjs. Hand-written; see the other .d.mts files here.

/** The origin (scheme://host[:port]) a test's basic-auth credential is scoped
 *  to, or null when the test's address is not an absolute URL. */
export declare function credentialOrigin(url: string | undefined | null): string | null;

/** Whether a basic-auth credential for a test addressed at `testUrl` (falling
 *  back to `baseUrl`) may be sent to `requestUrl` — true only for the test's
 *  own origin, or unconditionally when the test has no absolute address. */
export declare function answersLoginFor(
  testUrl: string | undefined | null,
  baseUrl: string | undefined | null,
  requestUrl: string | undefined | null,
): boolean;
