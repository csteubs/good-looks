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

import { testSecretsStore } from "./test-secrets-store.js";

export const REDACTED = "[redacted]";

/**
 * Replace every occurrence of every secret value with a placeholder.
 *
 * Longest-first, which matters: if one secret is a prefix of another
 * ("hunter2" and "hunter2!"), replacing the short one first would leave the
 * tail of the long one ("!") sitting in the output next to a [redacted] label
 * — a partial leak that reads as if it were fully redacted.
 *
 * Values shorter than 4 characters are skipped. A one- or two-character secret
 * would match constantly and turn the log into noise, and a log full of
 * [redacted] is a log nobody reads — which costs more than that secret's
 * exposure in a local file.
 */
export function redact(text: string, secrets: readonly string[]): string {
  if (!text || secrets.length === 0) return text;
  let out = text;
  const ordered = [...new Set(secrets.filter((s) => s.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of ordered) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

// Snapshot of every stored secret value, for the synchronous call sites.
// Empty until refreshed — which is the safe direction to fail only because
// every writer refreshes before it writes; see `refreshSecretSnapshot`.
let snapshot: string[] = [];

/** Reload the snapshot from the encrypted store. Called before a run starts and
 *  after any secret is saved or cleared, so the synchronous redactors always
 *  see the values that the run they're about to record could have exposed. */
export async function refreshSecretSnapshot(): Promise<void> {
  try {
    snapshot = await testSecretsStore.allValues();
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
