// What the issue-tracker integration sends over IPC.
//
// Declared ONCE here and imported type-only by the main-process side, the way
// `branch-types.ts` is rather than the way `recorder-types.ts` mirrors the
// recorder model. `import type` erases at build time, so no runtime import
// crosses the boundary in either direction.
//
// The backend-only half of the model — the `IssueProvider` interface and the
// `IssueProviderError` class — stays in `main/services/issue-tracker/types.ts`,
// because one is a contract no renderer implements and the other is runtime
// code that would drag a class into the renderer bundle for nothing.
//
// These shapes are deliberately designed against TWO trackers, not one; the
// reasoning for each is in the backend types file, next to the interface that
// forced it.

/** The only implemented provider. */
export type ProviderId = "linear";

/** Who a stored key belongs to. Shown so a user can tell at a glance that they
 *  pasted the key they meant to. */
export interface ProviderAccount {
  accountName: string;
  /** The workspace the key is scoped to. One per key, by decision. */
  workspaceName: string | null;
}

/** A place an issue can be filed: a Linear team, a GitHub repository. */
export interface IssueContainer {
  id: string;
  name: string;
  /** The provider's own short display form ("ENG"), when it has one. */
  key: string | null;
}

/** The optional second level: a Linear project, a GitHub milestone. */
export interface IssueSubContainer {
  id: string;
  name: string;
  /** Null when the provider doesn't scope it to exactly one container. */
  containerId: string | null;
}

/** The words a provider uses for its own concepts, so the UI can label itself
 *  without hardcoding a product's vocabulary. */
export interface ProviderVocabulary {
  name: string;
  container: string;
  subContainer: string;
  keyHelpUrl: string;
  keyPlaceholder: string;
}

/**
 * Everything the renderer is allowed to know about the connection.
 *
 * `hasKey` and `account` are separate claims on purpose: a key is stored, and
 * the key works. Collapsing them means either a working key reads as broken
 * while offline, or a revoked key keeps reporting Connected.
 */
export interface ConnectionStatus {
  provider: ProviderId;
  hasKey: boolean;
  /** Non-null once a verification has succeeded this session. */
  account: ProviderAccount | null;
  /** Why the last verification failed. Never contains the key. */
  error: string | null;
}

/** Where issues go by default. */
export interface IssueDefaults {
  containerId: string | null;
  subContainerId: string | null;
}
