// What the IPC handlers call: store a key, prove it works, and report where
// issues could go.
//
// The one judgement encoded here is that "a key is saved" and "the key works"
// are DIFFERENT CLAIMS and the UI has to be able to make both. A pane that
// collapses them either lies while offline (a working key reads as broken) or
// lies about a revoked key (still shows Connected because the file is still
// there). So `status()` answers the cheap, local question and never touches the
// network, and `verify()` is the explicit, awaited one.
//
// The verified account is cached IN PROCESS and never persisted: it is a claim
// about right now, and a claim about right now read off disk at launch is how
// a revoked key keeps saying Connected.

import { logger } from "@shell/backend";

import { issueConfigStore } from "./issue-config-store.js";
import { ACTIVE_PROVIDER, keyStoreFor, providerFor } from "./provider-registry.js";
import {
  IssueProviderError,
  type ConnectionStatus,
  type IssueContainer,
  type IssueDefaults,
  type IssueSubContainer,
  type ProviderAccount,
  type ProviderId,
  type ProviderVocabulary,
} from "./types.js";

/** Last successful verification, per provider, for this process only. */
const verified = new Map<ProviderId, ProviderAccount>();
/** Last failure message, per provider. Cleared on success. */
const lastError = new Map<ProviderId, string>();

/**
 * Turn anything thrown into a message safe to display.
 *
 * An `IssueProviderError` was built to be shown. Anything else escaped the
 * provider unexpectedly, and its message is NOT shown — an unexpected throw is
 * exactly the case where the string could have come from somewhere that saw the
 * request. It is logged (without the key, which never enters a log line) and
 * reported generically.
 */
function displayError(err: unknown, provider: ProviderId): string {
  if (err instanceof IssueProviderError) return err.message;
  logger.warn("issues", "Unexpected issue-tracker failure", {
    provider,
    message: err instanceof Error ? err.message : String(err),
  });
  return "Something went wrong talking to the issue tracker.";
}

/** Decrypt the key for one call, or throw the same error a rejected key gives —
 *  from the UI's point of view "no key" and "bad key" both mean "fix the key". */
async function requireKey(provider: ProviderId): Promise<string> {
  const key = await keyStoreFor(provider).get();
  if (!key) throw new IssueProviderError("auth", "No API key is saved for this provider yet.");
  return key;
}

export const issueTrackerService = {
  /** The provider in use. Exposed so the renderer can label its own UI without
   *  hardcoding a product name. */
  activeProvider(): ProviderId {
    return ACTIVE_PROVIDER;
  },

  vocabulary(provider: ProviderId = ACTIVE_PROVIDER): ProviderVocabulary {
    return providerFor(provider).vocabulary;
  },

  /** Local only — never a network call. See the note at the top. */
  async status(provider: ProviderId = ACTIVE_PROVIDER): Promise<ConnectionStatus> {
    const hasKey = await keyStoreFor(provider).has().catch(() => false);
    return {
      provider,
      hasKey,
      account: hasKey ? (verified.get(provider) ?? null) : null,
      error: hasKey ? (lastError.get(provider) ?? null) : null,
    };
  },

  /**
   * Save a key and immediately prove it.
   *
   * Saved first, then verified, and a failed verification does NOT roll the
   * save back. Someone pasting a good key on a bad connection should not have
   * to paste it again — the status carries the failure, and the key is there to
   * retry with. The opposite order (verify, then save) fails the same person by
   * refusing work that is only temporarily impossible.
   */
  async connect(plain: string, provider: ProviderId = ACTIVE_PROVIDER): Promise<ConnectionStatus> {
    await keyStoreFor(provider).set(plain);
    return this.verify(provider);
  },

  /** Ask the provider who this key belongs to, and record the answer. */
  async verify(provider: ProviderId = ACTIVE_PROVIDER): Promise<ConnectionStatus> {
    try {
      const account = await providerFor(provider).verify(await requireKey(provider));
      verified.set(provider, account);
      lastError.delete(provider);
    } catch (err) {
      verified.delete(provider);
      lastError.set(provider, displayError(err, provider));
    }
    return this.status(provider);
  },

  /**
   * Remove the key, the cached verification, and the defaults.
   *
   * The defaults go too, deliberately: a team id is only meaningful inside the
   * workspace the removed key opened. Keeping it would mean a different key
   * pasted later silently inherits a default pointing at a team in someone
   * else's workspace — which fails by filing an issue somewhere unintended
   * rather than by erroring.
   */
  async disconnect(provider: ProviderId = ACTIVE_PROVIDER): Promise<ConnectionStatus> {
    await keyStoreFor(provider).clear();
    verified.delete(provider);
    lastError.delete(provider);
    issueConfigStore.clear(provider);
    logger.info("issues", "Disconnected issue tracker", { provider });
    return this.status(provider);
  },

  async listContainers(provider: ProviderId = ACTIVE_PROVIDER): Promise<IssueContainer[]> {
    return providerFor(provider).listContainers(await requireKey(provider));
  },

  async listSubContainers(provider: ProviderId = ACTIVE_PROVIDER): Promise<IssueSubContainer[]> {
    return providerFor(provider).listSubContainers(await requireKey(provider));
  },

  defaults(provider: ProviderId = ACTIVE_PROVIDER): IssueDefaults {
    return issueConfigStore.get(provider);
  },

  /**
   * Update the defaults.
   *
   * Changing the container clears the sub-container unless one is named in the
   * same patch: a project belongs to a team, and a team change that left the
   * project in place would leave a pair that looks configured and is not.
   */
  setDefaults(patch: Partial<IssueDefaults>, provider: ProviderId = ACTIVE_PROVIDER): IssueDefaults {
    const containerChanged =
      patch.containerId !== undefined &&
      patch.containerId !== issueConfigStore.get(provider).containerId;
    const effective: Partial<IssueDefaults> =
      containerChanged && patch.subContainerId === undefined
        ? { ...patch, subContainerId: null }
        : patch;
    return issueConfigStore.set(provider, effective);
  },

  /** Test seam: drop the in-process verification cache. */
  resetForTests(): void {
    verified.clear();
    lastError.clear();
  },
};
