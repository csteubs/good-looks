// Strip secret variable values out of anything that gets persisted or sent.
//
// A secret never reaches the generated spec (the generator emits a
// `process.env.GLAZE_SECRET_<NAME>` reference instead), but it DOES reach the
// running browser — so it can still surface in a Playwright error message, a
// failing assertion's diff, or a page-content dump in the run output. Those
// paths all funnel into three places, and each is closed here:
//
//   • the run log written to disk           (run-history-store.append)
//   • the outgoing webhook payload          (alert-service)
//   • the prompt sent to a hosted LLM       (Debug with AI on the Claude provider)
//
// `redact` is pure so `check:variables` can assert the guarantee directly.
// The snapshot exists because two of those three call sites are synchronous,
// and reading the encrypted store is not.

import { logger } from "@shell/backend";

import { shopifySignatureStore } from "./shopify-signature-store.js";
import { testSecretsStore } from "./test-secrets-store.js";
// The pure half. Shared so the CLI redacts with the SAME rule — R7 requires
// that whatever supplies a secret to a run also feeds the redaction.
// Re-exported, so this module stays the one import site for its callers.
import { MASKED, redact, REDACTED } from "../../shared/secret-redaction.mjs";

export { MASKED, redact, REDACTED };

// Snapshot of every stored secret value, for the synchronous call sites.
// Empty until refreshed — which is the safe direction to fail only because
// every writer refreshes before it writes; see `refreshSecretSnapshot`.
let snapshot: string[] = [];

/**
 * Every value that must not appear in anything persisted or sent.
 *
 * TWO stores, because there are two ways a credential reaches a run's output. A
 * secret variable is typed INTO the page and comes back in an assertion diff or
 * a content dump. A Shopify crawler signature is attached to the request BY
 * THIS APP, and comes back in a recorded request header or a Playwright error.
 * Different paths in, one way out.
 *
 * Exported for the one redaction site that is async and therefore does not read
 * the snapshot — see `alert-service.sendAlert`.
 */
export async function allRedactableValues(): Promise<string[]> {
  const [secrets, signatures] = await Promise.all([
    testSecretsStore.allValues(),
    shopifySignatureStore.headerValuesForRedaction(),
  ]);
  return [...new Set([...secrets, ...signatures])];
}

/** Reload the snapshot from the encrypted stores. Called before a run starts and
 *  after any secret is saved or cleared, so the synchronous redactors always
 *  see the values that the run they're about to record could have exposed. */
export async function refreshSecretSnapshot(): Promise<void> {
  try {
    snapshot = await allRedactableValues();
  } catch (err) {
    logger.warn("secrets", "Could not refresh the redaction snapshot", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Redact using the current snapshot. */
export function redactWithSnapshot(text: string): string {
  return redact(text, snapshot);
}

/** Test seam — sets the snapshot directly, without touching safeStorage. */
export function setSecretSnapshotForTesting(values: string[]): void {
  snapshot = [...values];
}
