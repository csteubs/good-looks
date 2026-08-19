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

import { redact } from "../secret-redaction.js";
import { testSecretsStore } from "../test-secrets-store.js";
import { defectLoader } from "./defect-loader.js";
import { issueConfigStore } from "./issue-config-store.js";
import { issueLinkStore, type IssueLink } from "./issue-link-store.js";
import { keyStoreFor, PROVIDER_IDS, providerFor } from "./provider-registry.js";
import {
  IssueProviderError,
  type ConnectionStatus,
  type CreatedIssue,
  type DefectSource,
  type IssueContainer,
  type IssueDestination,
  type IssueDraft,
  type IssueLabel,
  type IssueDefaults,
  type IssueSubContainer,
  type ProviderAccount,
  type ProviderChoice,
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
    return issueConfigStore.activeProvider();
  },

  /**
   * Change which tracker issues are filed into.
   *
   * Nothing is migrated and nothing is cleared. Each provider keeps its own key,
   * its own defaults and its own issue links, so switching is reversible and
   * switching back finds everything where it was — which is the whole reason the
   * stores were keyed by provider before there was a second one.
   */
  setActiveProvider(provider: ProviderId): ProviderId {
    return issueConfigStore.setActiveProvider(provider);
  },

  /**
   * Every provider, for the settings picker.
   *
   * The vocabulary travels with each row so the pane can render the whole
   * choice without a call per option — and, more to the point, without a table
   * of product names in the renderer. `hasKey` is the local, cheap claim only;
   * verifying every provider to build a menu would put two network calls behind
   * opening a settings pane.
   */
  async providers(): Promise<ProviderChoice[]> {
    return Promise.all(
      PROVIDER_IDS.map(async (id) => ({
        id,
        vocabulary: providerFor(id).vocabulary,
        hasKey: await keyStoreFor(id).has().catch(() => false),
      })),
    );
  },

  vocabulary(provider: ProviderId = issueConfigStore.activeProvider()): ProviderVocabulary {
    return providerFor(provider).vocabulary;
  },

  /** Local only — never a network call. See the note at the top. */
  async status(provider: ProviderId = issueConfigStore.activeProvider()): Promise<ConnectionStatus> {
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
  async connect(plain: string, provider: ProviderId = issueConfigStore.activeProvider()): Promise<ConnectionStatus> {
    await keyStoreFor(provider).set(plain);
    return this.verify(provider);
  },

  /** Ask the provider who this key belongs to, and record the answer. */
  async verify(provider: ProviderId = issueConfigStore.activeProvider()): Promise<ConnectionStatus> {
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
  async disconnect(provider: ProviderId = issueConfigStore.activeProvider()): Promise<ConnectionStatus> {
    await keyStoreFor(provider).clear();
    verified.delete(provider);
    lastError.delete(provider);
    issueConfigStore.clear(provider);
    logger.info("issues", "Disconnected issue tracker", { provider });
    return this.status(provider);
  },

  async listContainers(provider: ProviderId = issueConfigStore.activeProvider()): Promise<IssueContainer[]> {
    return providerFor(provider).listContainers(await requireKey(provider));
  },

  /** `containerId` narrows the list where the provider scopes it. Passing null
   *  is legitimate — Linear answers workspace-wide regardless — but it is what
   *  GitHub has no answer to, so the pickers pass whatever container is
   *  currently selected rather than omitting it. */
  async listSubContainers(
    containerId: string | null,
    provider: ProviderId = issueConfigStore.activeProvider(),
  ): Promise<IssueSubContainer[]> {
    return providerFor(provider).listSubContainers(await requireKey(provider), containerId);
  },

  defaults(provider: ProviderId = issueConfigStore.activeProvider()): IssueDefaults {
    return issueConfigStore.get(provider);
  },

  /**
   * Update the defaults.
   *
   * Changing the container clears the sub-container unless one is named in the
   * same patch: a project belongs to a team, and a team change that left the
   * project in place would leave a pair that looks configured and is not.
   */
  setDefaults(patch: Partial<IssueDefaults>, provider: ProviderId = issueConfigStore.activeProvider()): IssueDefaults {
    const containerChanged =
      patch.containerId !== undefined &&
      patch.containerId !== issueConfigStore.get(provider).containerId;
    const effective: Partial<IssueDefaults> =
      containerChanged && patch.subContainerId === undefined
        ? { ...patch, subContainerId: null }
        : patch;
    return issueConfigStore.set(provider, effective);
  },

  /** Scoped the same way as `listSubContainers`. */
  async listLabels(
    containerId: string | null,
    provider: ProviderId = issueConfigStore.activeProvider(),
  ): Promise<IssueLabel[]> {
    return providerFor(provider).listLabels(await requireKey(provider), containerId);
  },

  /** The pre-filled issue for one defect, assembled from disk. Null when the
   *  coordinate no longer resolves — a pruned run, a re-recorded step. */
  buildDraft(source: DefectSource): IssueDraft | null {
    return defectLoader.build(source);
  },

  /**
   * Rebuild a defect coordinate arriving over IPC.
   *
   * Every field here becomes part of a filesystem path, so this is the same
   * class of boundary as `normalizeRawStep` and follows the same rule: it
   * REBUILDS rather than filters, so an unknown key cannot ride along into the
   * next thing that spreads it. Ids are bounded and refused outright if they
   * contain a path separator or a dot segment — `artifactStore` builds its
   * paths by joining these, and "it's our own renderer" is exactly the
   * assumption that makes a traversal bug survive review.
   */
  normalizeSource(raw: unknown): DefectSource | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const id = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const t = v.trim();
      if (!t || t.length > 200) return null;
      if (t.includes("/") || t.includes("\\") || t === "." || t === "..") return null;
      return t;
    };
    // The report source carries no test/run coordinate — its whole address is
    // the report id, resolved against the insights store by the loader.
    if (r.kind === "insight-report") {
      const reportId = id(r.reportId);
      return reportId ? { kind: "insight-report", reportId } : null;
    }

    const testId = id(r.testId);
    const runId = id(r.runId);
    if (!testId || !runId) return null;

    if (r.kind === "a11y") {
      const stepId = id(r.stepId);
      const ruleId = id(r.ruleId);
      return stepId && ruleId ? { kind: "a11y", testId, runId, stepId, ruleId } : null;
    }
    if (r.kind === "visual") {
      const stepId = id(r.stepId);
      return stepId ? { kind: "visual", testId, runId, stepId } : null;
    }
    if (r.kind === "failure") {
      // The only nullable one: a run can fail without a step being blamed.
      return { kind: "failure", testId, runId, stepId: id(r.stepId) };
    }
    return null;
  },

  /**
   * File one issue.
   *
   * The images are re-read from disk HERE, by the same coordinate the draft
   * named — the renderer sends back filenames, never bytes. So what is uploaded
   * is what the app read, and the confirmation strip the user approved was a
   * view of the same files rather than a promise about them.
   *
   * Text is redacted immediately before the send, the way `sendAlert` does it:
   * at the last point every path funnels through, rather than anywhere a later
   * refactor could route around. It matters even though the user typed some of
   * this — a step label recorded before variables existed has its typed value
   * baked in, and that label is in the draft they accepted without reading.
   */
  async createIssue(
    draft: { source: DefectSource; title: string; body: string; attachmentFiles: string[] },
    destination: IssueDestination,
    provider: ProviderId = issueConfigStore.activeProvider(),
  ): Promise<CreatedIssue> {
    const key = await requireKey(provider);
    const secrets = await testSecretsStore.allValues().catch(() => [] as string[]);
    const images = defectLoader.readImages(draft.source, draft.attachmentFiles);
    const created = await providerFor(provider).createIssue(key, {
      title: redact(draft.title, secrets),
      body: redact(draft.body, secrets),
      containerId: destination.containerId,
      subContainerId: destination.subContainerId,
      labelIds: destination.labelIds,
      images,
    });
    // Recorded AFTER the provider confirms, never before: a link written
    // optimistically would badge the defect "filed as ENG-42" for an issue that
    // does not exist, and the user's next move would be to click a dead link.
    issueLinkStore.save(provider, draft.source, created);
    logger.info("issues", "Filed an issue", { provider, identifier: created.identifier });
    return created;
  },

  /** The issue already filed for this defect, if any. */
  linkFor(source: DefectSource, provider: ProviderId = issueConfigStore.activeProvider()): IssueLink | null {
    return issueLinkStore.find(provider, source);
  },

  /** Every link on a test, so a list badges itself in one read. */
  linksForTest(testId: string): IssueLink[] {
    return issueLinkStore.forTest(testId);
  },

  /**
   * Report a recurrence onto the issue that already exists.
   *
   * The alternative — filing again — produces one issue per run for a defect
   * that recurs every run, which is how this feature would become the thing
   * everyone mutes. A comment keeps the history on one work item.
   *
   * The body is rebuilt from THIS run rather than reusing the original: the
   * point of the comment is that it carries the latest evidence, and the
   * screenshots go with it for the same reason.
   */
  async commentRecurrence(
    source: DefectSource,
    attachmentFiles: string[],
    provider: ProviderId = issueConfigStore.activeProvider(),
  ): Promise<IssueLink> {
    const link = issueLinkStore.find(provider, source);
    if (!link) throw new IssueProviderError("unknown", "This defect has no issue to comment on.");
    const draft = defectLoader.build(source);
    if (!draft) throw new IssueProviderError("unknown", "This defect's evidence is no longer on disk.");

    const key = await requireKey(provider);
    const secrets = await testSecretsStore.allValues().catch(() => [] as string[]);
    await providerFor(provider).addComment(
      key,
      link.issueId,
      redact(`**Seen again.**\n\n${draft.body}`, secrets),
      defectLoader.readImages(source, attachmentFiles),
    );
    issueLinkStore.touch(provider, source);
    logger.info("issues", "Reported a recurrence", { provider, identifier: link.identifier });
    return { ...link, lastCommentedAt: Date.now() };
  },

  /** Test seam: drop the in-process verification cache. */
  resetForTests(): void {
    verified.clear();
    lastError.clear();
  },
};
